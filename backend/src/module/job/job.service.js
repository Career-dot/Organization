const { resolveSubscriptionAccess } = require("../subscription/subscription.service");
const { AI_QUEUE_UNAVAILABLE_CODE, enqueueAiJob } = require("../ai-job/aiJob.queue");
const { AI_JOB_OPERATION, AI_JOB_STATUS } = require("../ai-job/aiJob.repository");
const {
  createStoredFile,
  removeStoredFileContent,
  removeEmptyStoredFileDirectory,
} = require("../storage/storage.service");
const {
  CANDIDATE_LIST_MESSAGES,
  MAX_CANDIDATES,
  assertCandidateListUpload,
  candidateListError,
  // Phase 7 â€” ONE parse of the uploaded buffer now yields the whitelist
  // reference rows that seed JobCandidateReference inside the association
  // transaction (same core validation as before: limits, emails, duplicates).
  parseCandidateListReferenceRows,
  previewStoredCandidateList,
  readStoredCandidateListRows,
  validateStoredCandidateList,
} = require("./jobCandidateList.parser");
const jobRepository = require("./job.repository");
const jobCandidateRepository = require("./jobCandidate.repository");
const jobCandidateReferenceRepository = require("./jobCandidateReference.repository");
const { classifyCandidateRows } = require("./jobCandidate.classification");
// The ONE pure expiration decision layer. Every candidate-facing deadline in this
// service is derived here from a PERSISTED timestamp, never from a frontend
// countdown and never from a day-count table.
const {
  resolveJobExpiresAt,
  isJobExpired,
  resolveInvitationExpiresAt,
  isInvitationExpired,
} = require("./jobExpiration");
// The ONE authoritative tab-away threshold, imported (not copied) so the rules
// stated in the invitation email can never drift from the rule the server
// actually enforces. This module has no require cycle back into job.service.
const { MAX_VISIBILITY_HIDDEN_EVENTS } = require("./jobAssessmentIntegrity.service");
// PHASE 3 — the centralized ORG_ADMIN candidate-level privacy policy. Required here
// (the module that owns listJobCandidates + getCandidateVerificationReport) and
// deliberately dependency-free, so it can be imported by job.service, the overview
// service, the reference service, the attempt service and the SSE gateway without
// creating a require cycle.
const { assertCandidateLevelAccess } = require("./jobCandidatePrivacy");
const {
  getExistingVerifiedSkillScoresForUsers,
} = require("../assessment/verificationRead.service");
// Hard platform limits for the assessment stage (the ONE backend source of
// truth). Used by the Continue-time settings gate below.
const {
  MAX_ASSESSMENT_QUESTIONS,
} = require("./job.validation");
const crypto = require("node:crypto");
const { sendAssessmentInvitationEmail } = require("../../utils/sendAssessmentInvitationEmail");
const { sendAssessmentVerificationEmail } = require("../../utils/sendAssessmentVerificationEmail");
const { createIdempotentNotification } = require("../notification/notification.service");
const realtimePublisher = require("./jobAssessmentRealtime.publisher");

// Local helper so handlers can pick an HTTP status without this module
// needing a shared ApiError class (none exists in the codebase â€” same local
// pattern as subscription.service.js / organization.service.js).
const httpError = (status, message, extra) => {
  const error = new Error(message);
  error.status = status;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const MIN_START_DESCRIPTION_LENGTH = 20;
const MIN_ANALYSIS_DAYS = 1;
const MAX_ANALYSIS_DAYS = 10;

// Phase 2 — deployment cutoff for the structured-job Start rules. A job whose
// createdAt is at/after this UTC instant must carry the structured metadata
// (employmentType, workMode, plus a location whenever the mode is HYBRID or
// ON_SITE) before it can start; a job created before it is LEGACY and starts
// under the original rules forever, regardless of its structured fields.
//
// This constant is the ONE new-vs-legacy discriminator: never a schema column,
// never a guess from NULL fields. Set to the UTC start of the Phase 1/2
// deployment day; jobs created on that day land safely above it in this
// environment's clock. (createdAt is what PostgreSQL/Prisma report for the row.)
const STRUCTURED_JOB_CUTOFF = new Date("2026-10-07T00:00:00.000Z");
const isStructuredJob = (job) =>
  Boolean(job?.createdAt) && job.createdAt >= STRUCTURED_JOB_CUTOFF;



// Candidate-facing email normalization: invitations match case-insensitively
// because every stored and queried email is trimmed + lowercased first.
const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

// Email-verification challenge: 32 random bytes, base64url â€” unguessable, and
// only ever persisted as a SHA-256 hash next to the invitation it belongs to.
const VERIFICATION_TOKEN_TTL_MS = 15 * 60 * 1000;

const generateVerificationToken = () => crypto.randomBytes(32).toString("base64url");

const hashVerificationToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

// Single generic denial for EVERY failed candidate verification attempt
// (unknown link, inactive assessment, non-invited email, expired invitation,
// wrong/expired code). Distinguishing them would let anyone probe which
// emails are invited â€” the one uniform response reveals nothing.
const assessmentAccessDenied = () =>
  httpError(403, "This email cannot access this assessment right now.");

// ---------------------------------------------------------------------------
// Scope & ownership
// ---------------------------------------------------------------------------

// Drafts deliberately do NOT require access.allowed: creating/saving a draft
// is free and must keep working even when a subscription has lapsed. Only
// Start requires a usable subscription. Ownership, however, must always be
// resolvable â€” a job belongs either to an independent recruiter or to the
// caller's ACTIVE organization (D8), never to a client-supplied id.
const assertJobScope = (access) => {
  if (access.scope === "bypass") {
    // D2: SUPER_ADMIN has no real subscription/quota semantics.
    throw httpError(403, "Platform administrator accounts cannot own or start jobs");
  }

  if (access.scope === "none") {
    throw httpError(403, "Job ownership could not be resolved for this account");
  }

  if (access.scope === "organization" && !access.organizationId) {
    // ORG_ADMIN without an ACTIVE membership has no organization to own jobs.
    throw httpError(403, "No active organization membership found for this account");
  }
};

const buildOwnershipData = (user, access) => {
  if (access.scope === "user") {
    return { recruiterId: user.id, organizationId: null, createdByUserId: user.id };
  }
  return { recruiterId: null, organizationId: access.organizationId, createdByUserId: user.id };
};

const assertJobAccess = (job, user, access) => {
  if (access.scope === "user" && job.recruiterId !== user.id) {
    throw httpError(403, "You do not have access to this job");
  }

  if (access.scope === "organization" && job.organizationId !== access.organizationId) {
    throw httpError(403, "You do not have access to this job");
  }
};

const requireOwnedJob = async (user, access, jobId) => {
  const job = await jobRepository.findJobById(jobId);

  if (!job) {
    throw httpError(404, "Job not found");
  }

  assertJobAccess(job, user, access);
  return job;
};

// Phase 7 â€” the ONE composite authorization gate every candidate-reference
// entry point uses: subscription scope resolution (same as every other job
// write) chained with the ownership check. Exported so
// jobCandidateReference.service never reimplements the chain â€” there is
// exactly one definition of "may this caller act on this job".
const requireAuthorizedJob = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);
  return requireOwnedJob(user, access, jobId);
};

// A client-supplied organization parameter is only honored when it matches
// the caller's own ACTIVE membership â€” it is never an ownership source (D8).
const assertOrganizationParam = (access, organizationId) => {
  if (access.scope !== "organization" || access.organizationId !== organizationId) {
    throw httpError(403, "You do not have access to this organization");
  }
};

// JobQuotaConsumption is internal ledger data (it carries subscription ids)
// and is never sent to clients. The AI workflow relations (aiJobs /
// clarificationQuestions / assessment) are detail-read-only state and never
// leak into draft/create/start responses either.
const sanitizeJob = (job) => {
  if (!job) {
    return job;
  }
  const { quotaConsumption, aiJobs, clarificationQuestions, assessment, ...rest } = job;
  return rest;
};

// Only the client-facing identity of the AI job is exposed. requestPayload is
// the AI input snapshot and the remaining columns (attempts, lastError,
// provider, workerId, timestamps, result) are worker bookkeeping â€” none of them
// are part of the Stage 1 Start contract.
const sanitizeAiJob = (aiJob) => {
  if (!aiJob) {
    return aiJob;
  }
  return {
    id: aiJob.id,
    operation: aiJob.operation,
    status: aiJob.status,
  };
};

// Detail-read projection of one AiJob row: status fields plus the normalized
// internal error code only. lastError is a stable code (the worker never
// stores provider text), so it is safe and necessary for the recruiter-facing
// failure state; requestPayload/result NEVER leave the server â€” their
// client-facing copies are the clarification rows and the materialized
// assessment.
const sanitizeAiJobDetail = (aiJob) => ({
  id: aiJob.id,
  operation: aiJob.operation,
  status: aiJob.status,
  lastError: aiJob.lastError ?? null,
  completedAt: aiJob.completedAt ?? null,
});

const sanitizeJobDetail = (job) => {
  if (!job) {
    return job;
  }
  const { quotaConsumption, aiJobs, ...rest } = job;
  return { ...rest, aiJobs: (aiJobs ?? []).map(sanitizeAiJobDetail) };
};

// ---------------------------------------------------------------------------
// Draft lifecycle
// ---------------------------------------------------------------------------

const createDraft = async (user, payload) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const ownership = buildOwnershipData(user, access);

  const job = await jobRepository.createJobWithChildren({
    data: {
      ...ownership,
      // status is intentionally not set here: the database default is DRAFT,
      // and drafts never consume quota.
      title: payload.title,
      yearsExperience: payload.yearsExperience ?? null,
      description: payload.description ?? null,
      analysisDays: payload.analysisDays ?? null,
      // Optional top-N preference. Free draft data: it never consumes quota and
      // never reaches the AI pipeline from here (the AiJob request snapshot is
      // built by Start, from the saved job).
      preferredCandidateCount: payload.preferredCandidateCount ?? null,
      // Recruiter assessment settings (the requested AI assessment shape and
      // the candidate timer). Optional, free draft data, bounded by the hard
      // platform limits in job.validation.js; they reach the AI only via the
      // frozen Start/Continue-time snapshot.
      assessmentQuestionCount: payload.assessmentQuestionCount ?? null,
      assessmentDurationSeconds: payload.assessmentDurationSeconds ?? null,
      // Phase 2 — structured job requirements. Optional free draft data: NULL
      // until provided, never required by draft creation, only gated at Start
      // for jobs created at/after STRUCTURED_JOB_CUTOFF.
      employmentType: payload.employmentType ?? null,
      workMode: payload.workMode ?? null,
      location: payload.location ?? null,
    },
    skills: payload.skills ?? [],
    tools: payload.tools ?? [],
    questions: payload.questions ?? [],
    responsibilities: payload.responsibilities ?? [],
    educationRequirements: payload.educationRequirements ?? [],
  });

  return sanitizeJob(job);
};

