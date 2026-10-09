const crypto = require("node:crypto");

const {
  createStoredFile,
  removeStoredFileContent,
  removeEmptyStoredFileDirectory,
} = require("../storage/storage.service");
const jobRepository = require("./job.repository");
const jobCandidateReferenceRepository = require("./jobCandidateReference.repository");
const {
  MAX_CANDIDATES,
  readStoredCandidateReferenceRows,
} = require("./jobCandidateList.parser");
// Phase 7 — the reference service deliberately composes EXISTING job-service
// primitives (authorization chain, queue delivery) rather than reimplementing
// them, so there is exactly ONE definition of each. The AI-workflow status gate
// (assertAiWorkflowAvailable) is deliberately NOT imported: it only asserts the
// job is ACTIVE, and runAutomaticCandidateAnalysis — the sole analysis entry
// point — enforces that itself before enqueueing anything.
const {
  requireAuthorizedJob,
  enqueueAiJobDelivery,
  // THE shared candidate classification (Excel list projection AND manual add).
  classifyJobCandidates,
} = require("./job.service");
// PHASE 3 — the centralized ORG_ADMIN candidate-level privacy policy. Every
// candidate-level read in this service calls it AFTER requireAuthorizedJob (so the
// existing organization/ownership check still runs first) and BEFORE any
// candidate row, file or analysis is loaded.
const { assertCandidateLevelAccess } = require("./jobCandidatePrivacy");
const {
  assertResumeUpload,
  extractResumeText,
} = require("./jobCandidateResume");
// Attempt linkage for the analysis snapshot: the candidate's persisted attempt
// (keyed by the job's assessment + the internal normalized email) and its saved
// answers. The attempt repository only needs prisma + the pure scorer, so there
// is no require cycle.
const attemptRepository = require("./jobAssessmentAttempt.repository");
const realtimePublisher = require("./jobAssessmentRealtime.publisher");
const {
  CANDIDATE_REFERENCE_FIELD_LIMITS,
  MAX_CANDIDATE_REFERENCE_SKILLS,
  // The manual-add body is bounded by the same email rule the Excel parser
  // applies to every sheet row, so neither path can drift.
  CANDIDATE_EMAIL_PATTERN,
  MAX_CANDIDATE_EMAIL_LENGTH,
} = require("./job.validation");

// ---------------------------------------------------------------------------
// Phase 7 (Step 2) — candidate references + resumes (NO AI).
//
// EVERY entry point establishes the same chain before touching data:
//   authenticated user → authorized Job (existing ownership/organization
//   rules) → JobCandidateReference resolved INSIDE that job.
// The client never supplies an email, a file id or an owner: the reference's own
// opaque id is the only candidate identifier, and it is always looked up
// together with the job id the caller was authorized against. Nothing here
// dispatches AI work, generates an analysis version, or writes a realtime
// event — Step 2 is deliberately about reliable reference/resume data only.
// ---------------------------------------------------------------------------

const httpError = (status, message) => Object.assign(new Error(message), { status });

// One generic 404 for "no such reference in this job": a nonexistent id, an id
// from another job and an id from another organization are indistinguishable,
// so nothing about other recruiters' candidate data can be probed.
const referenceNotFound = () => httpError(404, "Candidate reference not found");

const resumeNotFound = () =>
  httpError(404, "No resume is stored for this candidate reference");

// Best-effort disk cleanup, run only AFTER the database state is final (same
// contract as the candidate-list replacement): a cleanup failure is logged,
// never propagated.
const cleanupStoredResumeFile = async (storagePath) => {
  if (!storagePath) {
    return;
  }
  try {
    await removeStoredFileContent(storagePath);
    await removeEmptyStoredFileDirectory(storagePath);
  } catch (error) {
    console.error(`[job] failed to remove candidate resume content: ${error.message}`);
  }
};

// Client-safe projection. The extracted TEXT stays server-side: it is the later
// analysis input, so the UI receives availability + length instead of the whole
// document. storagePath, createdByUserId and file-owner internals never leave
// the server here.
const sanitizeCandidateReference = (reference) => ({
  id: reference.id,
  jobId: reference.jobId,
  candidateEmail: reference.candidateEmail,
  candidateName: reference.candidateName,
  linkedinUrl: reference.linkedinUrl,
  linkedinText: reference.linkedinText,
  githubUrl: reference.githubUrl,
  githubText: reference.githubText,
  preferredRole: reference.preferredRole,
  skills: Array.isArray(reference.skills) ? reference.skills : null,
  skillNotes: reference.skillNotes,
  resume: reference.resume
    ? {
        fileId: reference.resume.id,
        fileName: reference.resume.originalName,
        mimeType: reference.resume.mimeType,
        fileSize: reference.resume.fileSize,
        uploadedAt: reference.resume.createdAt,
      }
    : null,
  hasResume: Boolean(reference.resumeFileId),
  resumeTextAvailable: Boolean(reference.resumeText),
  resumeTextLength: reference.resumeText?.length ?? 0,
  createdAt: reference.createdAt,
  updatedAt: reference.updatedAt,
});

// ---------------------------------------------------------------------------
// Reference reads & edits (NO AI)
// ---------------------------------------------------------------------------

// Reference data is draft-time AND active-time enrichment (the recruiter
// refines candidates while the job runs), but CLOSED jobs are terminal and
// read-only — the same lifecycle rule every other job write follows.
const assertReferenceWritable = (job) => {
  if (job.status === jobRepository.JOB_STATUS.CLOSED) {
    throw httpError(409, "Closed jobs are read-only");
  }
};

