const prisma = require("../../config/prisma");
// Phase 7 — the analysis trigger persists the AiJob + JobCandidateAnalysis pair
// atomically, so this repository composes the ONE AiJob writer instead of
// creating AiJob rows itself. aiJob.repository only depends on job.validation
// (zod), so there is no require cycle.
const {
  AI_JOB_OPERATION,
  AI_JOB_STATUS,
  createAiJob,
} = require("../ai-job/aiJob.repository");

// ---------------------------------------------------------------------------
// Phase 7 (Step 2) — JobCandidateReference persistence (job-scoped candidate
// reference data + the resume association).
//
// Every read/write is keyed by (jobId, referenceId): the repository never
// accepts a bare reference id, so a reference can never be resolved outside the
// job the caller was authorized against. `storagePath` is selected ONLY by the
// dedicated resume-view lookup — list/edit projections stay client-safe.
// ---------------------------------------------------------------------------

const REFERENCE_SELECT = {
  id: true,
  jobId: true,
  candidateEmail: true,
  candidateName: true,
  linkedinUrl: true,
  linkedinText: true,
  githubUrl: true,
  githubText: true,
  preferredRole: true,
  skills: true,
  skillNotes: true,
  resumeFileId: true,
  resumeText: true,
  createdAt: true,
  updatedAt: true,
};

const RESUME_FILE_SELECT = {
  id: true,
  originalName: true,
  mimeType: true,
  fileSize: true,
  category: true,
  createdAt: true,
};

const findReferencesByJobId = async (jobId) =>
  prisma.jobCandidateReference.findMany({
    where: { jobId },
    // Insertion order = the order the seeding read the sheet. References keep
    // their identity across list replacements, so this order stays stable.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { ...REFERENCE_SELECT, resume: { select: RESUME_FILE_SELECT } },
  });

const findReferenceByIdInJob = async (jobId, referenceId) =>
  prisma.jobCandidateReference.findFirst({
    where: { id: referenceId, jobId },
    select: { ...REFERENCE_SELECT, resume: { select: RESUME_FILE_SELECT } },
  });

// Resume-view lookup: the ONLY projection that carries storagePath, and only
// after the service has authorized the caller against the job AND resolved the
// reference inside that job.
const findReferenceWithResumeFile = async (jobId, referenceId) =>
  prisma.jobCandidateReference.findFirst({
    where: { id: referenceId, jobId },
    select: {
      id: true,
      jobId: true,
      resumeFileId: true,
      resume: { select: { ...RESUME_FILE_SELECT, storagePath: true } },
    },
  });

// Candidate-facing email normalization: every stored/queried candidate email in
// this flow is trimmed + lowercased first (same semantics as the job service's
// invitations and the candidate-list parser's duplicate check).
const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

// Repository-layer failure that needs an HTTP status (same local helper pattern
// as job.repository.js — no shared ApiError class exists in this codebase).
const failure = (status, message) => Object.assign(new Error(message), { status });

// Single source of truth for the seed row shape, shared by the two seeding
// entry points (candidate-list import/replace inside the association
// transaction, and the upgrade-safe backfill on the reference read path). Rows
// with an unusable email are dropped here, and ONLY the whitelisted reference
// fields are ever mapped — a spreadsheet column outside the whitelist can never
// become candidate data.
const buildReferenceSeedData = ({ jobId, createdByUserId, rows }) => {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => ({
      jobId,
      candidateEmail: normalizeEmail(row.email),
      candidateName: row.name ?? null,
      linkedinUrl: row.linkedinUrl ?? null,
      linkedinText: row.linkedinText ?? null,
      githubUrl: row.githubUrl ?? null,
      githubText: row.githubText ?? null,
      preferredRole: row.preferredRole ?? null,
      skills: row.skills ?? null,
      skillNotes: row.skillNotes ?? null,
      createdByUserId,
    }))
    .filter((row) => row.candidateEmail);
};