const updateDraft = async (user, jobId, payload) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);

  // D7: only DRAFT jobs are editable through the creation/update flow.
  if (job.status !== jobRepository.JOB_STATUS.DRAFT) {
    throw httpError(409, "Only draft jobs can be edited");
  }

  const scalarData = {};
  if (payload.title !== undefined) scalarData.title = payload.title;
  if (payload.yearsExperience !== undefined) scalarData.yearsExperience = payload.yearsExperience;
  if (payload.description !== undefined) scalarData.description = payload.description;
  if (payload.analysisDays !== undefined) scalarData.analysisDays = payload.analysisDays;
  // Optional preference: undefined = leave as-is, null = clear it. Like every
  // other draft edit this is a free action (no quota, no AiJob, no queue work).
  if (payload.preferredCandidateCount !== undefined) {
    scalarData.preferredCandidateCount = payload.preferredCandidateCount;
  }
  // Assessment settings: undefined = leave as-is, null = clear the setting.
  // Free draft data, bounded by the hard platform limits in job.validation.js.
  if (payload.assessmentQuestionCount !== undefined) {
    scalarData.assessmentQuestionCount = payload.assessmentQuestionCount;
  }
  if (payload.assessmentDurationSeconds !== undefined) {
    scalarData.assessmentDurationSeconds = payload.assessmentDurationSeconds;
  }
  // Phase 2 — structured metadata: undefined = leave as-is, null = clear it.
  // Same semantics as every other nullable draft scalar.
  if (payload.employmentType !== undefined) scalarData.employmentType = payload.employmentType;
  if (payload.workMode !== undefined) scalarData.workMode = payload.workMode;
  if (payload.location !== undefined) scalarData.location = payload.location;

  const children = {};
  if (payload.skills !== undefined) children.skills = payload.skills;
  if (payload.tools !== undefined) children.tools = payload.tools;
  if (payload.questions !== undefined) children.questions = payload.questions;
  // Phase 2 — replace-on-update child collections, identical semantics to
  // skills/tools/questions: present (even []) = replace wholesale inside the
  // SAME transaction; absent = untouched. Order comes from array position.
  if (payload.responsibilities !== undefined) children.responsibilities = payload.responsibilities;
  if (payload.educationRequirements !== undefined) {
    children.educationRequirements = payload.educationRequirements;
  }

  const updated = await jobRepository.updateJobWithChildren(jobId, scalarData, children);
  return sanitizeJob(updated);
};
// ---------------------------------------------------------------------------
// Start (the committed action)
// ---------------------------------------------------------------------------

// Start validates the SAVED job (not the request body): the recruiter may
// have saved a partial draft long before starting it.
const assertJobReadyToStart = (job) => {
  const problems = [];
  const skills = job.skills ?? [];

  if (!job.title || job.title.trim().length < 3) {
    problems.push("a title of at least 3 characters");
  }
  if (job.yearsExperience === null || job.yearsExperience === undefined) {
    problems.push("years of experience");
  }
  if (!job.description || job.description.trim().length < MIN_START_DESCRIPTION_LENGTH) {
    problems.push(`a description of at least ${MIN_START_DESCRIPTION_LENGTH} characters`);
  }
  if (skills.length === 0) {
    problems.push("at least one skill");
  }
  if (skills.length > 0 && skills.some((skill) => skill.weight < 1 || skill.weight > 100)) {
    problems.push("skill weights between 1 and 100");
  }
  if (skills.length > 0 && skills.reduce((total, skill) => total + skill.weight, 0) !== 100) {
    problems.push("skill weights totaling exactly 100");
  }
  if ((job.tools ?? []).length === 0) {
    problems.push("at least one tool or software entry");
  }
  if ((job.questions ?? []).length === 0) {
    problems.push("at least one job-related question");
  }
  if (
    job.analysisDays === null ||
    job.analysisDays === undefined ||
    job.analysisDays < MIN_ANALYSIS_DAYS ||
    job.analysisDays > MAX_ANALYSIS_DAYS
  ) {
    problems.push(`analysis days between ${MIN_ANALYSIS_DAYS} and ${MAX_ANALYSIS_DAYS}`);
  }

  // Phase 2 — structured-job Start rules. NEW jobs (createdAt at/after the
  // deployment cutoff) must carry the structured metadata; LEGACY jobs are
  // exempt and keep the original rules forever. Responsibilities and education
  // requirements are intentionally NOT Start blockers for any job. The cutoff
  // itself is server-side only and never appears in a client-facing message.
  if (isStructuredJob(job)) {
    if (!job.employmentType) {
      problems.push("an employment type");
    }
    if (!job.workMode) {
      problems.push("a work mode");
    }
    if ((job.workMode === "HYBRID" || job.workMode === "ON_SITE") && !job.location) {
      problems.push("a location for hybrid or on-site work");
    }
  }

  if (problems.length > 0) {
    throw httpError(400, `Job is not ready to start â€” it still needs ${problems.join(", ")}`);
  }
};

const startJob = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);

  if (job.status !== jobRepository.JOB_STATUS.DRAFT) {
    throw httpError(409, "Only draft jobs can be started");
  }

  assertJobReadyToStart(job);

  // Candidate Excel Sheet gate â€” strictly BEFORE the quota-consuming
  // transaction. Everything below (subscription resolution, quota lock,
  // DRAFTâ†’ACTIVE, JobQuotaConsumption, AiJob creation, BullMQ delivery) only
  // runs once the candidate file exists AND re-parses cleanly from the stored
  // bytes: 1..1000 candidates, valid emails, no case-insensitive duplicates.
  // Any failure here leaves the job DRAFT with quota, AiJob and queue
  // completely untouched, and the recruiter can fix the file and retry.
  //
  // preferredCandidateCount is deliberately NOT validated against the parsed
  // candidateCount here: it is a prioritization TARGET, not a limit. A job may
  // legitimately prefer 20 candidates out of a 100-row list, or prefer 50 while
  // only 12 rows were uploaded (then every uploaded candidate already fits the
  // target). The list stays complete and every candidate keeps its score, so
  // there is nothing to reject â€” the downstream ranking simply takes the top
  // min(preferred, eligible) candidates. Its structural bounds (whole number,
  // 1..1000) are enforced by job.validation.js on the draft write instead.
  const candidateList = await jobRepository.findCandidateListWithFile(jobId);
  if (!candidateList) {
    throw httpError(400, CANDIDATE_LIST_MESSAGES.REQUIRED);
  }
  await validateStoredCandidateList(candidateList.file);

  // Subscription resolution: independent recruiter â†’ personal subscription,
  // organization recruiter â†’ organization subscription. resolveSubscriptionAccess
  // derives this from the ACTIVE membership (never client input).
  if (!access.subscription) {
    throw httpError(402, "An active subscription is required to start a job");
  }

  // The resolver omits the plan for independent recruiters (an asymmetry in
  // the subscription module we deliberately do not modify), so re-fetch the
  // subscription with its plan by id before reading jobPostingLimit.
  const subscription = await jobRepository.getSubscriptionWithPlan(access.subscription.id);
  if (!subscription) {
    throw httpError(402, "An active subscription is required to start a job");
  }

  const limit = subscription.plan ? subscription.plan.jobPostingLimit ?? null : null;

  const startedAt = new Date();
  const analysisEndsAt = new Date(startedAt.getTime() + job.analysisDays * DAY_IN_MS);

  const owner =
    access.scope === "user"
      ? { ownerTable: "user", ownerId: user.id }
      : { ownerTable: "organization", ownerId: access.organizationId };

  const { job: startedJob, aiJob } = await jobRepository.startJobAtomically({
    jobId,
    subscriptionId: subscription.id,
    limit,
    startedAt,
    analysisEndsAt,
    ...owner,
  });

  // Delivery happens strictly AFTER the transaction above has committed: the
  // AiJob row is already durably PENDING in PostgreSQL, and BullMQ only ever
  // receives that row's id. A delivery failure therefore cannot invalidate the
  // committed Job/quota/AiJob state â€” it surfaces as a queue-unavailable
  // condition instead (see enqueueJobAnalysis).
  await enqueueJobAnalysis(startedJob, aiJob);

  const limits = await getJobLimits(user);
  return { job: sanitizeJob(startedJob), aiJob: sanitizeAiJob(aiJob), limits };
};

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

// Recruiter close: ACTIVE â†’ CLOSED with closedReason RECRUITER_CLOSED.
const closeJobAsRecruiter = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);

  const closedJob = await jobRepository.closeJobAtomically(
    job.id,
    jobRepository.JOB_CLOSED_REASON.RECRUITER_CLOSED
  );
  return sanitizeJob(closedJob);
};

// System close (future scheduler watching analysisEndsAt): ACTIVE â†’ CLOSED
// with closedReason SYSTEM_EXPIRED. No route exposes this in Phase 2.
const closeJobAsSystem = async (jobId) => {
  const job = await jobRepository.findJobById(jobId);
  if (!job) {
    throw httpError(404, "Job not found");
  }

  const closedJob = await jobRepository.closeJobAtomically(
    jobId,
    jobRepository.JOB_CLOSED_REASON.SYSTEM_EXPIRED
  );
  return sanitizeJob(closedJob);
};