// Skills normalization: the SAME shape the Excel seeder produces (trimmed,
// blanks dropped, case-insensitive de-dup, bounded by the shared limits), so an
// edited list and a seeded list are indistinguishable downstream. An empty
// result normalizes to null — "no skills" is one representation, not two.
const normalizeSkills = (skills) => {
  if (skills === null || skills === undefined) {
    return null;
  }
  if (!Array.isArray(skills)) {
    return null;
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of skills) {
    const skill = String(entry ?? "")
      .trim()
      .slice(0, CANDIDATE_REFERENCE_FIELD_LIMITS.skill);
    if (!skill) {
      continue;
    }
    const key = skill.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(skill);
    if (normalized.length >= MAX_CANDIDATE_REFERENCE_SKILLS) {
      break;
    }
  }
  return normalized.length > 0 ? normalized : null;
};

// Maps the manual-add body onto the EXACT row shape the Excel parser produces
// (parseCandidateListReferenceRows), so both entry points feed the repository
// identically. Blank strings collapse to null (one representation of "absent"),
// text is truncated to the same per-field limits the reference editor applies,
// and skills go through the SAME normalizeSkills helper — so a manually added
// candidate and an imported one are indistinguishable downstream.
const toManualCandidateRow = (payload, email) => {
  const text = (value, limit) => {
    if (value === null || value === undefined) {
      return null;
    }
    const trimmed = String(value).trim();
    return trimmed === "" ? null : trimmed.slice(0, limit);
  };
  return {
    email,
    name: text(payload?.name, CANDIDATE_REFERENCE_FIELD_LIMITS.candidateName),
    linkedinUrl: text(payload?.linkedinUrl, CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinUrl),
    linkedinText: text(payload?.linkedinText, CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinText),
    githubUrl: text(payload?.githubUrl, CANDIDATE_REFERENCE_FIELD_LIMITS.githubUrl),
    githubText: text(payload?.githubText, CANDIDATE_REFERENCE_FIELD_LIMITS.githubText),
    preferredRole: text(payload?.preferredRole, CANDIDATE_REFERENCE_FIELD_LIMITS.preferredRole),
    skillNotes: text(payload?.skillNotes, CANDIDATE_REFERENCE_FIELD_LIMITS.skillNotes),
    skills: normalizeSkills(payload?.skills),
  };
};

// PATCH semantics for the strict zod whitelist (absent = skip, null = clear,
// value = set) — the SAME convention the draft-update flow uses. Identity keys
// (candidateEmail / id / jobId / resumeFileId / resumeText) never appear here:
// zod .strict() rejects them at the route, and this mapper only reads the
// whitelisted field names even when the service is called directly. A blank
// string clears, exactly like null.
const REFERENCE_TEXT_FIELDS = [
  "candidateName",
  "linkedinUrl",
  "linkedinText",
  "githubUrl",
  "githubText",
  "preferredRole",
  "skillNotes",
];

const buildReferenceUpdateData = (payload) => {
  const data = {};
  for (const field of REFERENCE_TEXT_FIELDS) {
    if (payload[field] === undefined) {
      continue;
    }
    if (payload[field] === null) {
      data[field] = null;
      continue;
    }
    const text = String(payload[field]).trim();
    // Defense-in-depth: the route schema already bounds every field, but the
    // service re-applies the SAME per-field limits the Excel seeder uses
    // (truncateTo in jobCandidateList.parser), so a direct service call can
    // never store an over-long value either — both entry points shape values
    // identically.
    data[field] =
      text === "" ? null : text.slice(0, CANDIDATE_REFERENCE_FIELD_LIMITS[field]);
  }
  if (payload.skills !== undefined) {
    data.skills = payload.skills === null ? null : normalizeSkills(payload.skills);
  }
  return data;
};

// Every resolution goes through (jobId, referenceId) — a bare id from another
// job (or another organization) simply does not resolve, so nothing about
// other recruiters' candidates can be probed.
const resolveReferenceOr404 = async (jobId, referenceId) => {
  const reference = await jobCandidateReferenceRepository.findReferenceByIdInJob(
    jobId,
    referenceId
  );
  if (!reference) {
    throw referenceNotFound();
  }
  return reference;
};

// Upgrade-safe backfill: a candidate list uploaded BEFORE Phase 7 has no
// reference rows yet. Every entry point runs this idempotent, seed-if-absent
// backfill from the STORED sheet before resolving references, so a pre-existing
// job behaves exactly like one imported after the migration. An unreadable
// stored sheet surfaces the SAME recruiter-facing error as every other
// stored-list reader — it never silently reports "no candidates".
const seedReferencesFromStoredList = async (job) => {
  const existing = await jobCandidateReferenceRepository.findReferencesByJobId(job.id);
  if (existing.length > 0) {
    return { created: 0, existing: existing.length };
  }
  const association = await jobRepository.findCandidateListWithFile(job.id);
  if (!association || !association.file) {
    return { created: 0, existing: 0 };
  }
  const { rows } = await readStoredCandidateReferenceRows(association.file, MAX_CANDIDATES);
  const result = await jobCandidateReferenceRepository.seedCandidateReferences({
    jobId: job.id,
    createdByUserId: job.createdByUserId,
    rows,
  });
  return { created: result.created, existing: 0 };
};

