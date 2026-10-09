// Environment must be loaded BEFORE any module reads process.env, and it must not
// depend on the shell's working directory: this file is started from backend/
// (`npm run dev:ai-worker`), from the repository root, and by the verification
// harnesses. The backend package's own .env is therefore resolved from this
// file's location, with the repository root as a fallback. Only the first
// existing file is loaded, and real process environment always wins (dotenv
// never overrides a variable that is already set), so a harness's injected
// values are never clobbered by .env — which is what keeps the isolated test runs
// isolated.
const fs = require("node:fs");
const path = require("node:path");

const workerEnvFile = [
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
].find((candidate) => fs.existsSync(candidate));

if (workerEnvFile) {
  require("dotenv").config({ path: workerEnvFile });
} else {
  console.error(
    "[aiWorker] no .env file found next to the backend package or at the repository root — using the process environment only"
  );
}

const { analyzeAiJob, AiServiceError } = require("./module/ai-job/aiJob.client");
const { buildRequest, validateResponse } = require("./module/ai-job/aiJob.validation");
const { describeAiServiceConfig } = require("./config/aiService");
const realtimePublisher = require("./module/job/jobAssessmentRealtime.publisher");

const os = require("node:os");
const { Worker, UnrecoverableError } = require("bullmq");
const prisma = require("./config/prisma");
const { closeRealtimePubSub } = require("./config/redis.pubsub");
const { createRedisConnection, getAiQueueConfig, getRedisUrl } = require("./config/redis");
const {
  AI_JOB_QUEUE_NAME,
  AI_BACKOFF_STRATEGIES,
  closeAiJobQueue,
  enqueueAiJob,
} = require("./module/ai-job/aiJob.queue");
const {
  AI_JOB_OPERATION,
  AI_JOB_STATUS,
  claimAiJobForProcessing,
  completeAiJob,
  completeAssessmentGeneration,
  completeCandidateAnalysis,
  findAiJobById,
  findCandidateAnalysisRealtimeContext,
  findStaleProcessingAiJobs,
  markAiJobFailed,
  reclaimStaleAiJobForRetry,
  releaseAiJobForRetry,
} = require("./module/ai-job/aiJob.repository");

// The operations this worker can build a request for. Derived from the shared
// AI_JOB_OPERATION map so a new operation added there without a contract in
// aiJob.validation.js fails closed (terminal), never open.
const SUPPORTED_OPERATIONS = new Set(Object.values(AI_JOB_OPERATION));

// ---------------------------------------------------------------------------
// AI worker process (Stage 2).
//
// A SEPARATE PROCESS from Express, on purpose: the API must stay responsive
// while AI work runs, and workers must be independently scalable/restartable.
// This file is never required by src/app.js or src/server.js — starting the API
// must not start a worker. Run it with `npm run dev:ai-worker`.
//
// DELIVERY vs TRUTH: BullMQ delivers at-least-once, so this worker never assumes
// it is the only consumer and never trusts the queue message for business state.
// It loads the authoritative AiJob from PostgreSQL and asks PostgreSQL to hand
// it the job (atomic conditional UPDATE). AI work itself is Stage 3+; this stage
// proves the delivery + claim lifecycle and deliberately stops there.
// ---------------------------------------------------------------------------

// Terminal = retrying this will never help (bad message, unknown operation,
// malformed payload). Retryable = infrastructure/transient (Redis blip, DB
// connection drop, future AI-service 5xx/timeout).
class TerminalAiJobError extends Error {
  constructor(message) {
    super(message);
    this.name = "TerminalAiJobError";
  }
}

class RetryableAiJobError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "RetryableAiJobError";
    this.cause = cause;
  }
}

// Stable, non-sensitive identity for observability and for attributing a claim
// in AiJob.workerId. Hostname + pid only: no machine fingerprint, no user path.
const buildWorkerId = () => `ai-worker:${os.hostname()}:${process.pid}`;

/**
 * Announces one committed candidate-analysis transition. The caller MUST invoke
 * this only after its repository method has returned successfully, which proves
 * the transaction committed. A failure to read context or publish is logged and
 * swallowed: PostgreSQL remains authoritative and reconnect/manual refetch is the
 * recovery path. The event payload is built by the strict whitelist publisher.
 */