// ---------------------------------------------------------------------------
// THE AUTOMATIC EXPIRATION SWEEP
//
// This is the server-authoritative half of job expiration. It needs no browser,
// no open dashboard, no page refresh and no recruiter click: the moment a job's
// PERSISTED deadline (Job.analysisEndsAt) has passed, the next sweep closes it.
//
// DESIGN (each point is a stated requirement, not a preference):
//   * PERSISTED STATE ONLY  - candidates to close are found by querying
//     analysisEndsAt. Nothing is remembered between runs, so a restart loses
//     nothing and a second instance does identical work.
//   * IDEMPOTENT            - the ACTIVE -> CLOSED write is a compare-and-swap.
//     A repeat tick, a duplicated schedule or a second instance updates 0 rows
//     and simply does nothing.
//   * SAFE UNDER RESTARTS   - a job closed by a previous process is already
//     CLOSED, so it is never re-processed and never double-notified.
//   * NON-DESTRUCTIVE       - nothing is deleted. The job, its candidate list,
//     invitations, attempts, answers, scores, analyses and reports all survive
//     and stay readable by the recruiter.
//   * AFTER COMMIT          - the recruiter's realtime event and notification
//     are published only once the row has actually committed CLOSED.
// ---------------------------------------------------------------------------
const runExpirationSweep = async ({ now = new Date() } = {}) => {
  const expired = await jobRepository.findExpiredActiveJobs(now);
  const closed = [];

  for (const job of expired) {
    // The CAS is the only thing that decides the winner. A loser moves on
    // without notifying, so exactly one recruiter notification is ever created
    // per job - even if two instances sweep the same row at the same instant.
    // eslint-disable-next-line no-await-in-loop
    const won = await jobRepository.closeExpiredJobAtomically(job.id, now);
    if (won !== 1) {
      continue;
    }
    closed.push(job);

    // AFTER COMMIT. The realtime publish is fire-and-forget (Redis can never
    // fail or delay this loop), and the notification is best-effort: a
    // notification failure must not roll back or block the other jobs.
    // eslint-disable-next-line no-await-in-loop
    realtimePublisher.publishJobExpiredEvent({ jobId: job.id, closedAt: now });
    // eslint-disable-next-line no-await-in-loop
    await notifyRecruiterOfExpiredJob(job, now).catch((error) => {
      console.error(
        `[job-expiration] recruiter notification failed for job ${job.id}: ${error.message}`
      );
    });
  }

  if (closed.length > 0) {
    console.log(
      `[job-expiration] closed ${closed.length} expired job${closed.length === 1 ? "" : "s"}`
    );
  }
  return { closed: closed.map((job) => job.id), scanned: expired.length };
};

// The recruiter is told, through the EXISTING notification service, exactly
// which job expired and when. The link points at the recruiter's own job page -
// never a candidate assessment link - and idempotency comes from the
// notification service's own (userId, link) de-duplication, so a second sweep
// can never produce a second copy.
const notifyRecruiterOfExpiredJob = async (job, now) => {
  const owner = await jobRepository.findJobNotificationOwner(job.id);
  if (!owner || !owner.userId) {
    return null;
  }
  return createIdempotentNotification({
    userId: owner.userId,
    title: "Job expired and closed",
    message:
      `The job "${job.title}" reached the end of its availability window and was ` +
      `closed automatically on ${new Date(now).toUTCString()}. ` +
      "Its candidate invitations are now closed and no new assessment activity can " +
      "start. Existing results, scores and reports are preserved.",
    type: "JOB_EXPIRED",
    link: `/recruiter/jobs/${job.id}`,
  });
};
// ---------------------------------------------------------------------------
// Candidate Excel Sheet (draft attachment)
// ---------------------------------------------------------------------------
// The candidate list is REQUIRED before Start, but it is draft data: upload,
// replace and remove are free actions that never consume quota and never touch
// the AI pipeline. File bytes are persisted through the existing storage
// module (StoredFile, category JOB_CANDIDATE_LIST); JobCandidateList is the
// durable Jobâ†”file association. Validation ALWAYS runs before persistence:
// a rejected file leaves zero rows, zero disk writes and unchanged quota.
const assertCandidateListEditable = (job) => {
  if (job.status !== jobRepository.JOB_STATUS.DRAFT) {
    throw httpError(409, "Only draft jobs can have their candidate list changed");
  }
};

// Best-effort disk cleanup, run only AFTER the database state is final. A
// cleanup failure is logged, never propagated: the association is already
// correct, so a stray file must not fail the recruiter's request.
const cleanupStoredCandidateFile = async (storagePath) => {
  if (!storagePath) {
    return;
  }
  try {
    await removeStoredFileContent(storagePath);
    await removeEmptyStoredFileDirectory(storagePath);
  } catch (error) {
    console.error(`[job] failed to remove candidate list file content: ${error.message}`);
  }
};

const uploadCandidateList = async (user, jobId, file) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertCandidateListEditable(job);

  // Boundary + content validation BEFORE any persistence: a wrong file type,
  // more than 1,000 candidates, duplicate emails or an unreadable workbook
  // never create rows and never write disk content. The reference-row parse
  // shares the SAME core, so this single call replaces the old buffer parse
  // without changing any validation message or rule.
  assertCandidateListUpload(file);
  const { candidateCount, rows: referenceRows } = parseCandidateListReferenceRows(file.buffer);

  // The StoredFile is owned by the uploading recruiter account, mirroring the
  // storage module's role-based ownership rule. The JOB association lives in
  // JobCandidateList, so authorization always flows through the job ownership
  // checks above â€” never through file ownership.
  const storedFile = await createStoredFile({
    userId: user.id,
    ownerId: user.id,
    role: user.role,
    ownerType: "RECRUITER",
    category: "JOB_CANDIDATE_LIST",
    file,
  });

  try {
    // Phase 7 â€” reference seeding commits in the SAME transaction as the file
    // association: seed-if-absent only (skipDuplicates on (jobId, email)), so
    // recruiter edits on existing references can never be reset by an import
    // or a replacement sheet, and a rejected upload seeds nothing.
    const { candidateList, previousStoragePath, seededReferences } =
      await jobRepository.replaceJobCandidateList({
        jobId,
        fileId: storedFile.id,
        candidateCount,
        referenceRows,
        createdByUserId: user.id,
      });
    // Replace cleanup strictly after commit.
    await cleanupStoredCandidateFile(previousStoragePath);
    // Return the association WITH its StoredFile so the frontend can render the
    // file name immediately (without waiting for a separate re-read). This is a
    // client-safe projection: originalName is included, storagePath is not.
    const full = await jobRepository.findCandidateListWithFile(jobId);
    return full
      ? {
          id: full.id,
          candidateCount: full.candidateCount,
          createdAt: full.createdAt,
          file: full.file
            ? {
                id: full.file.id,
                originalName: full.file.originalName,
                mimeType: full.file.mimeType,
                fileSize: full.file.fileSize,
              }
            : null,
        }
      : null;
  } catch (error) {
    // The association failed: the just-uploaded StoredFile must not linger
    // (same cleanup contract as the storage module's own upload path).
    await jobRepository.deleteStoredFileById(storedFile.id).catch(() => {});
    await cleanupStoredCandidateFile(storedFile.storagePath);
    throw error;
  }
};

const deleteCandidateList = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertCandidateListEditable(job);

  const removed = await jobRepository.deleteJobCandidateList(jobId);
  if (removed) {
    await cleanupStoredCandidateFile(removed.storagePath);
  }
  return { deleted: true };
};

// Read-only compact preview of the job's candidate list. The file was already
// validated at upload, so this is a read path (no re-validation, no quota, no
// AiJob, no enqueue). It returns client-safe fields only: file name, total
// candidate count, and a capped number of rows (name + email) for the small
// on-card preview and the View modal. Missing/unreadable stored files are
// surfaced as a recruiter-facing error rather than crashing.
const getCandidateListPreview = async (user, jobId, limit = 5) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  // Ownership + org-scope are verified here; the job row itself does not
  // include the candidateList relation (findJobById is lean), so we read the
  // association explicitly below.
  await requireOwnedJob(user, access, jobId);

  const candidateList = await jobRepository.findCandidateListWithFile(jobId);
  if (!candidateList || !candidateList.file) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.REQUIRED);
  }

  const preview = await previewStoredCandidateList(candidateList.file, limit);

  return {
    fileName: candidateList.file.originalName,
    candidateCount: candidateList.candidateCount,
    rows: preview.rows,
  };
};

// ---------------------------------------------------------------------------
// Recruiter candidate workflow â€” Phase 1: classification + existing score
// ---------------------------------------------------------------------------
// Backend-authoritative classification of the job's PERSISTED candidate list
// (the recruiter's Excel file â€” there is no second candidate source). Every
// candidate row is classified IN_SYSTEM / NOT_IN_SYSTEM by the platform, and
// an in-system candidate's EXISTING verified skill score is projected for
// display only.
//
// This read path is deliberately inert:
//   * it never starts, re-runs or reinterprets a skill verification,
//   * it never fetches LinkedIn/GitHub/project evidence,
//   * it never calls the AI service or enqueues an AiJob,
//   * it never writes candidate, verification or assessment data.
// The in-system score shown to the recruiter is read from the ALREADY persisted
// verification reports (see verificationRead.service) and stays clearly
// separate from the assessment score and the final AI analysis, neither of
// which exist at this stage.
const MAX_CANDIDATE_WORKFLOW_ROWS = MAX_CANDIDATES;

const clampCandidateRowLimit = (limit) => {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed)) {
    return MAX_CANDIDATE_WORKFLOW_ROWS;
  }
  return Math.min(Math.max(parsed, 1), MAX_CANDIDATE_WORKFLOW_ROWS);
};