const listCandidateReferences = async (user, jobId) => {
  const job = await requireAuthorizedJob(user, jobId);
  // PHASE 3 — ACTIVE-job candidate privacy (see jobCandidatePrivacy.js). The job
  // is already organization-authorized; this adds the status gate BEFORE any
  // reference row is read. Recruiters are unaffected.
  assertCandidateLevelAccess(user, job);
  await seedReferencesFromStoredList(job);
  const references = await jobCandidateReferenceRepository.findReferencesByJobId(jobId);
  return references.map(sanitizeCandidateReference);
};

const listCandidateReferenceIdentities = async (user, jobId) => {
  const job = await requireAuthorizedJob(user, jobId);
  // PHASE 3 — this "identities" projection looks minimal (id + hasResume) but it
  // is still ONE ROW PER CANDIDATE keyed by a stable candidate reference id, which
  // is candidate-level information for an ACTIVE job. Gated identically.
  assertCandidateLevelAccess(user, job);
  await seedReferencesFromStoredList(job);
  const references = await jobCandidateReferenceRepository.findReferencesByJobId(jobId);
  return references.map((reference) => ({
    referenceId: reference.id,
    jobId: reference.jobId,
    hasResume: Boolean(reference.resumeFileId),
  }));
};

const getCandidateReference = async (user, jobId, referenceId) => {
  const job = await requireAuthorizedJob(user, jobId);
  // PHASE 3 — ACTIVE-job candidate privacy, applied before the reference row
  // (resume text, LinkedIn/GitHub text, evidence) is loaded.
  assertCandidateLevelAccess(user, job);
  await seedReferencesFromStoredList(job);
  const reference = await resolveReferenceOr404(jobId, referenceId);
  return sanitizeCandidateReference(reference);
};

const updateCandidateReference = async (user, jobId, referenceId, payload) => {
  const job = await requireAuthorizedJob(user, jobId);
  assertReferenceWritable(job);
  await seedReferencesFromStoredList(job);
  const reference = await resolveReferenceOr404(jobId, referenceId);

  const data = buildReferenceUpdateData(payload);
  if (Object.keys(data).length === 0) {
    throw httpError(400, "At least one candidate reference field must be provided");
  }

  const updated = await jobCandidateReferenceRepository.updateReferenceFields(
    reference.id,
    data
  );
  return sanitizeCandidateReference(updated);
};

// ---------------------------------------------------------------------------
// Manual candidate addition — the recruiter's backup for a missed candidate
// ---------------------------------------------------------------------------
// Manual addition exists because a sheet is rarely exhaustive. It creates the
// SAME row an Excel row creates, through the SAME repository transaction, so
// the two entry points converge immediately:
//
//   Excel row  ─┐
//               ├─→ JobCandidateReference ─→ classification ─→ list ─→ invite
//   Manual add ─┘                        ─→ assessment ─→ AUTOMATIC analysis
//
// It carries the same candidate information the reference editor already owns
// (name, LinkedIn, GitHub, preferred role, skills, skill notes); the resume is
// attached through the EXISTING resume upload below, so there is exactly one
// resume system. There is no second candidate data model.
//
// Guarantees:
//   * IN_SYSTEM / NOT_IN_SYSTEM is decided by the BACKEND through the same
//     classifyJobCandidates → classifyCandidateRows pair the Excel list uses —
//     the request body is a strict candidate-fields schema, so a client-supplied
//     status is rejected at the route, never trusted here;
//   * it NEVER creates a User, and NEVER modifies an existing one — an in-system
//     candidate is only recognized;
//   * duplicate protection is the existing seed-if-absent transaction (Job row
//     locked FOR UPDATE + createMany skipDuplicates on @@unique([jobId,
//     candidateEmail])), so a re-add and a later Excel import of the same address
//     never produce a second reference and never overwrite recruiter edits.
const addManualCandidateReference = async (user, jobId, payload) => {
  const job = await requireAuthorizedJob(user, jobId);
  assertReferenceWritable(job);
  await seedReferencesFromStoredList(job);

  // The email shape was already validated by the strict route schema; the
  // service re-applies the SAME rule so a direct call can never store an address
  // the sheet would have rejected. Then the ONE normalization (trim + lowercase),
  // so "Candidate@Example.com" and " candidate@example.com " are the same
  // candidate here exactly as in the uploaded file.
  const rawEmail = String(payload?.email ?? "").trim();
  if (
    !rawEmail ||
    rawEmail.length > MAX_CANDIDATE_EMAIL_LENGTH ||
    !CANDIDATE_EMAIL_PATTERN.test(rawEmail)
  ) {
    throw httpError(400, "Enter a valid candidate email address");
  }
  const email = jobCandidateReferenceRepository.normalizeEmail(rawEmail);

  // A job can never exceed the same 1,000-candidate ceiling the sheet enforces.
  const existing = await jobCandidateReferenceRepository.findReferencesByJobId(jobId);
  if (existing.length >= MAX_CANDIDATES) {
    throw httpError(409, "This job already has the maximum number of candidates");
  }

  await jobCandidateReferenceRepository.seedCandidateReferences({
    jobId,
    createdByUserId: user.id,
    rows: [toManualCandidateRow(payload, email)],
  });

  const reference = (
    await jobCandidateReferenceRepository.findReferencesByJobId(jobId)
  ).find((row) => jobCandidateReferenceRepository.normalizeEmail(row.candidateEmail) === email);
  if (!reference) {
    throw httpError(500, "The candidate could not be saved");
  }

  // The authoritative classification, produced by the SAME shared function the
  // Excel list projection uses.
  const { classification } = await classifyJobCandidates(jobId, [
    { rowIndex: null, name: reference.candidateName ?? null, email },
  ]);
  const classified = classification.candidates[0];
  if (!classified) {
    throw httpError(500, "The candidate could not be classified");
  }

  // The response is the SAME safe candidate DTO the list returns: the
  // classification the backend actually determined plus the job-scoped reference
  // identity. No raw User record, no private account fields. `created` is false
  // when the reference already existed, so the caller knows it must NOT overwrite
  // an existing candidate (e.g. re-uploading a resume).
  return {
    created: !existing.some(
      (row) => jobCandidateReferenceRepository.normalizeEmail(row.candidateEmail) === email
    ),
    candidate: {
      ...classified,
      name: reference.candidateName ?? null,
      referenceId: reference.id,
      preferredRole: reference.preferredRole ?? null,
      skills: Array.isArray(reference.skills) ? reference.skills : [],
      skillNotes: reference.skillNotes ?? null,
      linkedinUrl: reference.linkedinUrl ?? null,
      githubUrl: reference.githubUrl ?? null,
      hasResume: Boolean(reference.resumeFileId),
      resumeTextAvailable: Boolean(reference.resumeText),
      analysis: null,
      // A UI label only. It carries NO authority and never influences the
      // classification above.
      source: "MANUAL",
    },
  };
};