const publishCandidateAnalysisTransition = async (aiJobId, expectedStatus) => {
  try {
    // Read the committed context synchronously before the next state can race
    // ahead. Redis publication below remains fire-and-forget.
    const context = await findCandidateAnalysisRealtimeContext(aiJobId);
    if (!context || context.status !== expectedStatus) return;
    void realtimePublisher.publishCandidateAnalysisUpdatedEvent(context);
  } catch (error) {
    console.error(`[aiWorker] candidate-analysis realtime unavailable for ${aiJobId}`);
  }
};

// Strips any credentials from the Redis URL before it can reach a log line.
const redactRedisUrl = (url) => {
  try {
    const parsed = new URL(url);
    const db = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${parsed.protocol}//${parsed.host}${db}`;
  } catch {
    return "unparseable";
  }
};

// The HTTP client aborts timed-out requests; no non-cancelling Promise.race.
// The operation identifier is stable, but remote execution remains at-least-once.
const processAiJob = async (queueJob, workerId, analyze = analyzeAiJob) => {
  const aiJobId = queueJob?.data?.aiJobId;

  if (typeof aiJobId !== "string" || aiJobId.length === 0) {
    // No database row can be identified, so there is nothing to retry.
    // UnrecoverableError skips the remaining attempts entirely.
    throw new UnrecoverableError("Queue message carries no aiJobId");
  }

  let aiJob;
  try {
    // The queue message is only a pointer: the authoritative record is read
    // from PostgreSQL on every delivery, so a stale or duplicated message can
    // never cause work based on stale data.
    aiJob = await findAiJobById(aiJobId);
  } catch (cause) {
    throw new RetryableAiJobError("Could not read AiJob from PostgreSQL", cause);
  }

  // Orphaned queue message. PostgreSQL is authoritative, so a missing row means
  // "nothing to do" — never create business state from queue data.
  if (!aiJob) {
    console.log(`[aiWorker] ${workerId} ignoring orphaned message for missing AiJob ${aiJobId}`);
    return { skipped: "AI_JOB_NOT_FOUND" };
  }

  // Retrying can never fix an unsupported operation → terminal.
  if (!SUPPORTED_OPERATIONS.has(aiJob.operation)) {
    const reason = `Unsupported AiJob operation "${aiJob.operation}"`;
    await markAiJobFailed({ aiJobId, lastError: reason });
    console.log(`[aiWorker] ${workerId} marked ${aiJobId} FAILED — ${reason}`);
    // UnrecoverableError: the row is terminal, so do not burn the retry budget.
    throw new UnrecoverableError(reason);
  }

  // Already finished (or terminally failed): never process it again.
  if (aiJob.status === AI_JOB_STATUS.COMPLETED || aiJob.status === AI_JOB_STATUS.FAILED) {
    console.log(`[aiWorker] ${workerId} ignoring ${aiJobId} in terminal state ${aiJob.status}`);
    return { skipped: "TERMINAL_STATE" };
  }

  // Claimed by another worker (or an earlier delivery): not ours to run.
  if (aiJob.status === AI_JOB_STATUS.PROCESSING) {
    console.log(`[aiWorker] ${workerId} ignoring ${aiJobId} already claimed by ${aiJob.workerId}`);
    return { skipped: "ALREADY_CLAIMED" };
  }

  // Atomic PENDING → PROCESSING. Exactly one concurrent delivery wins this.
  const claimed = await claimAiJobForProcessing({ aiJobId, workerId });

  if (!claimed) {
    // Duplicate delivery that lost the race: acknowledge and stop. attempts was
    // NOT incremented for this delivery, which is the point of claiming first.
    console.log(`[aiWorker] ${workerId} duplicate delivery of ${aiJobId} — claim not granted`);
    return { skipped: "CLAIM_LOST" };
  }

  console.log(`[aiWorker] ${workerId} claimed AiJob ${aiJobId} (attempt ${claimed.attempts})`);
  if (claimed.operation === AI_JOB_OPERATION.CANDIDATE_ANALYSIS) {
    await publishCandidateAnalysisTransition(aiJobId, AI_JOB_STATUS.PROCESSING);
  }

  const fence = { aiJobId, workerId, attempts: claimed.attempts };
  let response;
  try {
    let request;
    try { request = buildRequest(claimed); }
    catch { throw new AiServiceError("AI_REQUEST_INVALID", false); }
    const raw = await analyze(claimed);
    try { response = validateResponse(raw, request); }
    catch { throw new AiServiceError("AI_RESPONSE_VALIDATION_FAILED", true); }
  } catch (error) {
    const known = error instanceof AiServiceError;
    const code = known ? error.code : "AI_SERVICE_INTERNAL_ERROR";
    const exhausted = claimed.attempts >= getAiQueueConfig().maxAttempts ||
      (queueJob.attemptsMade || 0) + 1 >= (queueJob.opts?.attempts || 1);
    const terminal = !known || !error.retryable || exhausted;
    const changed = terminal
      ? await markAiJobFailed({ ...fence, lastError: code })
      : await releaseAiJobForRetry({ ...fence, lastError: code });
    if (!changed) throw new UnrecoverableError("AI_CLAIM_LOST");
    if (claimed.operation === AI_JOB_OPERATION.CANDIDATE_ANALYSIS) {
      await publishCandidateAnalysisTransition(
        aiJobId,
        terminal ? AI_JOB_STATUS.FAILED : AI_JOB_STATUS.PENDING
      );
    }
    console.log(`[aiWorker] ${workerId} ${terminal ? "terminal failure" : "retryable failure"} for ${aiJobId}: ${code}`);
    if (terminal) throw new UnrecoverableError(code);
    throw error;
  }

  // Persistence dispatch: each operation materializes its own durable output
  // inside the SAME fenced transition (the assessment row commits together
  // with the COMPLETED status). expectedResult drives the idempotency check
  // below, so the two operations cannot drift in their completion contract.
  const isAssessment = claimed.operation === AI_JOB_OPERATION.ASSESSMENT_GENERATION;
  const isCandidate = claimed.operation === AI_JOB_OPERATION.CANDIDATE_ANALYSIS;
  const expectedResult = isAssessment
    ? { schemaVersion: "1", assessment: response.assessment }
    : { schemaVersion: "1", analysis: response.analysis };

  // Retry persistence only while retaining the validated response in memory.
  // Never release ownership following an ambiguous completion write.
  let ambiguousWrite = false;
  for (let write = 0; write < 3; write++) {
    try {
      let changed;
      if (isAssessment) {
        changed = await completeAssessmentGeneration({
            ...fence,
            // The jobId comes from the authoritative claimed row, never from the
            // AI response — same trust boundary as the completion fence itself.
            jobId: claimed.jobId,
            assessment: response.assessment,
            provider: response.provider,
          });
      } else if (isCandidate) {
        changed = await completeCandidateAnalysis({
          ...fence,
          analysis: response.analysis,
          provider: response.provider,
          model: response.model,
        });
      } else {
        changed = await completeAiJob({
          ...fence,
          analysis: response.analysis,
          provider: response.provider,
        });
      }
      if (!changed) {
        const current = await findAiJobById(aiJobId);
        if (!ambiguousWrite || current?.status !== "COMPLETED" || current.attempts !== claimed.attempts ||
            !require("node:util").isDeepStrictEqual(current.result, expectedResult)) {
          throw new UnrecoverableError("AI_CLAIM_LOST");
        }
      }
      if (isCandidate && (changed === 1 || ambiguousWrite)) {
        await publishCandidateAnalysisTransition(aiJobId, AI_JOB_STATUS.COMPLETED);
      }
      console.log(`[aiWorker] ${workerId} completed AiJob ${aiJobId} (${claimed.operation})`);
      return { status: "COMPLETED", attempts: claimed.attempts, operation: claimed.operation };
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      ambiguousWrite = true;
      if (write === 2) throw new UnrecoverableError("AI_RESULT_PERSISTENCE_UNCERTAIN_REQUIRES_RECOVERY");
      await new Promise((resolve) => setTimeout(resolve, 200 * (write + 1)));
    }
  }
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const createAiJobWorker = ({ workerId = buildWorkerId(), processor = processAiJob } = {}) => {
  const { concurrency } = getAiQueueConfig();

  // Retained explicitly: BullMQ does not own externally-created ioredis clients.
  const connection = createRedisConnection({ role: "worker" });
  const worker = new Worker(AI_JOB_QUEUE_NAME, (queueJob) => processor(queueJob, workerId), {
    connection,
    prefix: getAiQueueConfig().prefix,
    concurrency,
    // Registers the capped-exponential strategy that the queue declares by name
    // (same module as the producer, so the two cannot drift).
    settings: { backoffStrategy: AI_BACKOFF_STRATEGIES.aiExponential },
  });

  // Observability only. Database transitions are awaited inside processing.
  worker.on("failed", (job, error) => {
    console.error(`[aiWorker] delivery failed for ${job?.data?.aiJobId ?? "unknown"}: ${error instanceof UnrecoverableError || error instanceof AiServiceError ? error.message : "AI_INFRASTRUCTURE_FAILURE"}`);
  });

  worker.on("error", (error) => {
    // Connection-level errors (e.g. Redis restarting): logged, never thrown,
    // because a long-lived worker is expected to reconnect.
    console.error(`[aiWorker] ${workerId} worker error: ${error.message}`);
  });

  return { worker, workerId, concurrency, connection };
};

// ---------------------------------------------------------------------------
// Stale PROCESSING sweep (opt-in — see AI_STALE_SWEEP_ENABLED)
// ---------------------------------------------------------------------------

// Recovery is repository-only in Stage 2. An age threshold alone does not prove
// a worker is dead. A later reconciler must verify ownership/lease expiry and
// reconcile retained BullMQ records before re-delivery.
const startStaleSweep = () => {
  console.log("[aiWorker] stale recovery is repository-only; no automatic sweep in Stage 2");
  return null;
};

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const startAiJobWorker = async (options = {}) => {
  // Safe configuration validation, reported BEFORE this worker can accept a
  // single job: whether the internal shared secret is present (a BOOLEAN only —
  // never the key, a prefix or a length) and which base URL will be called (the
  // validated, credential-free value). No provider credential is read or printed
  // here, and scripts/verifyAiJobStage2.js asserts that this banner never leaks
  // one.
  const aiService = describeAiServiceConfig();
  console.log(`AI service configured: ${aiService.configured}`);
  console.log(`AI service URL: ${aiService.url ?? "invalid or unset"}`);
  if (!aiService.configured) {
    // Not fatal on purpose: the worker stays available (so a later fix needs no
    // restart) and each job fails closed with the non-retryable
    // AI_SERVICE_NOT_CONFIGURED code instead of burning its retry budget.
    console.error(
      "[aiWorker] AI service is not configured — set AI_SERVICE_URL and AI_SERVICE_API_KEY in the backend .env; until then every job fails with AI_SERVICE_NOT_CONFIGURED"
    );
  }

  const { worker, workerId, concurrency, connection } = createAiJobWorker(options);
  const sweepTimer = startStaleSweep(workerId);

  // Startup banner. Deliberately no credentials, no connection strings with
  // userinfo, no AI payload contents — see redactRedisUrl.
  console.log("AI Worker starting");
  console.log(`Redis: ${redactRedisUrl(getRedisUrl())}`);
  console.log(`Queue: ${AI_JOB_QUEUE_NAME}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Worker ID: ${workerId}`);

  worker.on("ready", () => console.log("[aiWorker] Redis connected — waiting for jobs"));

  let shuttingDown = false;

  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(`[aiWorker] ${signal} received — no new jobs will be accepted`);
    clearInterval(sweepTimer);

    // Never hang forever if Redis is half-dead: close() can wait on a socket.
    const forceExit = setTimeout(() => {
      console.error("[aiWorker] graceful shutdown timed out");
      process.exit(1);
    }, getAiQueueConfig().requestTimeoutMs + 15000);
    forceExit.unref();

    try {
      // Stops fetching and resolves once in-flight jobs settle.
      await worker.close();
      console.log("[aiWorker] worker closed");
    } catch (error) {
      console.error(`[aiWorker] error closing worker: ${error.message}`);
    } finally {
      connection.disconnect();
    }

    try {
      await closeAiJobQueue();
    } catch (error) {
      console.error(`[aiWorker] error closing queue producer: ${error.message}`);
    }

    try {
      await closeRealtimePubSub();
    } catch (error) {
      console.error(`[aiWorker] error closing realtime publisher: ${error.message}`);
    }

    try {
      await prisma.$disconnect();
      console.log("[aiWorker] database disconnected");
    } catch (error) {
      console.error(`[aiWorker] error disconnecting database: ${error.message}`);
    }

    clearTimeout(forceExit);
    console.log("[aiWorker] shutdown complete");
    process.exit(exitCode);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A worker must not keep running in an unknown state after an uncaught error:
  // log, shut down cleanly, and exit non-zero so a supervisor can restart it.
  process.on("uncaughtException", (error) => {
    console.error(`[aiWorker] uncaught exception: ${error.message}`);
    shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(`[aiWorker] unhandled rejection: ${reason?.message ?? reason}`);
  });

  return { worker, workerId, sweepTimer, shutdown };
};

if (require.main === module) {
  startAiJobWorker().catch(async (error) => {
    console.error(`[aiWorker] failed to start: ${error.message}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  buildWorkerId,
  redactRedisUrl,
  processAiJob,
  createAiJobWorker,
  startStaleSweep,
  startAiJobWorker,
  TerminalAiJobError,
  RetryableAiJobError,
};