// ---------------------------------------------------------------------------
// THE ONE candidate classification entry point (Excel AND manual add)
// ---------------------------------------------------------------------------
// Both candidate entry points â€” the recruiter's uploaded Excel list and the
// manual "add candidate" route â€” funnel through classifyJobCandidates below,
// so the same email can never be classified two different ways:
//
//   normalize(email) â†’ find registered CANDIDATE (EMPLOYEE) account by
//   normalized email â†’ IN_SYSTEM / NOT_IN_SYSTEM
//
// It is a pure read: it resolves the platform accounts, projects each
// in-system candidate's EXISTING verified skill score, projects this job's
// existing invitation rows, and then hands everything to the pure classifier
// (jobCandidate.classification.js). Nothing here writes candidate, verification
// or assessment data, never calls AI and never enqueues work.
const classifyJobCandidates = async (jobId, rows) => {
  // One lookup for the distinct normalized emails of the whole set. Emails are
  // compared case-insensitively (the platform's normalization rule) and only
  // CANDIDATE (EMPLOYEE) accounts count as "in system".
  const normalizedEmails = [
    ...new Set(rows.map((row) => normalizeEmail(row?.email)).filter(Boolean)),
  ];
  const accounts = await jobCandidateRepository.findCandidateAccountsByEmails(normalizedEmails);
  const accountsByEmail = {};
  for (const account of accounts) {
    const key = normalizeEmail(account.email);
    if (!accountsByEmail[key]) {
      accountsByEmail[key] = { userId: account.id, status: account.status };
    }
  }

  // EXISTING verified skill scores â€” a read-only projection of already
  // persisted reports. No verification is triggered and no score is derived
  // from anything else.
  const candidateUserIds = [
    ...new Set(Object.values(accountsByEmail).map((account) => account.userId)),
  ];
  const verificationByUserId =
    candidateUserIds.length > 0
      ? await getExistingVerifiedSkillScoresForUsers(candidateUserIds)
      : {};

  // Existing invitations of THIS job's assessment (projection only). The
  // invitation lifecycle stays owned by the invitation service.
  const assessment = await jobCandidateRepository.findAssessmentSummaryByJobId(jobId);
  const invitations = assessment
    ? await jobCandidateRepository.findInvitationsByAssessmentId(assessment.id)
    : [];
  const invitationsByEmail = {};
  for (const invitation of invitations) {
    if (invitation.jobId && invitation.jobId !== jobId) {
      // Defense in depth: an invitation must never be reported for another job.
      continue;
    }
    invitationsByEmail[normalizeEmail(invitation.email)] = invitation;
  }

  const classification = classifyCandidateRows({
    rows,
    accountsByEmail,
    verificationByUserId,
    invitationsByEmail,
  });

  return { assessment, classification };
};

const listJobCandidates = async (user, jobId, { limit } = {}) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  // PHASE 3 — ACTIVE-job candidate privacy. The job is already organization-checked;
  // this gate runs BEFORE the candidate list is read, so a denied ORG_ADMIN request
  // never loads candidate rows. Recruiters are unaffected.
  assertCandidateLevelAccess(user, job);

  const candidateList = await jobRepository.findCandidateListWithFile(jobId);
  if (!candidateList || !candidateList.file) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.REQUIRED);
  }

  const rowLimit = clampCandidateRowLimit(limit);
  // ONE disk read of the stored sheet, unbounded: the same read supplies the
  // page that is returned AND the complete set of sheet addresses. Deciding
  // "is this reference in the sheet?" from the page alone would be wrong â€” with
  // `?limit=2` a 4-row sheet would make its own rows 3 and 4 look like manual
  // candidates and duplicate them in the listing.
  const storedRows = (
    await readStoredCandidateListRows(candidateList.file, MAX_CANDIDATE_WORKFLOW_ROWS)
  ).rows;
  const parsed = { rows: storedRows.slice(0, rowLimit) };
  const storedEmails = new Set(storedRows.map((row) => normalizeEmail(row.email)));

  const references = await jobCandidateReferenceRepository.findReferencesByJobId(jobId);
  const referenceByEmail = new Map(
    references.map((reference) => [normalizeEmail(reference.candidateEmail), reference])
  );
  const analysisByReferenceId = new Map(
    (await jobCandidateReferenceRepository.findLatestAnalysisSummariesByJobId(jobId)).map(
      (analysis) => [analysis.referenceId, analysis]
    )
  );

  // A candidate the recruiter added MANUALLY has no Excel row: its persisted
  // job-scoped reference is its only record. Those references are appended to
  // the same row set and therefore run through the SAME classifier below, so
  // the manual path cannot drift from the Excel path â€” it is literally the same
  // call with the same inputs.
  const manualRows = references
    .filter((reference) => {
      const email = normalizeEmail(reference.candidateEmail);
      return email && !storedEmails.has(email);
    })
    .map((reference) => ({
      // A manual candidate has no spreadsheet row identity: id/rowIndex stay
      // null and the opaque referenceId is its stable identity.
      rowIndex: null,
      name: reference.candidateName ?? null,
      email: reference.candidateEmail,
    }));

  const { assessment, classification } = await classifyJobCandidates(jobId, [
    ...parsed.rows,
    ...manualRows,
  ]);

  // The safe candidate DTO. Only fields already approved by the candidate
  // workflow leave the server: the backend-derived classification, the
  // informational existing platform score, the persisted invitation
  // projection and the job-scoped reference/analysis metadata. The raw Prisma
  // User row is never spread in, so no password, token, subscription or other
  // private account data can escape through it.
  const candidates = classification.candidates.map((candidate) => {
    const reference = referenceByEmail.get(normalizeEmail(candidate.email)) ?? null;
    const analysis = reference ? analysisByReferenceId.get(reference.id) ?? null : null;
    return {
      ...candidate,
      referenceId: reference?.id ?? null,
      preferredRole: reference?.preferredRole ?? null,
      skills: Array.isArray(reference?.skills) ? reference.skills : [],
      skillNotes: reference?.skillNotes ?? null,
      linkedinUrl: reference?.linkedinUrl ?? null,
      githubUrl: reference?.githubUrl ?? null,
      hasResume: Boolean(reference?.resumeFileId),
      resumeTextAvailable: Boolean(reference?.resumeText),
      analysis: analysis
        ? {
            analysisId: analysis.id,
            aiJobId: analysis.aiJobId,
            analysisVersion: analysis.analysisVersion,
            status: analysis.aiJob.status,
            createdAt: analysis.createdAt,
            updatedAt: analysis.updatedAt,
            completedAt: analysis.completedAt,
          }
        : null,
    };
  });

  return {
    jobId,
    candidateList: {
      id: candidateList.id,
      candidateCount: candidateList.candidateCount,
      createdAt: candidateList.createdAt,
      file: candidateList.file
        ? {
            id: candidateList.file.id,
            originalName: candidateList.file.originalName,
            mimeType: candidateList.file.mimeType,
            fileSize: candidateList.file.fileSize,
          }
        : null,
    },
    assessment: assessment
      ? {
          id: assessment.id,
          title: assessment.title,
          status: assessment.status,
          durationSeconds: assessment.durationSeconds,
          finalizedAt: assessment.finalizedAt,
          activatedAt: assessment.activatedAt,
        }
      : null,
    candidates,
    summary: { ...classification.summary, rowsReturned: parsed.rows.length, rowLimit },
    availableCandidateFields: {
      ...classification.availableCandidateFields,
      preferredRole: candidates.some((candidate) => candidate.preferredRole),
      skills: candidates.some((candidate) => candidate.skills.length > 0),
      skillNotes: candidates.some((candidate) => candidate.skillNotes),
      resumeReference: candidates.some((candidate) => candidate.hasResume),
      linkedinReference: candidates.some((candidate) => candidate.linkedinUrl),
      githubReference: candidates.some((candidate) => candidate.githubUrl),
    },
    // Where the informational platform score comes from â€” never the assessment
    // score, never the AI analysis.
    existingVerifiedSkillScoreSource: "STORED_PLATFORM_VERIFICATION_REPORTS",
  };
};

// ---------------------------------------------------------------------------
// Verification report â€” recruiter read for ONE candidate of THEIR OWN job
// ---------------------------------------------------------------------------
// GET /:jobId/candidates/:referenceId/verification-report. The recruiter UI
// calls this only after the recruiter clicks "View Report" on an IN SYSTEM row
// of the candidate table â€” the report is fetched on demand and rendered in a
// secondary modal, never embedded in the table itself.
//
// Guards, in order:
//   * job ownership â€” the same resolveSubscriptionAccess + requireOwnedJob
//     chain every other job read uses (the route adds the recruiter/org-admin
//     authorize gate);
//   * (jobId, referenceId) resolution â€” a reference of another job does not
//     resolve and answers 404;
//   * IN_SYSTEM only â€” the reference's email must belong to a registered
//     EMPLOYEE (candidate) account, resolved with the SAME account lookup the
//     classifier uses. A NOT_IN_SYSTEM candidate has no platform verification
//     history, so the endpoint answers 404 instead of inventing a report.
//
// The response is the safe verification projection ONLY: the stored headline
// score, the verified-skill count and the per-skill stored values (skill name,
// score, status, completedAt). It carries no resume, no invitation/attempt
// data, no candidate analysis and no raw account rows, and it never
// recomputes anything: no verification is started or repeated and no AI is
// called. This number is the platform verification score â€” it is not the
// assessment score, which lives only on the persisted attempt.
const getCandidateVerificationReport = async (user, jobId, referenceId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);
  const job = await requireOwnedJob(user, access, jobId);
  // PHASE 3 — a verification report is candidate-level evidence. Gated before the
  // reference / VerificationReport rows are loaded.
  assertCandidateLevelAccess(user, job);

  const reference = await jobCandidateReferenceRepository.findReferenceByIdInJob(
    jobId,
    referenceId
  );
  if (!reference) {
    throw httpError(404, "Candidate not found in this job's candidate list");
  }

  const email = normalizeEmail(reference.candidateEmail);
  const accounts = await jobCandidateRepository.findCandidateAccountsByEmails([email]);
  const account =
    accounts.find((candidate) => normalizeEmail(candidate.email) === email) ?? null;
  if (!account) {
    throw httpError(404, "No verification report exists for this candidate");
  }

  const projection = await getExistingVerifiedSkillScoresForUsers([account.id]);
  const verification = projection[account.id] ?? null;

  return {
    referenceId: reference.id,
    candidateName: reference.candidateName ?? null,
    candidateEmail: email,
    systemStatus: "IN_SYSTEM",
    existingVerifiedSkillScore: verification?.existingVerifiedSkillScore ?? null,
    existingVerifiedSkillCount: verification?.verifiedSkillCount ?? 0,
    verifiedSkills: (verification?.verifiedSkills ?? []).map((skill) => ({
      skillName: skill.skillName ?? null,
      score: skill.score,
      verificationStatus: skill.verificationStatus ?? null,
      confidenceScore: skill.confidenceScore ?? null,
      completedAt: skill.completedAt ?? null,
      aiSummary: skill.aiSummary ?? null,
      strengths: skill.strengths ?? [],
      areasToImprove: skill.areasToImprove ?? [],
    })),
    existingVerifiedSkillScoreSource: "STORED_PLATFORM_VERIFICATION_REPORTS",
  };
};