// ---------------------------------------------------------------------------
// Resume upload + private view (NO AI)
// ---------------------------------------------------------------------------

// The recruiter attaches a resume (PDF/TXT only) to ONE reference. Ordering
// mirrors uploadCandidateList exactly:
//   validate boundary/content FIRST (a rejected file leaves zero rows and zero
//   disk writes) → persist the StoredFile → extract text (never fails the
//   request) → atomically swap the association (the previous StoredFile row is
//   deleted inside replaceReferenceResume) → best-effort disk cleanup of the
//   previous file AFTER commit. If the association fails, the just-created
//   StoredFile row + disk content are rolled back here.
// Extraction outcomes: EXTRACTED (resumeText stored) or UNAVAILABLE (a scanned/
// image-only PDF keeps resumeFileId + the file itself, resumeText = null) —
// the request still succeeds either way; only the boundary checks can 4xx.
const uploadCandidateResume = async (user, jobId, referenceId, file) => {
  const job = await requireAuthorizedJob(user, jobId);
  assertReferenceWritable(job);
  await seedReferencesFromStoredList(job);
  const reference = await resolveReferenceOr404(jobId, referenceId);

  assertResumeUpload(file);

  const storedFile = await createStoredFile({
    userId: user.id,
    ownerId: user.id,
    role: user.role,
    // Same ownership rule as the candidate-list upload: the file lives under
    // the uploading recruiter's directory; the job association lives on the
    // reference (resumeFileId), never on file ownership. Writes are
    // recruiter-only at the route, so role is RECRUITER here.
    ownerType: "RECRUITER",
    category: "JOB_CANDIDATE_RESUME",
    file,
  });

  try {
    const { text, status } = await extractResumeText({
      buffer: file.buffer,
      mimeType: file.mimetype,
    });
    const { reference: updated, previousStoragePath } =
      await jobCandidateReferenceRepository.replaceReferenceResume({
        referenceId: reference.id,
        resumeFileId: storedFile.id,
        resumeText: text,
      });
    // Replace cleanup strictly after commit.
    await cleanupStoredResumeFile(previousStoragePath);
    return { ...sanitizeCandidateReference(updated), extraction: { status } };
  } catch (error) {
    // The association failed: the just-uploaded StoredFile must not linger
    // (same cleanup contract as the candidate-list flow).
    await jobRepository.deleteStoredFileById(storedFile.id).catch(() => {});
    await cleanupStoredResumeFile(storedFile.storagePath);
    throw error;
  }
};

// Private resume view descriptor. The returned storagePath NEVER reaches the
// client: the controller streams the file itself after this authorization
// chain (owned job → reference inside that job → resume attached). Reads are
// allowed in every job status — CLOSED is read-only, not unreadable.
const openCandidateResume = async (user, jobId, referenceId) => {
  const job = await requireAuthorizedJob(user, jobId);
  // PHASE 3 — a resume FILE is the most sensitive candidate evidence there is.
  // Gated before the StoredFile row (and the disk path) is resolved.
  assertCandidateLevelAccess(user, job);
  await seedReferencesFromStoredList(job);
  const reference = await jobCandidateReferenceRepository.findReferenceWithResumeFile(
    jobId,
    referenceId
  );
  if (!reference) {
    throw referenceNotFound();
  }
  if (!reference.resumeFileId || !reference.resume) {
    throw resumeNotFound();
  }
  return reference.resume;
};

// ---------------------------------------------------------------------------
// Recruiter-triggered candidate analysis
// ---------------------------------------------------------------------------

