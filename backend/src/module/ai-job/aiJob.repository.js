const prisma = require("../../config/prisma");
// The ONE backend source of truth for the assessment hard limits
// (job.validation.js). No cycle: that module only requires zod.
const {
  MIN_ASSESSMENT_DURATION_SECONDS,
  MAX_ASSESSMENT_DURATION_SECONDS,
} = require("../job/job.validation");

// Prisma enum values are referenced as plain strings on purpose: the allowed
// values are frozen by the migrated database schema (AiJobStatus and
// AiJobOperation enums), not by application state. Same convention as
// job.repository.js's JOB_STATUS / JOB_CLOSED_REASON.
const AI_JOB_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

const AI_JOB_OPERATION = {
  JOB_ANALYSIS: "JOB_ANALYSIS",
  ASSESSMENT_GENERATION: "ASSESSMENT_GENERATION",
  // Phase 7 — one AiJob per candidate analysis, discriminated by AiJob.scopeKey
  // so a single job can carry N independent candidate analyses. The worker's
  // request/response contract for this operation is added in a later stage:
  // until then a CANDIDATE_ANALYSIS row fails closed (terminal), never open.
  CANDIDATE_ANALYSIS: "CANDIDATE_ANALYSIS",
};

// The four analysis areas, mirrored from the AI service contract's Section
// Literal and the JobAnalysisSection enum. Kept as plain strings for the same
// reason the statuses are.
const JOB_ANALYSIS_SECTION = {
  JOB_OVERVIEW: "JOB_OVERVIEW",
  RESPONSIBILITIES: "RESPONSIBILITIES",
  REQUIRED_SKILLS: "REQUIRED_SKILLS",
  TOOLS_SOFTWARE: "TOOLS_SOFTWARE",
};

// Display order of the sections in the recruiter UI. Matches the order the areas
// appear in the analysis contract (summary → responsibilities → skills → tools).
const JOB_ANALYSIS_SECTION_ORDER = [
  JOB_ANALYSIS_SECTION.JOB_OVERVIEW,
  JOB_ANALYSIS_SECTION.RESPONSIBILITIES,
  JOB_ANALYSIS_SECTION.REQUIRED_SKILLS,
  JOB_ANALYSIS_SECTION.TOOLS_SOFTWARE,
];

// Candidate assessment timer applied when an assessment is first materialized.
// The AI provider NEVER decides the duration (it is not part of the generation
// contract), so a fresh DRAFT assessment always starts at this fixed default and
// the recruiter may change it up to finalization. Deliberately unrelated to
// Job.analysisDays, which bounds the recruitment/analysis window instead.
const DEFAULT_ASSESSMENT_DURATION_SECONDS = 600;

// Repository-layer failure that needs an HTTP status (same local helper pattern
// as job.repository.js — no shared ApiError class exists in this codebase).
const failure = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// AI request snapshot
// ---------------------------------------------------------------------------

const buildJobInput = (job) => ({
  title: job.title ?? null,
  yearsExperience: job.yearsExperience ?? null,
  description: job.description ?? null,
  skills: (job.skills ?? []).map((skill) => ({
    name: skill.name,
    weight: skill.weight,
  })),
  tools: (job.tools ?? []).map((tool) => tool.name),
  questions: (job.questions ?? []).map((question) => question.question),
});

// Builds the immutable AI input snapshot stored on AiJob.requestPayload.
//
// This is the exact input a future AI service will receive, captured at Start
// time so a later edit to the job can never change what was asked for.
//
// Deliberately EXCLUDED (neither the AI service nor the snapshot needs them,
// and several are security/privacy sensitive):
//   * ownership     — recruiterId / organizationId / createdByUserId
//   * auth & account data — tokens, password hashes, emails, JWT claims
//   * subscription / quota — plan, usage, remaining counts
//   * credentials    — database, Redis, provider/API keys
//   * analysisDays   — it bounds the job's analysis window (analysisEndsAt)
//                      and is not an AI input; no concrete AI requirement for
//                      it exists yet, so it stays out of the payload.
//   * internal state — id, status, timestamps, worker bookkeeping, the
//                      analysis window, closed reason
//   * preferredCandidateCount — a recruiter ranking preference, not an AI input
//                      to either operation (ranking is a later stage).
//
// Nullable scalars are normalized to null rather than left undefined so the
// stored JSON always has a stable, complete key set (JSON.stringify would
// silently drop undefined keys, producing a payload that varies per call).
const buildJobAnalysisPayload = (job) => ({
  operation: AI_JOB_OPERATION.JOB_ANALYSIS,
  input: buildJobInput(job),
});