// ---------------------------------------------------------------------------
// A recruiter can add a candidate the uploaded sheet happens to be missing is
// handled in jobCandidateReference.service.js, beside the reference model it writes
// to (addManualCandidateReference) - the same place as resume upload and reference
// editing, so a manually added candidate is literally the same kind of row as an
// imported one.
// ---------------------------------------------------------------------------


const getJobForUser = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);

  // First read after the analysis completes materializes the recruiter-editable
  // clarification rows from the durable AI result. Idempotent and race-safe, so
  // refreshing can never duplicate or lose them, and a result written by the
  // worker is never lost just because no one has opened the page yet.
  await jobRepository.seedClarificationQuestions(job.id);

  const detail = await jobRepository.findJobById(jobId);
  return sanitizeJobDetail(detail);
};

// Independent/recruiter job listing. Ownership is always derived from the
// authenticated principal (D8) â€” never from a client-supplied organizationId.
const listJobsForUser = async (user, pagination) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const { recruiterId } = buildOwnershipData(user, access);
  const { jobs, total } = await jobRepository.listJobsByRecruiter(recruiterId, pagination);
  return { jobs: jobs.map(sanitizeJob), total };
};

const listOrganizationJobs = async (user, organizationId, pagination) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);
  assertOrganizationParam(access, organizationId);

  const { jobs, total } = await jobRepository.listJobsByOrganization(
    organizationId,
    pagination
  );
  return { jobs: jobs.map(sanitizeJob), total };
};

// A recruiter's job-posting quota. Drafts are free; only Start consumes a slot,
// and this projection is what the dashboard/banner reads.
const NO_SUBSCRIPTION_LIMITS = {
  allowed: false,
  reason: "No active subscription",
  limit: null,
  used: 0,
  remaining: null,
};

const getJobLimits = async (user) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  if (access.scope === "bypass") {
    return {
      allowed: true,
      reason: "Platform administrators are not subject to job quotas",
      limit: null,
      used: 0,
      remaining: null,
    };
  }

  if (!access.subscription) {
    return { ...NO_SUBSCRIPTION_LIMITS };
  }

  const subscription = await jobRepository.getSubscriptionWithPlan(access.subscription.id);
  if (!subscription) {
    return { ...NO_SUBSCRIPTION_LIMITS };
  }

  const limit = subscription.plan ? subscription.plan.jobPostingLimit ?? null : null;
  const used = await jobRepository.countQuotaConsumptions(subscription.id);
  const remaining = limit === null ? null : Math.max(limit - used, 0);
  const allowed = access.allowed && (limit === null || remaining > 0);

  let reason;
  if (!access.allowed) {
    reason = "Subscription is not active or has expired";
  } else if (limit === null) {
    reason = "Unlimited job postings on this plan";
  } else if (remaining > 0) {
    reason = "Job quota available";
  } else {
    reason = "Job quota exhausted";
  }

  return { allowed, reason, limit, used, remaining };
};

const getOrganizationLimits = async (user, organizationId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);
  assertOrganizationParam(access, organizationId);

  return getJobLimits(user);
};

// ---------------------------------------------------------------------------
// AI queue delivery (Stage 2)
// ---------------------------------------------------------------------------
// The durable half is Stage 1: startJob's transaction writes the AiJob row as
// PENDING inside the same transaction that consumes quota and flips the job to
// ACTIVE. This function is the DELIVERY half â€” it hands that row's id to BullMQ
// so the separate AI worker process (src/ai-worker.js) can pick it up.
//
// Transaction boundary â€” this must only ever run AFTER the PostgreSQL
// transaction has committed:
//
//   BEGIN â†’ Job ACTIVE + quota + AiJob PENDING â†’ COMMIT â†’ enqueue (here)
//
// There is NO distributed PostgreSQL/Redis transaction, and none is attempted.
// If the commit succeeded and delivery fails, the committed rows stand and the
// AiJob simply stays PENDING: the caller reports a queue-unavailable condition
// (425) instead of pretending the analysis is on its way. Nothing is rolled
// back, no quota is re-consumed, no AiJob is deleted or recreated, and no
// COMPLETED status is faked. The PENDING row is the recovery anchor a later
// reconciliation/re-enqueue pass uses.
const enqueueAiJobDelivery = async (job, aiJob) => {
  try {
    return await enqueueAiJob(aiJob.id);
  } catch (error) {
    if (error.code !== AI_QUEUE_UNAVAILABLE_CODE) {
      throw error;
    }

    // Attach the durable facts: the database side succeeded even though
    // delivery did not. (The job controller renders { success, message } for
    // error responses, so these fields serve callers, logs and tests rather
    // than the HTTP body.)
    error.jobId = job.id;
    error.aiJobId = aiJob.id;
    error.aiJobStatus = aiJob.status;
    error.queued = false;

    console.error(
      `[job] queue delivery failed for AiJob ${aiJob.id} (job ${job.id}, ${aiJob.operation}); AiJob stays ${aiJob.status}: ${error.cause?.message ?? error.message}`
    );

    throw error;
  }
};

const enqueueJobAnalysis = (job, aiJob) => enqueueAiJobDelivery(job, aiJob);

// Same delivery semantics as the analysis operation: the assessment row is
// already durably PENDING in PostgreSQL when this runs, so a Redis outage is a
// 425 delivery condition, never a rollback and never a fake state.
const enqueueAssessmentGeneration = (job, aiJob) => enqueueAiJobDelivery(job, aiJob);

// ---------------------------------------------------------------------------
// AI workflow: analysis â†’ clarification questions â†’ assessment â†’ link
// ---------------------------------------------------------------------------
// Every action here is a FREE action: the only quota consumption in the entire
// recruiter workflow remains the one Job Start already made. None of these
// functions touch JobQuotaConsumption, the subscription or any quota counter.
// All durable state lives in PostgreSQL (JobClarificationQuestion rows,
// JobAssessment rows, Job.clarificationsApprovedAt, AiJob rows) â€” a browser
// refresh at any point can never lose recruiter work.

// ACTIVE is the working state for every AI-workflow write. CLOSED jobs are
// terminal and read-only (consistent with the rest of the job lifecycle);
// DRAFT jobs have no AI state at all.
//
// The availability window is enforced HERE, on the persisted deadline, in
// addition to the status column. The status is only eventually consistent with
// the deadline (a background sweeper performs the ACTIVE -> CLOSED transition),
// so a job can still read ACTIVE for a short window after its deadline passed.
// Refusing that window here means no new candidate activity — or any other
// workflow write — can slip through before the sweeper happens to run.
const assertAiWorkflowAvailable = (job) => {
  if (job.status !== jobRepository.JOB_STATUS.ACTIVE) {
    throw httpError(409, "Only active jobs can use the AI analysis workflow");
  }
  if (isJobExpired(job, new Date())) {
    throw httpError(409, "This job's availability window has ended, so it can no longer be changed or extended");
  }
};

const requireApprovedAnalysis = async (jobId) => {
  const analysis = await jobRepository.findAiJobByOperation(jobId, AI_JOB_OPERATION.JOB_ANALYSIS);
  if (!analysis) {
    throw httpError(409, "The AI job analysis has not started yet");
  }
  if (analysis.status !== AI_JOB_STATUS.COMPLETED) {
    throw httpError(
      409,
      analysis.status === AI_JOB_STATUS.FAILED
        ? "The AI job analysis failed â€” the job and its data are safe, but this stage cannot continue until the analysis succeeds"
        : "The AI job analysis is still in progress"
    );
  }
  return analysis;
};

// Recruiter edits over the seeded clarification questions. Full-list PATCH:
// the body must reference exactly the job's rows (ids set-equal), so a
// question can never be silently discarded. Locks permanently once the
// recruiter approves (Continue) â€” the approved set is what assessment
// generation is built from.
const updateClarificationQuestions = async (user, jobId, payload) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertAiWorkflowAvailable(job);

  if (job.clarificationsApprovedAt) {
    throw httpError(409, "Clarification questions are locked â€” the assessment stage has already been continued");
  }

  const rows = job.clarificationQuestions ?? [];
  const provided = payload.questions;
  if (provided.length > 0 || rows.length > 0) {
    const rowIds = rows.map((row) => row.id).sort();
    const providedIds = provided.map((item) => item.id).sort();
    if (rows.length === 0 || rowIds.join(",") !== providedIds.join(",")) {
      throw httpError(400, "Clarification questions must include every existing question exactly once");
    }
  }

  const questions = await jobRepository.updateClarificationQuestions(
    jobId,
    provided.map((item, index) => ({ ...item, sortOrder: index }))
  );
  return { questions };
};

// Hard platform rule for the assessment stage: a job can never request an
// assessment it cannot receive. Runs before the ASSESSMENT_GENERATION AiJob is
// created, so an impossible configuration fails loudly at Continue instead of
// becoming a terminal FAILED AI job later (the AI contract re-checks this on
// both the FastAPI and the Node side anyway).
const assertAssessmentSettingsSatisfiable = (job) => {
  const recruiterQuestionCount = (job.questions ?? []).length;
  if (recruiterQuestionCount > MAX_ASSESSMENT_QUESTIONS) {
    throw httpError(
      422,
      `This job has ${recruiterQuestionCount} job questions â€” an assessment can include at most ${MAX_ASSESSMENT_QUESTIONS}. Reduce the job questions before continuing.`
    );
  }
  const requested = job.assessmentQuestionCount;
  if (requested !== null && requested !== undefined && recruiterQuestionCount > requested) {
    throw httpError(
      422,
      `The requested assessment has ${requested} questions, but this job already has ${recruiterQuestionCount} mandatory job questions. Every job question is preserved, so the requested count must be at least ${recruiterQuestionCount}.`
    );
  }
};