// Candidate-analysis request boundary — mirrors the GREEN FastAPI Step 3 schema.
// Stable key ordering makes the hash reproducible across object construction
// order while preserving array order, which is meaningful for job questions,
// assessment questions, answers, and ordered evidence. Transport-only values
// (AiJob id, analysis version, and retry metadata) are intentionally outside
// this hash: the same logical evidence snapshot has one stable identity.
const canonicalizeCandidateSnapshot = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeCandidateSnapshot);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeCandidateSnapshot(value[key])])
    );
  }
  return value;
};
const hashCandidateAnalysisSnapshot = (snapshot) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeCandidateSnapshot(snapshot)))
    .digest("hex");

// The normalized candidate email is needed only to resolve the internal attempt.
// It must not survive anywhere in the outbound snapshot, even if a recruiter
// pasted it into a name, note, URL, job question, or evidence text. Redact the
// exact address deterministically before hashing/freezing; the authoritative
// database row and recruiter UI remain unchanged.
const redactCandidateEmail = (value, email) => {
  if (typeof value === "string") {
    if (!email) return value;
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.replace(new RegExp(escaped, "gi"), "[REDACTED_EMAIL]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactCandidateEmail(entry, email));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactCandidateEmail(entry, email)])
    );
  }
  return value;
};

// Only candidate answers have an approved lossy transform: the persisted answer
// remains untouched while the request carries at most the first 4,000 characters
// and an explicit truncated flag. Every other value is preserved and rejected
// when it cannot fit the contract; nothing is silently shortened.
const MAX_CANDIDATE_ANSWER_CHARS = 4000;
const CONTRACT_LIMITS = {
  name: 200,
  text: 4000,
  jobDescription: 30000,
  url: 2000,
  linkedinText: 10000,
  githubText: 10000,
  resumeText: 20000,
  assessmentQuestions: 45,
  candidateSkills: 100,
};

const snapshotError = (message) => httpError(422, message);
const presentText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() ? text : null;
};
const requiredText = (value, field, max = CONTRACT_LIMITS.text) => {
  const text = presentText(value);
  if (!text) throw snapshotError(`${field} is required for candidate analysis`);
  if (text.length > max) {
    throw snapshotError(`${field} exceeds the candidate-analysis contract limit`);
  }
  return text;
};
const optionalText = (value, field, max = CONTRACT_LIMITS.text) => {
  const text = presentText(value);
  if (text !== null && text.length > max) {
    throw snapshotError(`${field} exceeds the candidate-analysis contract limit`);
  }
  return text;
};
const boundedList = (values, field, max, mapper = (value) => value) => {
  if (!Array.isArray(values) || values.length > max) {
    throw snapshotError(`${field} exceeds the candidate-analysis contract limit`);
  }
  return values.map(mapper);
};

// Persisted answers use the platform's deterministic JSON shapes. Convert only
// those shapes to the Step 3 string value; never serialize hidden question data
// or reconstruct correctness.
const answerTextForAi = (answer) => {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const value =
    typeof answer.text === "string"
      ? answer.text
      : typeof answer.choice === "string"
        ? answer.choice
        : Array.isArray(answer.choices) && answer.choices.every((choice) => typeof choice === "string")
          ? answer.choices.join(", ")
          : null;
  return presentText(value);
};

const evidenceFor = ({ text, referenceAvailable, max, field }) => {
  const available = optionalText(text, field, max);
  return {
    text: available,
    status: available ? "AVAILABLE" : referenceAvailable ? "UNAVAILABLE" : "NOT_PROVIDED",
  };
};

// Client-safe analysis projection. Status is NOT copied here — the linked
// AiJob row owns it (single source of truth) and travels alongside.
const sanitizeAnalysis = (analysis) => ({
  id: analysis.id,
  analysisVersion: analysis.analysisVersion,
  createdAt: analysis.createdAt,
});