// Seed-if-absent. Deterministic and transaction-safe:
//   * the job row is locked FOR UPDATE first (house pattern from
//     seedClarificationQuestions), so two concurrent first reads/imports cannot
//     interleave their existence checks;
//   * createMany + skipDuplicates leans on @@unique([jobId, candidateEmail]),
//     so a row that ALREADY exists is never touched — recruiter edits can never
//     be reset by an import or a replacement spreadsheet;
//   * the whole insert is one statement inside one transaction.
const seedCandidateReferences = async ({ jobId, createdByUserId, rows }) => {
  const data = buildReferenceSeedData({ jobId, createdByUserId, rows });
  if (data.length === 0) {
    return { created: 0 };
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} FOR UPDATE`;
    const result = await tx.jobCandidateReference.createMany({ data, skipDuplicates: true });
    return { created: result.count };
  });
};

const updateReferenceFields = async (referenceId, data) =>
  prisma.jobCandidateReference.update({
    where: { id: referenceId },
    data,
    select: { ...REFERENCE_SELECT, resume: { select: RESUME_FILE_SELECT } },
  });

// Re-point the reference at the newly uploaded resume and delete the PREVIOUS
// StoredFile row in the same transaction (the reference is updated first, so the
// association is never left dangling). The previous file's DISK content is
// removed by the service AFTER commit — best effort, exactly like the
// candidate-list replacement contract.
const replaceReferenceResume = async ({ referenceId, resumeFileId, resumeText }) =>
  prisma.$transaction(async (tx) => {
    const previous = await tx.jobCandidateReference.findUnique({
      where: { id: referenceId },
      select: { resumeFileId: true, resume: { select: { id: true, storagePath: true } } },
    });
    const reference = await tx.jobCandidateReference.update({
      where: { id: referenceId },
      data: { resumeFileId, resumeText },
      select: { ...REFERENCE_SELECT, resume: { select: RESUME_FILE_SELECT } },
    });
    const previousFile =
      previous && previous.resumeFileId && previous.resumeFileId !== resumeFileId
        ? previous.resume
        : null;
    if (previousFile) {
      await tx.storedFile.delete({ where: { id: previousFile.id } });
    }
    return {
      reference,
      previousFileId: previousFile?.id ?? null,
      previousStoragePath: previousFile?.storagePath ?? null,
    };
  });

// ---------------------------------------------------------------------------
// Phase 7 — recruiter-triggered candidate analysis persistence.
// ---------------------------------------------------------------------------

// ONE transaction per analysis run, mirroring Start's "validate → commit →
// deliver" discipline (delivery happens in the service AFTER this returns):
//
//   1. Lock the reference row FOR UPDATE — serializes concurrent triggers for
//      the SAME candidate, so version numbers and the in-progress guard can
//      never interleave (two different candidates still run in parallel).
//   2. In-progress guard: if the latest analysis for this (job, candidate) is
//      still PENDING or PROCESSING on its AiJob, refuse with 409 — a
//      double-click must not fan out duplicate queue work.
//   3. Next analysisVersion = max(existing) + 1 under the lock. Earlier
//      versions are never rewritten (auditable history).
//   4. Create the durable PENDING AiJob through the shared createAiJob (the
//      ONLY AiJob writer), scoped by scopeKey `<candidateKey>:v<version>` so
//      every run is an independent, independently retryable AiJob while
//      JOB_ANALYSIS/ASSESSMENT_GENERATION keep their one-row-per-job contract.
//   5. Create the JobCandidateAnalysis row 1:1 with that AiJob. Status is
//      NEVER duplicated here — the AiJob row is the single source of truth;
//      this row carries the snapshot's identity, lineage (referenceId,
//      attemptId) and provenance (snapshotHash, schemaVersion) until a later
//      stage materializes `result`.
//
// candidateKey is the opaque JobCandidateReference.id — the raw email never
// reaches the AI payload (it stays on this internal row for DB-level identity).
const ANALYSIS_SELECT = {
  id: true,
  jobId: true,
  aiJobId: true,
  analysisVersion: true,
  referenceId: true,
  attemptId: true,
  schemaVersion: true,
  result: true,
  provider: true,
  model: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  aiJob: {
    select: {
      id: true,
      status: true,
      lastError: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
};

// Recruiter retrieval is anchored by BOTH the job id and the opaque reference id.
// It never accepts email and never searches candidate analyses globally. Version is
// optional; omitted means the latest persisted version, including a PROCESSING
// version that supersedes an older completed result.
const findAnalysesByReferenceInJob = async (jobId, referenceId, version = null) =>
  prisma.jobCandidateAnalysis.findMany({
    where: {
      jobId,
      referenceId,
      ...(version != null ? { analysisVersion: version } : {}),
    },
    orderBy: { analysisVersion: "desc" },
    select: ANALYSIS_SELECT,
  });

// Lightweight summaries for the existing candidate-list projection. `result` is
// deliberately absent so listing 1,000 candidates never downloads every analysis.
// The first row for each reference is its highest persisted analysisVersion.
const findLatestAnalysisSummariesByJobId = async (jobId) => {
  if (!jobId) return [];
  const rows = await prisma.jobCandidateAnalysis.findMany({
    where: { jobId, referenceId: { not: null } },
    orderBy: { analysisVersion: "desc" },
    select: {
      id: true,
      referenceId: true,
      aiJobId: true,
      analysisVersion: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
      aiJob: { select: { status: true } },
    },
  });
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.referenceId)) return false;
    seen.add(row.referenceId);
    return true;
  });
};

// Analysis rows already produced for ONE attempt. The automatic assessment-driven
// trigger uses it so a terminal attempt is analyzed exactly once: an attempt
// that already has an analysis is never re-analyzed, no matter how many terminal
// transitions the existing lazy rules observe.
const findAnalysesByAttemptId = async (attemptId) => {
  if (!attemptId) return [];
  return prisma.jobCandidateAnalysis.findMany({
    where: { attemptId },
    select: { id: true },
  });
};

const createCandidateAnalysis = async ({
  jobId,
  reference,
  attemptId,
  snapshot,
  snapshotHash,
}) =>
  prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "JobCandidateReference" WHERE "id" = ${reference.id} FOR UPDATE`;

    // Automatic-analysis idempotency, INSIDE the lock. The service-level
    // findAnalysesByAttemptId pre-check is only an optimization: it cannot close
    // the window where two triggers read "no analysis" concurrently. Re-checking
    // here — after the reference row is locked and before any write — makes
    // "at most one analysis per terminal attempt" an atomic property. Without it
    // a duplicate that arrives after the first analysis has COMPLETED would slip
    // past the PENDING/PROCESSING guard below and mint a second analysisVersion.
    if (attemptId) {
      const forAttempt = await tx.jobCandidateAnalysis.findFirst({
        where: { attemptId },
        select: { id: true },
      });
      if (forAttempt) {
        throw failure(409, "This assessment attempt has already been analyzed");
      }
    }

    const latest = await tx.jobCandidateAnalysis.findFirst({
      where: { jobId, candidateEmail: reference.candidateEmail },
      orderBy: { analysisVersion: "desc" },
      select: {
        analysisVersion: true,
        aiJob: { select: { status: true } },
      },
    });
    if (
      latest &&
      (latest.aiJob.status === AI_JOB_STATUS.PENDING ||
        latest.aiJob.status === AI_JOB_STATUS.PROCESSING)
    ) {
      throw failure(409, "An analysis for this candidate is already in progress");
    }

    const analysisVersion = (latest?.analysisVersion ?? 0) + 1;
    const candidateKey = reference.id;
    const scopeKey = `${candidateKey}:v${analysisVersion}`;
    // The exact frozen transport snapshot. aiJobId is intentionally added by the
    // worker from its authoritative claimed row, never accepted from a queue
    // message or a caller. The raw email is absent from every nested value.
    const requestPayload = {
      operation: AI_JOB_OPERATION.CANDIDATE_ANALYSIS,
      input: { ...snapshot, analysisVersion },
    };

    const aiJob = await createAiJob({
      jobId,
      operation: AI_JOB_OPERATION.CANDIDATE_ANALYSIS,
      scopeKey,
      requestPayload,
      client: tx,
    });

    const analysis = await tx.jobCandidateAnalysis.create({
      data: {
        jobId,
        aiJobId: aiJob.id,
        candidateEmail: reference.candidateEmail,
        candidateName: reference.candidateName ?? null,
        analysisVersion,
        candidateKey,
        referenceId: reference.id,
        attemptId: attemptId ?? null,
        snapshotHash,
        schemaVersion: "1",
      },
    });

    return { aiJob, analysis };
  });

module.exports = {
  REFERENCE_SELECT,
  RESUME_FILE_SELECT,
  normalizeEmail,
  buildReferenceSeedData,
  findReferencesByJobId,
  findReferenceByIdInJob,
  findReferenceWithResumeFile,
  seedCandidateReferences,
  updateReferenceFields,
  replaceReferenceResume,
  findAnalysesByReferenceInJob,
  findAnalysesByAttemptId,
  findLatestAnalysisSummariesByJobId,
  createCandidateAnalysis,
};