// Edit & Continue. Approves the (possibly edited) clarification questions and
// creates the durable PENDING ASSESSMENT_GENERATION record in one committed
// transaction, then delivers it through the existing Stage 2/3 pipeline. The
// recruiter's approved list is frozen into the AI request snapshot exactly as
// it stands â€” questions are never regenerated here.
const continueClarifications = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertAiWorkflowAvailable(job);

  if (job.clarificationsApprovedAt) {
    throw httpError(409, "The clarification stage has already been continued");
  }

  await requireApprovedAnalysis(jobId);

  // Hard platform rule: request a question count that can actually receive
  // every mandatory recruiter question, and never exceed the platform max.
  // Must run BEFORE the ASSESSMENT_GENERATION AiJob is created, so an
  // impossible configuration fails loudly at Continue with 422 and no AiJob
  // is persisted. (FastAPI + Node validators re-check on the generated result
  // as an independent backstop.)
  assertAssessmentSettingsSatisfiable(job);

  // Snapshot the APPROVED state = the persisted (possibly recruiter-edited)
  // rows. Seeding first makes Continue correct even if the recruiter never
  // opened the job detail page before continuing.
  await jobRepository.seedClarificationQuestions(jobId);
  const withRows = await jobRepository.findJobById(jobId);
  const clarifications = (withRows.clarificationQuestions ?? []).map((row) => ({
    section: row.section,
    question: row.question,
  }));

  const approvedAt = new Date();
  const approved = await jobRepository.approveClarificationsAndCreateAssessmentJob({
    jobId,
    approvedAt,
    clarifications,
  });
  if (approved.error === "ALREADY_APPROVED") {
    throw httpError(409, "The clarification stage has already been continued");
  }
  if (approved.error === "JOB_NOT_FOUND") {
    throw httpError(404, "Job not found");
  }

  await enqueueAssessmentGeneration(approved.job, approved.aiJob);

  return {
    job: sanitizeJob(approved.job),
    aiJob: sanitizeAiJob(approved.aiJob),
    clarificationsApprovedAt: approvedAt.toISOString(),
  };
};

// Recruiter UPDATE over the generated DRAFT assessment: title/description and
// per-question content (prompt, points, difficulty). Full-list PATCH for
// questions (ids set-equal) â€” nothing is silently discarded. questionType and
// options are deliberately NOT editable: changing a question's shape would
// invalidate its options, and the generated type is what the candidate flow
// (next stage) will rely on.
const updateAssessment = async (user, jobId, payload) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertAiWorkflowAvailable(job);

  const assessment = await requireDraftAssessment(jobId);


  const data = {};
  if (payload.title !== undefined) {
    data.title = payload.title;
  }
  if (payload.description !== undefined) {
    data.description = payload.description;
  }
  if (payload.durationSeconds !== undefined) {
    data.durationSeconds = payload.durationSeconds;
  }

  let provided = payload.questions;
  if (provided !== undefined) {
    const rowIds = (assessment.questions ?? []).map((row) => row.id).sort();
    const providedIds = provided.map((item) => item.id).sort();
    if (rowIds.join(",") !== providedIds.join(",")) {
      throw httpError(400, "Assessment questions must include every existing question exactly once");
    }
  } else {
    provided = [];
  }

  const updated = await jobRepository.updateAssessmentContent(
    jobId,
    { data, questions: provided.map((item, index) => ({ ...item, sortOrder: index })) }
  );
  return { assessment: updated };
};

// DELETE removes the generated DRAFT assessment before finalization. Only the
// assessment and its questions are deleted â€” never the Job, never the
// candidate Excel list, never the quota ledger. Finalized assessments cannot
// be deleted (their link has already been issued).
const deleteAssessment = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertAiWorkflowAvailable(job);

  await requireDraftAssessment(jobId);

  await jobRepository.deleteAssessment(jobId);
  return { deleted: true };
};

// CONTINUE finalizes the draft assessment: DRAFT â†’ FINALIZED with the opaque
// publicId that identifies the assessment link. Idempotent-friendly: calling
// it again returns the finalized assessment unchanged (no error, no second
// link), so a retried click can never wedge the recruiter's screen. No quota
// is consumed and nothing is enqueued.
const finalizeAssessment = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertAiWorkflowAvailable(job);

  const assessment = await jobRepository.findAssessmentWithQuestions(jobId);
  if (!assessment) {
    throw httpError(404, "No assessment has been generated for this job yet");
  }

  if (assessment.status !== "DRAFT") {
    return { assessment, finalized: false };
  }

  const finalized = await jobRepository.finalizeAssessment({ assessmentId: assessment.id, jobId });
  if (!finalized) {
    // Lost the CAS race to a concurrent finalize â€” return the winner's state.
    const winner = await jobRepository.findAssessmentWithQuestions(jobId);
    return { assessment: winner, finalized: false };
  }

  const updated = await jobRepository.findAssessmentWithQuestions(jobId);
  return { assessment: updated, finalized: true };
};

const requireDraftAssessment = async (jobId) => {
  const assessment = await jobRepository.findAssessmentWithQuestions(jobId);
  if (!assessment) {
    throw httpError(404, "No assessment has been generated for this job yet");
  }
  if (assessment.status !== "DRAFT") {
    throw httpError(409, "A finalized assessment can no longer be edited or deleted");
  }
  return assessment;
};

// Candidate-facing read of a finalized assessment through its opaque public
// link segment. Deliberately unauthenticated: the link IS the capability in this
// stage (invitation authorization is a later stage's concern), and the response
// carries only what the candidate page renders â€” never recruiter/private data,
// AiJob internals or provider/model identity. Un-live links (unknown, malformed
// or still-DRAFT) resolve to 404 rather than leaking whether a draft exists.
const getAssessmentForCandidate = async (publicId) => {
  const assessment = await jobRepository.findFinalizedAssessmentByPublicId(publicId);
  if (!assessment) {
    throw httpError(404, "This assessment link is not available");
  }

  // The candidate is shown the assessment's own availability deadline and
  // whether it has already passed, read from the PERSISTED job timestamp. The
  // browser renders this as information; it never decides access from it — the
  // verification/attempt routes below are what authorize. The job's internal
  // lifecycle fields (closedReason, analysisDays, recruiter/org ownership) are
  // deliberately NOT projected here.
  const job = await jobRepository.findJobById(assessment.jobId);
  const expiresAt = resolveJobExpiresAt(job);
  const expired = Boolean(job && (job.status !== jobRepository.JOB_STATUS.ACTIVE || isJobExpired(job, new Date())));

  return {
    publicId: assessment.publicId,
    title: assessment.title,
    description: assessment.description,
    durationSeconds: assessment.durationSeconds,
    // The single candidate-visible deadline: the assessment becomes
    // unavailable at this instant. Absent only when the job has no configured
    // availability window at all.
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    expired,
    questions: assessment.questions.map((question) => ({
      section: question.section,
      prompt: question.prompt,
      questionType: question.questionType,
      points: question.points,
      difficulty: question.difficulty ?? null,
      options: Array.isArray(question.options) ? question.options : [],
      sortOrder: question.sortOrder,
    })),
  };
};

// ACTIVATE â€” the recruiter's confirmation that a FINALIZED assessment is open
// for invitations. Authenticated and job-owned; refused while DRAFT; CAS on
// (status=FINALIZED, activatedAt=null) makes duplicate activation idempotent
// â€” a repeated call returns the same assessment with activated:false and no
// second timestamp. Free action: no quota, nothing enqueued.
const activateAssessment = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertAiWorkflowAvailable(job);

  const assessment = await jobRepository.findAssessmentWithQuestions(jobId);
  if (!assessment) {
    throw httpError(404, "No assessment has been generated for this job yet");
  }
  if (assessment.status !== "FINALIZED") {
    throw httpError(409, "Finalize the assessment before activating it");
  }
  if (assessment.activatedAt) {
    return { assessment, activated: false };
  }

  const changed = await jobRepository.activateAssessment({ assessmentId: assessment.id, jobId });
  if (!changed) {
    // Lost the idempotency race to a concurrent activate â€” report the winner.
    const winner = await jobRepository.findAssessmentWithQuestions(jobId);
    return { assessment: winner, activated: false };
  }

  const updated = await jobRepository.findAssessmentWithQuestions(jobId);
  return { assessment: updated, activated: true };
};