// The immutable evidence snapshot for ONE analysis run. It intentionally stops
// short of the transport envelope: the repository adds the transactionally
// allocated analysisVersion, and the worker adds its own AiJob id. Everything
// here is already in the exact Step 3 field shape; no second interpretation layer
// is needed and the raw email is absent from every key and value.
const buildCandidateAnalysisSnapshot = ({ job, reference, attempt, answers }) => {
  const answerByQuestion = new Map(
    answers.map((row) => [row.questionId, answerTextForAi(row.answer)])
  );
  const assessmentQuestions = boundedList(
    job.assessment?.questions ?? [],
    "Assessment questions",
    CONTRACT_LIMITS.assessmentQuestions
  );
  const assessment = job.assessment
    ? {
        title: requiredText(job.assessment.title, "Assessment title", CONTRACT_LIMITS.name),
        description: optionalText(job.assessment.description, "Assessment description"),
        status: attempt?.status ?? "NOT_STARTED",
        score: attempt?.score ?? null,
        maxScore: attempt?.maxScore ?? null,
        scorePercentage:
          attempt?.scorePercentage === null || attempt?.scorePercentage === undefined
            ? null
            : Number(attempt.scorePercentage),
        questions: assessmentQuestions.map((question) => {
          const rawAnswer = answerByQuestion.get(question.id);
          const unanswered = rawAnswer === null || rawAnswer === undefined;
          const truncated = !unanswered && rawAnswer.length > MAX_CANDIDATE_ANSWER_CHARS;
          return {
            question: requiredText(question.prompt, "Assessment question"),
            questionType: question.questionType,
            points: question.points,
            candidateAnswer: unanswered
              ? null
              : {
                  answer: truncated
                    ? rawAnswer.slice(0, MAX_CANDIDATE_ANSWER_CHARS)
                    : rawAnswer,
                  truncated,
                },
            // Per-question score is not persisted by the current assessment
            // schema. Never reconstruct it from the hidden answer key.
            earnedPoints: null,
            unanswered,
          };
        }),
      }
    : null;
  if (assessment) {
    assessment.unanswered =
      assessment.questions.length > 0 && assessment.questions.every((q) => q.unanswered);
  }

  const resume = evidenceFor({
    text: reference.resumeText,
    referenceAvailable: Boolean(reference.resumeFileId),
    max: CONTRACT_LIMITS.resumeText,
    field: "Resume text",
  });
  const linkedin = evidenceFor({
    text: reference.linkedinText,
    referenceAvailable: Boolean(reference.linkedinUrl),
    max: CONTRACT_LIMITS.linkedinText,
    field: "LinkedIn text",
  });
  const github = evidenceFor({
    text: reference.githubText,
    referenceAvailable: Boolean(reference.githubUrl),
    max: CONTRACT_LIMITS.githubText,
    field: "GitHub text",
  });

  return {
    schemaVersion: "1",
    candidateKey: reference.id,
    job: {
      title: requiredText(job.title, "Job title", CONTRACT_LIMITS.name),
      yearsExperience: job.yearsExperience ?? null,
      description: requiredText(
        job.description,
        "Job description",
        CONTRACT_LIMITS.jobDescription
      ),
      skills: boundedList(job.skills ?? [], "Job skills", 100, (skill) => ({
        name: requiredText(skill.name, "Job skill", CONTRACT_LIMITS.name),
        weight: skill.weight,
      })),
      tools: boundedList(job.tools ?? [], "Job tools", 100, (tool) =>
        requiredText(tool.name, "Job tool", CONTRACT_LIMITS.name)
      ),
      recruiterQuestions: boundedList(
        job.questions ?? [],
        "Recruiter questions",
        100,
        (question) => requiredText(question.question, "Recruiter question")
      ),
      // Job has no authoritative standalone responsibilities field. Do not infer
      // or split prose; the existing job description carries that content.
      responsibilities: [],
    },
    assessment,
    candidate: {
      candidateName: optionalText(
        reference.candidateName,
        "Candidate name",
        CONTRACT_LIMITS.name
      ),
      preferredRole: optionalText(reference.preferredRole, "Preferred role"),
      skills: boundedList(
        Array.isArray(reference.skills) ? reference.skills : [],
        "Candidate skills",
        CONTRACT_LIMITS.candidateSkills,
        (skill) => requiredText(skill, "Candidate skill", CONTRACT_LIMITS.name)
      ),
      skillNotes: optionalText(reference.skillNotes, "Skill notes"),
      linkedinUrl: optionalText(reference.linkedinUrl, "LinkedIn URL", CONTRACT_LIMITS.url),
      linkedinText: linkedin.text,
      linkedinEvidenceStatus: linkedin.status,
      githubUrl: optionalText(reference.githubUrl, "GitHub URL", CONTRACT_LIMITS.url),
      githubText: github.text,
      githubEvidenceStatus: github.status,
      resumeText: resume.text,
      resumeEvidenceStatus: resume.status,
    },
    metadata: { source: "NODE_WORKER" },
  };
};

// The recruiter-triggered analysis entry point. Status gate: the ONE
// AI-workflow gate (ACTIVE only — drafts have no assessment state yet, CLOSED
// jobs are terminal). Free action: no quota, no JobQuotaConsumption — only
// Start ever consumes a job slot.
//
// Order: authorize → gate → backfill → resolve → snapshot → COMMIT (AiJob +
// analysis row) → DELIVER. A queue outage after commit surfaces as 425 with
// both rows durably PENDING — exactly Start's delivery contract.
// Recruiter-facing analysis DTO. The status always comes from the linked AiJob;
// result is exposed only for a COMPLETED version and is rebuilt from an explicit
// Step 3 field whitelist. Raw Prisma JSON, email, snapshot/hash, prompt, tokens,
// integrity metadata, correct answers, and storage internals never pass through.
const sanitizeAnalysisResult = (result) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const text = (value) => (typeof value === "string" ? value : null);
  const textList = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  const evidence = (value) => value && typeof value === "object"
    ? {
        status: value.status,
        summary: text(value.summary),
        details: textList(value.details),
      }
    : { status: "UNAVAILABLE", summary: null, details: [] };
  const performance = result.assessmentPerformance ?? {};
  return {
    jobFitSummary: text(result.jobFitSummary),
    assessmentPerformance: {
      status: performance.status ?? "NOT_STARTED",
      score: Number.isFinite(performance.score) ? performance.score : null,
      maxScore: Number.isFinite(performance.maxScore) ? performance.maxScore : null,
      scorePercentage: Number.isFinite(performance.scorePercentage) ? performance.scorePercentage : null,
      summary: text(performance.summary),
      strengths: textList(performance.strengths),
      gaps: textList(performance.gaps),
      unanswered: Number.isInteger(performance.unanswered) ? performance.unanswered : 0,
    },
    skillAlignment: Array.isArray(result.skillAlignment)
      ? result.skillAlignment.map((item) => ({
          skill: text(item?.skill),
          status: item?.status ?? "UNAVAILABLE",
          rationale: text(item?.rationale),
          evidence: textList(item?.evidence),
        }))
      : [],
    resumeEvidence: evidence(result.resumeEvidence),
    linkedinEvidence: evidence(result.linkedinEvidence),
    githubEvidence: evidence(result.githubEvidence),
    preferredRoleAlignment: {
      status: result.preferredRoleAlignment?.status ?? "UNAVAILABLE",
      summary: text(result.preferredRoleAlignment?.summary),
      rationale: text(result.preferredRoleAlignment?.rationale),
    },
    strengths: textList(result.strengths),
    skillGaps: textList(result.skillGaps),
    missingRequirements: textList(result.missingRequirements),
    conflicts: textList(result.conflicts),
    concerns: textList(result.concerns),
    finalRecruiterReview: text(result.finalRecruiterReview),
  };
};