// Snapshot for the second AI operation. The input is the job PLUS the recruiter-
// approved clarification questions, so assessment generation can never depend on
// questions the recruiter later edits or deletes: what was asked for is frozen
// here, exactly like the analysis snapshot.
const buildAssessmentGenerationPayload = (job, clarifications) => ({
  operation: AI_JOB_OPERATION.ASSESSMENT_GENERATION,
  input: {
    job: buildJobInput(job),
    clarifications: (clarifications ?? []).map((clarification) => ({
      section: clarification.section,
      question: clarification.question,
    })),
    // The recruiter's assessment settings, frozen with the snapshot exactly
    // like the rest of the input. requestedQuestionCount tells the AI service
    // how many questions to generate (bounded by the 45 platform maximum,
    // always at least the number of mandatory recruiter questions).
    // requestedDurationSeconds is frozen for audit only — it is NOT an AI
    // input and the response schema carries no duration; the authoritative
    // timer is re-read from the Job row at persistence time, so the AI can
    // never decide it.
    requestedQuestionCount: job.assessmentQuestionCount ?? null,
    requestedDurationSeconds: job.assessmentDurationSeconds ?? null,
  },
});

// ---------------------------------------------------------------------------
// AiJob persistence
// ---------------------------------------------------------------------------

// Creates the durable PENDING record of an AI operation.
//
// `client` is the Prisma transaction client when this participates in a larger
// transaction — Start passes the same `tx` that activated the job and consumed
// quota, so the AI record can never exist without its job activation, and its
// job activation can never exist without it. Callers outside a transaction may
// omit it and get the default client.
//
// Stage 1 scope: this writes the database row only. There is deliberately no
// queue/BullMQ/Redis call and no AI provider call anywhere in this module —
// delivery and processing belong to a later stage.
const createAiJob = async ({
  jobId,
  operation = AI_JOB_OPERATION.JOB_ANALYSIS,
  // Phase 7 — candidate-scope discriminator. "" (the column default) keeps the
  // one-row-per-job contract for JOB_ANALYSIS and ASSESSMENT_GENERATION exactly
  // as before; a CANDIDATE_ANALYSIS caller passes its own opaque scope so every
  // candidate analysis gets an independent, independently retryable AiJob.
  scopeKey = "",
  requestPayload,
  client = prisma,
}) => {
  try {
    return await client.aiJob.create({
      data: {
        jobId,
        operation,
        scopeKey,
        // Matches the schema default; written explicitly because PENDING is the
        // Stage 1 contract Start commits to.
        status: AI_JOB_STATUS.PENDING,
        requestPayload,
      },
    });
  } catch (error) {
    // @@unique([jobId, operation, scopeKey]) is the database-level invariant
    // behind the imperative DRAFT → ACTIVE compare-and-swap: one AI operation
    // per job per scope — forever. The two original operations always use the
    // "" scope, so their contract is unchanged. The throw propagates out of the
    // enclosing transaction, so a duplicate AiJob rolls back the whole Start
    // (quota included) instead of half-applying it. Surfaced as 409 so the API
    // does not report it as an unrelated duplicate-name error (which the job
    // controller maps P2002 to).
    if (error.code === "P2002") {
      throw failure(409, "An AI job already exists for this job");
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Worker-side state machine (Stage 2)
// ---------------------------------------------------------------------------
//
// PostgreSQL is the ONLY place these transitions happen, and every one of them
// is a single conditional UPDATE. That is what makes concurrent workers safe:
// the status column itself is the lock. BullMQ can deliver the same AiJob more
// than once (at-least-once), so the worker must never assume it is the only
// consumer — it must ask the database to hand it the job.
//
//   PENDING ──claim──→ PROCESSING ──success (Stage 3 sets terminal)──→ COMPLETED
//      ↑                    │
//      └──release (retry)───┤
//                           └──terminal failure──→ FAILED (+ lastError)
//
// Invariants that make recovery possible later:
//   * PENDING  ⇒ workerId = null and startedAt = null (nobody owns it).
//   * PROCESSING ⇒ workerId = <claimer>, startedAt = <claim time>.
//   * attempts counts CLAIMS, not deliveries. A duplicate delivery that fails
//     to claim leaves attempts untouched.
//   * Terminal states (COMPLETED/FAILED) are never claimable again.

const findAiJobById = async (aiJobId, client = prisma) =>
  client.aiJob.findUnique({ where: { id: aiJobId } });

// Realtime notification context is read from the authoritative rows only after
// the caller has observed a successful committed transition. It contains no
// candidate email, request payload, snapshot, result, token, or file identity.
const findCandidateAnalysisRealtimeContext = async (aiJobId, client = prisma) => {
  const analysis = await client.jobCandidateAnalysis.findUnique({
    where: { aiJobId },
    select: {
      id: true,
      jobId: true,
      referenceId: true,
      analysisVersion: true,
      aiJob: { select: { status: true, updatedAt: true } },
    },
  });
  if (!analysis?.referenceId || !analysis.aiJob) return null;
  return {
    analysisId: analysis.id,
    jobId: analysis.jobId,
    referenceId: analysis.referenceId,
    analysisVersion: analysis.analysisVersion,
    status: analysis.aiJob.status,
    updatedAt: analysis.aiJob.updatedAt,
  };
};

// Atomic PENDING → PROCESSING claim.
//
// The UPDATE ... WHERE id = ? AND status = 'PENDING' is evaluated by PostgreSQL
// under row locking, so exactly one concurrent worker gets count = 1. Losers
// get count = 0 and MUST NOT process anything.
//
// attempts is incremented here and only here, because this is the moment the
// job is genuinely taken for processing.
const claimAiJobForProcessing = async ({ aiJobId, workerId, client = prisma }) => {
  const claim = async (tx) => {
    const changed = await tx.aiJob.updateMany({
      where: { id: aiJobId, status: AI_JOB_STATUS.PENDING },
      data: { status: AI_JOB_STATUS.PROCESSING, attempts: { increment: 1 },
        startedAt: new Date(), workerId, lastError: null },
    });
    return changed.count ? tx.aiJob.findUnique({ where: { id: aiJobId } }) : null;
  };
  // The claim and returned attempt snapshot commit together. A failed read rolls
  // back the claim rather than leaving a row owned by an unknown attempt.
  return typeof client.$transaction === "function" ? client.$transaction(claim) : claim(client);
};

// PROCESSING → COMPLETED, fenced on the full claim identity.
//
// The fence is { status: PROCESSING, workerId, attempts } — not just the id.
// attempts is the try that actually holds the claim, so a worker whose attempt
// was superseded (stale recovery, a later claim) updates 0 rows instead of
// overwriting a result it no longer owns. The conditional UPDATE is the only
// place that decision is made, which is what makes it safe under concurrency.
//
// `provider` is passed in rather than hardcoded here: the persistence layer must
// stay provider-agnostic, and the AI service already reports which provider
// produced the analysis (validated by the caller against the response contract).
// Hardcoding it would duplicate that identity in two places that can drift.
const completeAiJob = async ({ aiJobId, workerId, attempts, analysis, provider, client = prisma }) => {
  if (!Number.isInteger(attempts) || attempts < 1 || !workerId) throw new Error("AI_CLAIM_INVALID");
  if (typeof provider !== "string" || provider.trim() === "") throw new Error("AI_PROVIDER_INVALID");
  const changed = await client.aiJob.updateMany({
    where: { id: aiJobId, status: AI_JOB_STATUS.PROCESSING, workerId, attempts },
    data: { status: AI_JOB_STATUS.COMPLETED, result: { schemaVersion: "1", analysis },
      provider, completedAt: new Date(), lastError: null, workerId: null, startedAt: null },
  });
  return changed.count;
};

// PROCESSING → PENDING for a RETRYABLE failure, before the worker rethrows so
// BullMQ schedules the next attempt. This is what keeps the invariant honest:
// a retryable failure never leaves the row stuck in PROCESSING, and it is never
// marked FAILED for a transient problem. attempts is preserved (not reset), so
// the retry history survives.
const releaseAiJobForRetry = async ({ aiJobId, workerId, attempts, lastError, client = prisma }) => {
  const released = await client.aiJob.updateMany({
    where: { id: aiJobId, status: AI_JOB_STATUS.PROCESSING, workerId, ...(attempts === undefined ? {} : { attempts }) },
    data: {
      status: AI_JOB_STATUS.PENDING,
      workerId: null,
      startedAt: null,
      lastError,
      // lastEnqueuedAt is refreshed when the row is made deliverable again.
      lastEnqueuedAt: new Date(),
    },
  });

  return released.count;
};

// Non-retryable outcome (or BullMQ retries exhausted) → terminal FAILED.
// Accepts PENDING as well, because a retryable failure first releases the row
// back to PENDING and only then does BullMQ report the attempt as failed once
// attempts are exhausted.
const markAiJobFailed = async ({ aiJobId, workerId, attempts, lastError, client = prisma }) => {
  const failed = await client.aiJob.updateMany({
    where: {
      id: aiJobId,
      ...(attempts === undefined ? {} : { attempts }),
      ...(workerId
        ? { status: AI_JOB_STATUS.PROCESSING, workerId }
        : { status: AI_JOB_STATUS.PENDING }),
    },
    data: {
      status: AI_JOB_STATUS.FAILED,
      lastError,
      // The claim is over, so its ownership bookkeeping must be released exactly
      // as completeAiJob and releaseAiJobForRetry release it. Leaving startedAt
      // set on a FAILED row would break the invariant documented above
      // (a row with workerId = null is not owned by anyone) and would leave a
      // stale "claim began at" timestamp on a terminal row for later readers.
      workerId: null,
      startedAt: null,
      // completedAt is the "finished at" stamp for both terminal states.
      completedAt: new Date(),
    },
  });

  return failed.count;
};

// ---------------------------------------------------------------------------
// Stale PROCESSING recovery (foundation; the periodic reconciler is a later
// stage — see AI_STALE_SWEEP_ENABLED in src/config/redis.js).
// ---------------------------------------------------------------------------
// A worker can die mid-processing (SIGKILL, host crash, OOM). Its row then stays
// PROCESSING with nobody working on it. BullMQ's own stalled-job detection
// handles the queue side, but it cannot fix a row whose queue job is gone, so
// the database needs a way to identify such rows.
//
// Staleness is decided from updatedAt (refreshed on every write) and startedAt,
// which together bound how long a claim can be honoured before the row is
// considered abandoned.

const findStaleProcessingAiJobs = async ({
  olderThanMs,
  limit = 50,
  client = prisma,
} = {}) => {
  const cutoff = new Date(Date.now() - olderThanMs);

  return client.aiJob.findMany({
    where: {
      status: AI_JOB_STATUS.PROCESSING,
      OR: [{ updatedAt: { lt: cutoff } }, { startedAt: { lt: cutoff } }],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
};

// PROCESSING → PENDING for a row whose owner is gone, so it can be enqueued and
// claimed again. Refuses (count 0) if the row is no longer PROCESSING, which
// keeps it safe to call even if the abandoned worker came back to life: the
// conditional UPDATE is the only place this decision is made.
const reclaimStaleAiJobForRetry = async ({ aiJobId, reason, olderThanMs = 300000, client = prisma }) => {
  // Re-check age in the UPDATE: a scan is not a lease and may be out of date.
  const cutoff = new Date(Date.now() - olderThanMs);
  const reclaimed = await client.aiJob.updateMany({
    where: { id: aiJobId, status: AI_JOB_STATUS.PROCESSING, updatedAt: { lt: cutoff } },
    data: {
      status: AI_JOB_STATUS.PENDING,
      workerId: null,
      startedAt: null,
      lastError: reason,
      lastEnqueuedAt: new Date(),
    },
  });

  return reclaimed.count;
};

// PROCESSING → COMPLETED for the assessment operation, fenced exactly like
// completeAiJob and materializing the assessment in the SAME transaction.
//
// The fence guarantees only the owning attempt can write. The transaction
// guarantees the database never holds a COMPLETED assessment AiJob without its
// assessment, nor an assessment without its completed AiJob.
//
// `jobId` comes from the authoritative AiJob row (not from the AI response) and
// `aiJobId` is @unique on JobAssessment, so duplicate queue delivery or a retry
// can never produce two assessments for one job.
const completeAssessmentGeneration = async ({
  aiJobId,
  jobId,
  workerId,
  attempts,
  assessment,
  provider,
  client = prisma,
}) => {
  if (!Number.isInteger(attempts) || attempts < 1 || !workerId) throw new Error("AI_CLAIM_INVALID");
  if (typeof provider !== "string" || provider.trim() === "") throw new Error("AI_PROVIDER_INVALID");

  return client.$transaction(async (tx) => {
    const changed = await tx.aiJob.updateMany({
      where: { id: aiJobId, status: AI_JOB_STATUS.PROCESSING, workerId, attempts },
      data: {
        status: AI_JOB_STATUS.COMPLETED,
        result: { schemaVersion: "1", assessment },
        provider,
        completedAt: new Date(),
        lastError: null,
        workerId: null,
        startedAt: null,
      },
    });
    if (changed.count === 0) {
      return 0;
    }

    // The candidate timer comes from the recruiter's own Job configuration
    // when one exists (bounded by the platform limits); the fixed default
    // applies to jobs that predate the setting. The AI response carries no
    // duration and can never influence this value — duration is NEVER an AI
    // decision.
    const jobConfig = await tx.job.findUnique({
      where: { id: jobId },
      select: { assessmentDurationSeconds: true },
    });
    const configuredDuration = jobConfig?.assessmentDurationSeconds;
    const durationSeconds =
      Number.isInteger(configuredDuration) &&
      configuredDuration >= MIN_ASSESSMENT_DURATION_SECONDS &&
      configuredDuration <= MAX_ASSESSMENT_DURATION_SECONDS
        ? configuredDuration
        : DEFAULT_ASSESSMENT_DURATION_SECONDS;

    await tx.jobAssessment.create({
      data: {
        jobId,
        aiJobId,
        title: assessment.title,
        description: assessment.description ?? null,
        // DRAFT: the recruiter may still edit or delete it before Continuing.
        status: "DRAFT",
        // From the Job's own configuration (or the default for legacy jobs) —
        // never from the AI response.
        durationSeconds,
        questions: {
          create: assessment.questions.map((question, index) => ({
            section: question.section,
            sortOrder: index,
            prompt: question.prompt,
            questionType: question.questionType,
            points: question.points,
            difficulty: question.difficulty ?? null,
            guidance: question.guidance ?? null,
            options: question.options?.length ? question.options : null,
            // Phase 6 — the answer key survives exactly as the strict
            // response contract validated it (choice value(s) proven to be
            // members of these options); text-shaped questions persist null.
            correctAnswer: question.correctAnswer ?? null,
          })),
        },
      },
    });

    return 1;
  });
};

// PROCESSING → COMPLETED for candidate analysis, fenced exactly like the other
// completion paths. The validated analysis and AiJob completion commit in one
// transaction, so a COMPLETED AiJob can never exist without its authoritative
// JobCandidateAnalysis result. aiJobId is unique and is also the update key,
// making duplicate delivery and ambiguous-write recovery idempotent.
const completeCandidateAnalysis = async ({
  aiJobId,
  workerId,
  attempts,
  analysis,
  provider,
  model,
  client = prisma,
}) => {
  if (!Number.isInteger(attempts) || attempts < 1 || !workerId) throw new Error("AI_CLAIM_INVALID");
  if (typeof provider !== "string" || provider.trim() === "") throw new Error("AI_PROVIDER_INVALID");
  if (typeof model !== "string" || model.trim() === "") throw new Error("AI_MODEL_INVALID");

  return client.$transaction(async (tx) => {
    const existing = await tx.jobCandidateAnalysis.findUnique({
      where: { aiJobId },
      select: { id: true, completedAt: true },
    });
    if (!existing) {
      throw new Error("AI_CANDIDATE_ANALYSIS_NOT_FOUND");
    }
    // An already materialized row is the idempotent outcome of an ambiguous
    // previous commit. Never overwrite it with a later provider response.
    if (existing.completedAt) {
      await tx.aiJob.updateMany({
        where: { id: aiJobId, status: AI_JOB_STATUS.COMPLETED },
        data: {},
      });
      // Preserve the existing truthy success contract. Ordinary duplicate
      // delivery is stopped by the worker's terminal-state guard; only an
      // ambiguous-write recovery reaches this branch and re-announces the
      // already committed terminal state after reconciliation.
      return 1;
    }

    const changed = await tx.aiJob.updateMany({
      where: { id: aiJobId, status: AI_JOB_STATUS.PROCESSING, workerId, attempts },
      data: {
        status: AI_JOB_STATUS.COMPLETED,
        result: { schemaVersion: "1", analysis },
        provider,
        completedAt: new Date(),
        lastError: null,
        workerId: null,
        startedAt: null,
      },
    });
    if (changed.count === 0) {
      return 0;
    }

    const materialized = await tx.jobCandidateAnalysis.updateMany({
      where: { id: existing.id, completedAt: null },
      data: {
        result: analysis,
        provider,
        model,
        completedAt: new Date(),
      },
    });
    if (materialized.count !== 1) {
      throw new Error("AI_CANDIDATE_ANALYSIS_PERSISTENCE_CONFLICT");
    }
    return 1;
  });
};

module.exports = {
  AI_JOB_STATUS,
  AI_JOB_OPERATION,
  JOB_ANALYSIS_SECTION,
  JOB_ANALYSIS_SECTION_ORDER,
  buildJobAnalysisPayload,
  buildAssessmentGenerationPayload,
  createAiJob,
  findAiJobById,
  findCandidateAnalysisRealtimeContext,
  completeAiJob,
  completeAssessmentGeneration,
  completeCandidateAnalysis,
  claimAiJobForProcessing,
  releaseAiJobForRetry,
  markAiJobFailed,
  findStaleProcessingAiJobs,
  reclaimStaleAiJobForRetry,
};