// ---------------------------------------------------------------------------
// Recruiter candidate workflow â€” THE invitation action
// ---------------------------------------------------------------------------
// The recruiter clicks Invite on a row of THEIR OWN candidate list. That list is
// the single entry surface for every candidate: the uploaded Excel list and the
// manual "Add candidate" form both converge on one JobCandidateReference row
// (same seed-if-absent transaction, same classifier), so both kinds of row are
// addressed here identically.
//
// The candidate's email NEVER travels through the request. The backend resolves
// the row itself and takes the email from persisted data:
//   * `candidateId` = a non-negative integer â†’ the stored sheet's stable
//     rowIndex, re-read from the immutable JobCandidateList file;
//   * `candidateId` = a non-numeric opaque id â†’ the job-scoped
//     JobCandidateReference id, resolved INSIDE this job (a manually added
//     candidate has no spreadsheet row, so its reference id is its identity).
// A candidate list row id from another job does not resolve in either form.
//
// The invitation reuses the EXISTING JobAssessmentInvitation system â€” same
// (jobId, assessmentId, normalized email) triple, same unique constraint, same
// invitation-window mapping, same later email-verification flow. No AiJob, no
// quota, no assessment attempt, no candidate account creation and no
// verification recalculation ever happens here.
//
// WHAT THIS ACTION SENDS: the ASSESSMENT INVITATION EMAIL (the link). It
// deliberately does NOT generate, hash, store or email a verification code â€”
// that belongs to the candidate's own later VERIFICATION email, and only after
// the backend has authorized the submitted email against this persisted
// invitation. Sending a code here would email it before the candidate has
// proved anything, and would bypass the authorization check entirely.
// Idempotency â€” ONE assessment + ONE normalized email = ONE invitation:
//   * no invitation yet        â†’ create it, send the invitation email
//   * INVITED, window open     â†’ keep it, re-send the invitation email
//   * INVITED, window expired  â†’ extend the window through the SAME mapping and
//                                re-send (a re-invite, never a new row)
//   * EMAIL_VERIFIED           â†’ leave untouched, no email (nothing to send)
//
// Email failure: the database stays authoritative. The invitation row persists;
// the failure surfaces as a clear error stating the invitation WAS saved and
// Invite can be retried â€” the retry reuses the existing row instead of
// duplicating it.
const inviteJobCandidate = async (
  user,
  jobId,
  candidateIdRaw,
  { invitationEmailSender = sendAssessmentInvitationEmail } = {}
) => {
  const rawId = String(candidateIdRaw ?? "").trim();
  if (!rawId) {
    throw httpError(400, "A candidate row is required to send an invitation");
  }

  const access = await resolveSubscriptionAccess(user);
  assertJobScope(access);

  const job = await requireOwnedJob(user, access, jobId);
  assertAiWorkflowAvailable(job);

  // Candidate source of truth: PERSISTED candidate data owned by this job. The
  // request carries only the row identity, so an arbitrary email can never be
  // substituted â€” neither by the recruiter UI nor by anything calling the API
  // directly. Two accepted identities, because there are two candidate-entry
  // paths, and both converge on the same reference record:
  //   * an integer â†’ the stored sheet's stable rowIndex (Excel-imported row);
  //   * a cuid     â†’ the job-scoped JobCandidateReference id (a manually added
  //                  candidate has no spreadsheet row, so its reference id is
  //                  its identity).
  // Both are resolved INSIDE this job, so an id belonging to another job's
  // candidate list resolves to nothing and is a 404 in either form.
  const numericId = Number(rawId);
  const isSheetRowId = Number.isInteger(numericId) && numericId >= 0 && String(numericId) === rawId;

  let email;
  let rowName = null;
  let resolvedRowId = null;

  if (isSheetRowId) {
    const candidateList = await jobRepository.findCandidateListWithFile(jobId);
    if (!candidateList || !candidateList.file) {
      throw candidateListError(CANDIDATE_LIST_MESSAGES.REQUIRED);
    }
    const parsed = await readStoredCandidateListRows(
      candidateList.file,
      MAX_CANDIDATE_WORKFLOW_ROWS
    );
    const row = parsed.rows.find((entry) => entry.rowIndex === numericId);
    if (!row) {
      throw httpError(404, "Candidate not found in this job's candidate list");
    }
    email = normalizeEmail(row.email);
    rowName = row.name ?? null;
    resolvedRowId = numericId;
  } else {
    const reference = await jobCandidateReferenceRepository.findReferenceByIdInJob(jobId, rawId);
    if (!reference) {
      throw httpError(404, "Candidate not found in this job's candidate list");
    }
    email = jobCandidateReferenceRepository.normalizeEmail(reference.candidateEmail);
    rowName = reference.candidateName ?? null;
  }

  if (!email) {
    throw httpError(422, "This candidate has no usable email address");
  }

  // The assessment must exist, be FINALIZED and be ACTIVATED â€” exactly the
  // preconditions the existing manual invitation flow enforces.
  const assessment = await jobRepository.findAssessmentWithQuestions(jobId);
  if (!assessment) {
    throw httpError(404, "No assessment has been generated for this job yet");
  }
  if (assessment.status !== "FINALIZED") {
    throw httpError(409, "Finalize the assessment before inviting candidates");
  }
  if (!assessment.activatedAt) {
    throw httpError(409, "Activate the assessment before inviting candidates");
  }
  // Does this email belong to a platform CANDIDATE (EMPLOYEE) account?
  // Informational for the response and the gate for the in-system
  // notification â€” never an account-creation trigger.
  const candidateAccounts = await jobCandidateRepository.findCandidateAccountsByEmails([email]);
  const candidateAccount =
    candidateAccounts.find((account) => normalizeEmail(account.email) === email) ?? null;

  // Idempotent invitation: the (assessmentId, email) unique constraint plus
  // the pre-checks below make duplicate invitations impossible even under a
  // concurrent double-click.
  const existing = await jobRepository.findInvitationByAssessmentAndEmail(assessment.id, email);
  // THE invitation deadline, derived from the job's OWN persisted expiration:
  //     invitationExpiresAt = jobExpiration - 1 day
  // Computed from `job.analysisEndsAt` (written at Start) and never from the
  // invitation moment plus a day-count table, so a candidate can never be handed
  // a link that outlives its own job. Recomputed identically for a re-invite,
  // which keeps a refreshed window on exactly the same rule.
  const invitationExpiresAt = resolveInvitationExpiresAt(job, new Date());

  let invitation = existing;
  const alreadyExisted = Boolean(existing);
  let reactivated = false;

  if (!existing) {
    await jobRepository.createAssessmentInvitations([
      {
        jobId: job.id,
        assessmentId: assessment.id,
        email,
        status: "INVITED",
        expiresAt: invitationExpiresAt,
      },
    ]);
    invitation = await jobRepository.findInvitationByAssessmentAndEmail(assessment.id, email);
  } else if (existing.status === "INVITED" && isInvitationExpired(existing, job, new Date())) {
    // Re-invite an expired candidate: extend the window through the SAME
    // mapping â€” a refresh of the existing row, never a second invitation.
    const changed = await jobRepository.refreshInvitationWindow(existing.id, invitationExpiresAt);
    if (!changed) {
      // Lost a concurrent race (verified/expired state changed) â€” re-read the
      // winner and act on what actually persisted.
      invitation = await jobRepository.findInvitationByAssessmentAndEmail(assessment.id, email);
    } else {
      invitation = { ...existing, expiresAt: invitationExpiresAt };
      reactivated = true;
    }
  }

  const alreadyVerified = invitation?.status === "EMAIL_VERIFIED";

  // Phase 4 realtime: the invitation row (created, re-sent or reactivated) is
  // COMMITTED at this point, so the recruiter can be told about it immediately.
  // Published BEFORE the email attempt on purpose: the persisted invitation is
  // authoritative, so an email-delivery failure must not hide a real state
  // change from the recruiter (it also never rolls anything back).
  // Fire-and-forget â€” Redis availability can neither fail nor delay this
  // request.
  //
  // A row that is ALREADY EMAIL_VERIFIED is deliberately NOT announced as
  // INVITED: nothing changed, and an older status must never overwrite a newer
  // one in a browser.
  if (!alreadyVerified) {
    realtimePublisher.publishInvitationEvent({
      jobId: job.id,
      assessmentId: assessment.id,
      // The persisted candidate row identity â€” the same id the recruiter's row
      // carries â€” never an array position. A manually added candidate has no
      // spreadsheet row, so it is null there and the normalized email is the
      // routing key (exactly like the candidate-facing email-verified event).
      candidateId: resolvedRowId,
      candidateEmail: email,
    });
  }

  // The ASSESSMENT INVITATION EMAIL goes out here, and ONLY here: the recruiter
  // pressed "Invite Selected". It carries the assessment link and carries NO
  // verification code â€” no code is generated, no code is hashed, no challenge
  // is stored at this stage. The code belongs to the later VERIFICATION email,
  // which is reachable only after the candidate submits their email and the
  // backend authorizes it against this persisted invitation.
  //
  // The code lives transiently only inside the verification mailer, so there is
  // nothing to leak through the response, the notification or the SSE event.
  // Already-verified invitations stay untouched (nothing left to invite).
  //
  // DUPLICATE-INVITATION RULE (backend half, enforced here â€” never relying on a
  // disabled button in the UI). The send is gated on winning an atomic
  // compare-and-swap claim on the invitation row, so exactly ONE invitation
  // email can ever go out per (job, assessment, normalized email):
  //   * repeated click / refresh / duplicate HTTP request â†’ the claim is already
  //     taken, so NO second email is sent and the existing row is simply
  //     reported back (safe idempotent result);
  //   * two truly concurrent requests â†’ the CAS makes exactly one of them win;
  //   * a FAILED send releases the claim, so an honest retry can still reach a
  //     candidate whose first attempt hit an SMTP error.
  let emailChannel = null;
  let emailSuppressedAsDuplicate = false;
  if (!alreadyVerified && invitation) {
    const claimed = await jobRepository.claimInvitationEmailDelivery(invitation.id);
    if (claimed !== 1) {
      // Someone already sent this candidate their invitation email. Report the
      // existing invitation honestly instead of mailing them a second one.
      emailSuppressedAsDuplicate = true;
    } else {
      try {
        const sent = await invitationEmailSender({
          email,
          candidateName: rowName,
          jobTitle: job.title ?? null,
          assessmentTitle: assessment.title,
          publicId: assessment.publicId,
          // The LINK deadline (one day before the job deadline).
          expiresAt: invitation.expiresAt,
          // The three timeline facts, all read from PERSISTED values so the email
          // can never state a deadline the server does not actually hold. The
          // tab-away limit comes from the integrity service's own exported
          // constant, so the email describes the rule that is really enforced.
          assessmentExpiresAt: resolveJobExpiresAt(job),
          durationSeconds: assessment.durationSeconds,
          maxVisibilityHiddenEvents: MAX_VISIBILITY_HIDDEN_EVENTS,
        });
        emailChannel = sent?.channel ?? null;
        if (emailChannel === null) {
          // The sender resolved without a usable channel, so nothing is known to
          // have gone out. Release the claim rather than burn it.
          await jobRepository.releaseInvitationEmailDelivery(invitation.id);
        }
      } catch (error) {
        // The invitation REMAINS persisted â€” the database is authoritative and a
        // retry reuses this row. Release the claim so that retry can actually
        // deliver, then surface the failure honestly: no email went out and
        // nothing pretends otherwise.
        await jobRepository.releaseInvitationEmailDelivery(invitation.id);
        throw httpError(
          409,
          "The invitation was saved, but the invitation email could not be delivered. Check the email configuration and retry Invite â€” no duplicate invitation will be created."
        );
      }
    }
  }

  // In-system notification through the EXISTING idempotent notification
  // service. Only a real platform candidate account is notified; for
  // NOT_IN_SYSTEM candidates there is no account to notify and none is created.
  //
  // THIS IS STRICTLY READ-ONLY AND INFORMATIONAL. It is NOT an entry mechanism:
  //   * it carries NO assessment link — the ONLY way into the assessment is the
  //     invitation EMAIL, so a notification can never be used to skip a step or
  //     to open the assessment directly;
  //   * it carries NO verification code;
  //   * it cannot bypass email verification.
  // Clicking through it leads to the candidate's own notification list, not to
  // the assessment. It is skipped entirely when this request was a suppressed
  // duplicate, so a retry never creates a second notification.
  let candidateNotified = false;
  if (candidateAccount && !emailSuppressedAsDuplicate) {
    await createIdempotentNotification({
      userId: candidateAccount.id,
      title: "Assessment invitation",
      message:
        `You have been invited to the assessment "${assessment.title}". ` +
        "Open the invitation email we sent you, enter your email address, " +
        "verify the code we email you, and the assessment will open. " +
        "The assessment link is not included here for your security.",
      type: "ASSESSMENT_INVITATION",
      // No /assessment/<publicId> link: the notification must not open the
      // assessment and must not hand the candidate a usable capability URL.
      // Idempotency still holds because this (userId, link) pair is unique.
      link: "/employee/notifications",
    });
    candidateNotified = true;
  }

  return {
    candidate: {
      id: resolvedRowId,
      email,
      name: rowName,
      systemStatus: candidateAccount ? "IN_SYSTEM" : "NOT_IN_SYSTEM",
    },
    invitation: {
      status: invitation?.status ?? "INVITED",
      invitedAt: invitation?.invitedAt ?? null,
      expiresAt: invitation?.expiresAt ?? null,
    },
    invitationAlreadyExisted: alreadyExisted,
    invitationReactivated: reactivated,
    emailSent: emailChannel !== null,
    emailChannel,
    // True when this request deliberately sent NO email because this candidate
    // was already invited (and already emailed). Lets the recruiter UI and the
    // API consumer distinguish "not sent because already sent" from "not sent
    // because the provider failed".
    emailSuppressedAsDuplicate,
    candidateNotified,
  };
};