const sanitizeAnalysisState = (analysis) => {
  if (!analysis) return null;
  const completed = analysis.aiJob?.status === "COMPLETED";
  return {
    analysisId: analysis.id,
    aiJobId: analysis.aiJobId,
    analysisVersion: analysis.analysisVersion,
    status: analysis.aiJob?.status ?? "PENDING",
    errorCode: analysis.aiJob?.lastError ?? null,
    schemaVersion: analysis.schemaVersion ?? null,
    provider: completed ? (analysis.provider ?? null) : null,
    model: completed ? (analysis.model ?? null) : null,
    completedAt: completed ? (analysis.completedAt ?? analysis.aiJob?.completedAt ?? null) : null,
    createdAt: analysis.createdAt,
    updatedAt: analysis.updatedAt,
    result: completed ? sanitizeAnalysisResult(analysis.result) : null,
  };
};

const sanitizeAnalysisSummary = (analysis) => {
  if (!analysis) return null;
  return {
    analysisId: analysis.id,
    aiJobId: analysis.aiJobId,
    analysisVersion: analysis.analysisVersion,
    status: analysis.aiJob?.status ?? "PENDING",
    errorCode: analysis.aiJob?.lastError ?? null,
    completedAt: analysis.completedAt,
    createdAt: analysis.createdAt,
    updatedAt: analysis.updatedAt,
  };
};

// Latest version semantics: the highest persisted version is authoritative even
// when it is PROCESSING/FAILED. The latest COMPLETED result is returned alongside
// it so the recruiter does not lose access to v1 while v2 is running. `version`
// is optional for lightweight history selection and remains job/reference scoped.
const getCandidateAnalysis = async (user, jobId, referenceId, version = null) => {
  const job = await requireAuthorizedJob(user, jobId);
  // PHASE 3 — the candidate analysis report is candidate-level evidence. Gated
  // before any JobCandidateAnalysis/AiJob row (and its result JSON) is loaded.
  assertCandidateLevelAccess(user, job);
  await seedReferencesFromStoredList(job);
  await resolveReferenceOr404(jobId, referenceId);
  const all = await jobCandidateReferenceRepository.findAnalysesByReferenceInJob(
    jobId,
    referenceId
  );
  if (all.length === 0) {
    if (version != null) throw httpError(404, "Candidate analysis version not found");
    return {
      referenceId,
      selected: null,
      latest: null,
      latestCompleted: null,
      versions: [],
    };
  }
  const latest = all[0];
  const selected = version == null
    ? latest
    : all.find((analysis) => analysis.analysisVersion === version);
  if (!selected) throw httpError(404, "Candidate analysis version not found");
  const latestCompleted = all.find((analysis) => analysis.aiJob?.status === "COMPLETED") ?? null;
  return {
    referenceId,
    selected: sanitizeAnalysisState(selected),
    latest: sanitizeAnalysisState(latest),
    latestCompleted: sanitizeAnalysisState(latestCompleted),
    versions: all.map(sanitizeAnalysisSummary),
  };
};

// ---------------------------------------------------------------------------
// The ONE candidate-analysis creation pipeline
// ---------------------------------------------------------------------------
// Both the (still available) explicit route and the AUTOMATIC assessment-driven
// trigger call this, so there is exactly one way an analysis is ever created:
//   snapshot → COMMIT (AiJob + JobCandidateAnalysis) → publish → DELIVER.
// Nothing else calls createCandidateAnalysis, so no new AiJob path, queue,
// provider, table or realtime channel can appear.
//
// The snapshot is the existing job-scoped, redacted contract: the job, the
// candidate's reference evidence (resume/LinkedIn/GitHub/preferred role/skills/
// notes) and the assessment result. The raw email is redacted, correct answers,
// integrity metadata, tokens, secrets and storage paths never enter it, and the
// existing per-answer truncation limit is applied by the snapshot builder.
const createAndDeliverCandidateAnalysis = async ({ job, reference, attempt, answers }) => {
  const snapshot = redactCandidateEmail(
    buildCandidateAnalysisSnapshot({ job, reference, attempt, answers }),
    reference.candidateEmail
  );
  const snapshotHash = hashCandidateAnalysisSnapshot(snapshot);

  const { aiJob, analysis } = await jobCandidateReferenceRepository.createCandidateAnalysis({
    jobId: job.id,
    reference,
    attemptId: attempt?.id ?? null,
    snapshot,
    snapshotHash,
  });

  // Delivery strictly AFTER commit: the rows are already durably PENDING in
  // PostgreSQL, and BullMQ only ever receives the AiJob id. The initial state
  // notification is also after commit and deliberately fire-and-forget; even a
  // Redis outage never rolls back or delays the already-committed request.
  void realtimePublisher.publishCandidateAnalysisUpdatedEvent({
    jobId: job.id,
    referenceId: analysis.referenceId,
    analysisId: analysis.id,
    analysisVersion: analysis.analysisVersion,
    status: aiJob.status,
    updatedAt: aiJob.updatedAt,
  });
  await enqueueAiJobDelivery(job, aiJob);

  return {
    analysis: sanitizeAnalysis(analysis),
    aiJob: { id: aiJob.id, operation: aiJob.operation, status: aiJob.status },
  };
};