// Shared preconditions for the two candidate-facing verification calls.
//
// THIS IS THE AUTHORIZATION GATE. It runs BEFORE any verification code is
// generated or emailed, and it is what proves that the address the candidate
// typed is one the recruiter actually invited to THIS job + assessment. The
// typed email is never trusted on its own â€” it is only ever a lookup key into
// the persisted invitation set. It verifies:
//   * the link resolves to a FINALIZED **and ACTIVATED** assessment;
//   * a PERSISTED invitation exists for (that assessment, that normalized
//     email) â€” the pair IS the authorization handle;
//   * that invitation belongs to the SAME job as the assessment (no cross-job
//     reuse of a valid address);
//   * the owning job is still ACTIVE **and its persisted availability deadline
//     has not passed** (so an expired job is refused even if the background
//     sweeper has not run yet);
//   * the invitation link window is still open, judged against BOTH its own
//     deadline and the job's.
// EVERY failure collapses into the same generic 403 â€” an unknown link, an
// inactive assessment, a non-invited email, a cross-job address, a closed job,
// an expired job, an expired invitation and a wrong code are deliberately
// indistinguishable from the outside, so which addresses are invited can never
// be probed.
const requireActiveInvitationContext = async (publicId, emailRaw) => {
  const email = normalizeEmail(emailRaw);
  const assessment = await jobRepository.findFinalizedAssessmentByPublicId(publicId);
  if (!assessment || !email) {
    throw assessmentAccessDenied();
  }

  const invitation = await jobRepository.findInvitationByAssessmentAndEmail(assessment.id, email);
  if (!invitation || invitation.jobId !== assessment.jobId) {
    throw assessmentAccessDenied();
  }

  // The owning job is read BEFORE the invitation deadline is judged, because
  // BOTH persisted timestamps have to hold for the link to work:
  //   * the job must still be ACTIVE (the recruiter's own close), and
  //   * the job's own availability deadline (Job.analysisEndsAt) must not have
  //     passed.
  //
  // The deadline check is what makes the API the FINAL safety boundary rather
  // than a mirror of the scheduler. The background sweeper transitions
  // ACTIVE -> CLOSED on a timer, but it can be delayed, restarted, or run
  // concurrently on another instance. Comparing the PERSISTED deadline here
  // means an expired job is refused from the very first millisecond it expires,
  // even if no sweeper has run yet — and it closes the start-vs-expiration race
  // (Part 16), because this same read happens inside the start request itself.
  const job = await jobRepository.findJobById(assessment.jobId);
  if (!job || job.status !== jobRepository.JOB_STATUS.ACTIVE) {
    throw assessmentAccessDenied();
  }
  if (isJobExpired(job, new Date())) {
    throw assessmentAccessDenied();
  }

  // The invitation link itself must still be open. Checked against BOTH the
  // link deadline and the job deadline, so an expired job can never be revived
  // by a link that has not itself lapsed yet.
  if (isInvitationExpired(invitation, job, new Date())) {
    throw assessmentAccessDenied();
  }

  return { assessment, invitation, email };
};

// Candidate step 1 â€” THE ONLY place a verification code is ever issued.
//
// Order is the security contract and is not interchangeable:
//   persisted invitation exists â†’ candidate enters their email â†’ THIS function
//   authorizes that email against the invitation â†’ only then is a code
//   generated, hashed, stored and emailed.
// The code is never generated, stored or emailed before that authorization
// check has passed, and the recruiter's invitation never reaches here.
//
// The raw token exists only transiently, as the argument to the verification
// mailer: only its SHA-256 hash is persisted, and it is never in the response,
// the notification, the SSE payload, the URL or the logs. Re-requesting rotates
// the challenge. Already-verified invitations short-circuit idempotently (no
// re-send â€” there is nothing left to prove).
const requestAssessmentEmailVerification = async (publicId, emailRaw) => {
  // Authorization FIRST. Nothing below this line runs for an address that was
  // not actually invited to this job + assessment.
  const { assessment, invitation } = await requireActiveInvitationContext(publicId, emailRaw);

  if (invitation.status === "EMAIL_VERIFIED") {
    return {
      status: "EMAIL_VERIFIED",
      expiresAt: invitation.expiresAt,
      alreadyVerified: true,
    };
  }

  const token = generateVerificationToken();
  await jobRepository.setInvitationVerificationChallenge(invitation.id, {
    verificationTokenHash: hashVerificationToken(token),
    verificationExpiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
  });

  await sendAssessmentVerificationEmail({
    email: invitation.email,
    token,
    assessmentTitle: assessment.title,
    expiresAt: invitation.expiresAt,
  });

  return {
    status: "INVITED",
    expiresAt: invitation.expiresAt,
    alreadyVerified: false,
  };
};

// Candidate step 2: the emailed code is verified and the invitation flips to
// EMAIL_VERIFIED. The comparison is over SHA-256 digests with a
// timing-safe equality check; the challenge expires after 15 minutes and
// only ever matches THIS invitation. Authorization is a backend state
// change (status + emailVerifiedAt), never a frontend-held flag.
const confirmAssessmentEmailVerification = async (publicId, emailRaw, tokenRaw) => {
  const token = String(tokenRaw ?? "").trim();
  const { invitation } = await requireActiveInvitationContext(publicId, emailRaw);

  if (invitation.status === "EMAIL_VERIFIED") {
    return { verified: true, status: "EMAIL_VERIFIED", expiresAt: invitation.expiresAt };
  }

  const expected = invitation.verificationTokenHash ?? "";
  const actual = hashVerificationToken(token);
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(actual, "hex");
  const tokenMatches =
    expectedBuf.length === actualBuf.length &&
    expectedBuf.length > 0 &&
    crypto.timingSafeEqual(expectedBuf, actualBuf);
  const challengeOpen =
    invitation.verificationExpiresAt instanceof Date &&
    invitation.verificationExpiresAt.getTime() > Date.now();

  if (!tokenMatches || !challengeOpen) {
    throw assessmentAccessDenied();
  }

  const changed = await jobRepository.markInvitationEmailVerified(invitation.id);
  if (!changed) {
    // Either a concurrent verify won or the window just closed â€” re-read and
    // only accept the idempotent already-verified outcome.
    const winner = await jobRepository.findInvitationByAssessmentAndEmail(
      invitation.assessmentId,
      invitation.email
    );
    if (winner?.status === "EMAIL_VERIFIED") {
      return { verified: true, status: "EMAIL_VERIFIED", expiresAt: winner.expiresAt };
    }
    throw assessmentAccessDenied();
  }

      // Phase 4 realtime: publish the email-verified event AFTER the invitation
  // row has committed to EMAIL_VERIFIED. The database is authoritative;
  // Redis Pub/Sub is best-effort only. Fire-and-forget.
  // candidateId stays null because this candidate-facing flow proves the email
  // (not the Excel row); the recruiter UI reconciles by email.
  realtimePublisher.publishEmailVerifiedEvent({
    jobId: invitation.jobId,
    assessmentId: invitation.assessmentId,
    candidateId: null,
    candidateEmail: invitation.email,
  });

  return { verified: true, status: "EMAIL_VERIFIED", expiresAt: invitation.expiresAt };
};

module.exports = {
  createDraft,
  updateDraft,
  getJobForUser,
  listJobsForUser,
  listOrganizationJobs,
  getJobLimits,
  getOrganizationLimits,
  startJob,
  closeJobAsRecruiter,
  closeJobAsSystem,
  // The server-authoritative expiration sweep. Exposed so the background
  // scheduler, a manual operator run and the verification harness all drive the
  // SAME implementation — there is no second, competing expiry path.
  runExpirationSweep,
  uploadCandidateList,
  deleteCandidateList,
  getCandidateListPreview,
  listJobCandidates,
  // THE shared candidate classification used by BOTH the Excel list projection
  // and manual candidate addition, so the two paths can never diverge.
  classifyJobCandidates,
  updateClarificationQuestions,
  continueClarifications,
  updateAssessment,
  deleteAssessment,
  finalizeAssessment,
  getAssessmentForCandidate,
  activateAssessment,
  // THE invitation action â€” one row-scoped entry point for both candidate-entry
  // paths (Excel row id or job-scoped candidate-reference id). There is
  // deliberately no email-list variant: an invitation is only ever sent from a
  // row of the recruiter's own candidate list.
  inviteJobCandidate,
  // Recruiter-authorized read of ONE candidate's EXISTING platform skill
  // verification reports (the "View Report" modal). It is a pure read of the
  // already-persisted VerificationReport rows through verificationRead.service.
  getCandidateVerificationReport,
  requestAssessmentEmailVerification,
  confirmAssessmentEmailVerification,
  // Additive Phase 3 exports of EXISTING helpers (no behavior change): the
  // attempt service reuses the invitation context, the generic denial and the
  // ownership scope so there is exactly ONE normalization/authorization
  // implementation across the candidate and recruiter workflows.
  assessmentAccessDenied,
  requireActiveInvitationContext,
  assertJobScope,
  requireOwnedJob,
  // Phase 7 â€” additive exports of EXISTENCE-only helpers (no behavior change):
  // the candidate-reference service reuses the ONE authorization chain, the ONE
  // AI-workflow status gate and the ONE queue-delivery contract instead of
  // reimplementing any of them.
  requireAuthorizedJob,
  assertAiWorkflowAvailable,
  enqueueAiJobDelivery,
};