// ---------------------------------------------------------------------------
// AUTOMATIC candidate analysis — the SYSTEM workflow
// ---------------------------------------------------------------------------
// The recruiter never starts candidate analysis. The SYSTEM does, and it does so
// at the one authoritative moment: an assessment attempt has just been COMMITTED
// into a terminal state by the existing assessment lifecycle —
//   SUBMITTED  (the candidate finished; the server already persisted the score)
//   TIMED_UP   (the deadline closed the attempt, lazily, per existing rules)
//   CHEATED    (the deterministic integrity termination)
// The caller passes the COMMITTED attempt row, so this can only run once the
// attempt and its authoritative score exist in PostgreSQL. It is never called on
// upload, on invitation, on email verification or on assessment start, so the
// analysis is never created before the assessment is authoritative.
//
// Only the attempt's IDENTITY is required: the committed row is re-read below, so a
// caller that passes just { id, jobId, assessmentId, email, status } still produces a
// snapshot carrying the authoritative persisted score.
//
// Everything after the trigger point is the EXISTING Phase 7 pipeline: one
// PostgreSQL transaction writes the CANDIDATE_ANALYSIS AiJob + the analysis row,
// the existing BullMQ delivery hands over the AiJob id, the existing Node worker
// calls the existing FastAPI candidate-analysis route, the result is persisted on
// the same row, and the existing Redis Pub/Sub emits the same
// CANDIDATE_ANALYSIS_UPDATED SSE event the recruiter dashboard already consumes.
//
// Idempotent by design: a terminal attempt is terminal, so this runs once per
// attempt. Even if it were reached twice, the guard below skips an attempt that
// already has an analysis, and the repository refuses a second concurrent run for
// the same candidate.
// Terminal attempt states that make an assessment authoritative. SUBMITTED is
// the normal path; TIMED_UP and CHEATED are the existing product rules for an
// attempt that closed without (or despite) a full submission, and the existing
// analysis contract already models all three.
const TERMINAL_ATTEMPT_STATUSES = new Set(["SUBMITTED", "TIMED_UP", "CHEATED"]);

const runAutomaticCandidateAnalysis = async (attempt) => {
  if (!attempt?.id || !attempt.jobId || !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    return { triggered: false, reason: "NOT_TERMINAL" };
  }
  // Never start analysis before the assessment is authoritative: without a
  // persisted assessment for this job there is nothing to analyze.
  if (!attempt.assessmentId) {
    return { triggered: false, reason: "NO_ASSESSMENT" };
  }

  const job = await jobRepository.findJobById(attempt.jobId);
  if (!job || job.status !== jobRepository.JOB_STATUS.ACTIVE) {
    return { triggered: false, reason: "JOB_NOT_ACTIVE" };
  }
  if (!job.assessment || job.assessment.id !== attempt.assessmentId) {
    return { triggered: false, reason: "JOB_ASSESSMENT_CHANGED" };
  }

  // An attempt that already produced an analysis is never re-analyzed: the
  // automatic workflow runs exactly once per terminal attempt.
  const existing = await jobCandidateReferenceRepository.findAnalysesByAttemptId(attempt.id);
  if (existing.length > 0) {
    return { triggered: false, reason: "ALREADY_ANALYZED" };
  }

  await seedReferencesFromStoredList(job);
  const email = jobCandidateReferenceRepository.normalizeEmail(attempt.email);
  const reference = (await jobCandidateReferenceRepository.findReferencesByJobId(job.id)).find(
    (row) => jobCandidateReferenceRepository.normalizeEmail(row.candidateEmail) === email
  );
  if (!reference) {
    return { triggered: false, reason: "NO_CANDIDATE_REFERENCE" };
  }

  const answers = await attemptRepository.findAnswersByAttempt(attempt.id);
  // Re-read the committed row instead of trusting the caller's object: the snapshot
  // must carry the authoritative score, which only PostgreSQL holds. Falls back to
  // the passed row only if it is already gone, so the guard above stays the truth.
  const committedAttempt = (await attemptRepository.findAttemptById(attempt.id)) ?? attempt;

  // A concurrent duplicate trigger loses the race inside the locked transaction
  // and surfaces as 409. That is the idempotent outcome, not a failure: the
  // terminal attempt already has its one automatic analysis, so the request that
  // lost must not surface an error to whoever triggered it.
  try {
    const result = await createAndDeliverCandidateAnalysis({ job, reference, attempt: committedAttempt, answers });
    return { triggered: true, ...result };
  } catch (error) {
    if (error?.status === 409) {
      return { triggered: false, reason: "ALREADY_ANALYZED" };
    }
    throw error;
  }
};

module.exports = {
  listCandidateReferences,
  listCandidateReferenceIdentities,
  getCandidateReference,
  updateCandidateReference,
  addManualCandidateReference,
  runAutomaticCandidateAnalysis,
  uploadCandidateResume,
  openCandidateResume,
  getCandidateAnalysis,
  hashCandidateAnalysisSnapshot,
};
