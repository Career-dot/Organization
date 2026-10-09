const { Queue } = require("bullmq");
const { createRedisConnection, getAiQueueConfig } = require("../../config/redis");

// ---------------------------------------------------------------------------
// AI job queue (Stage 2) — BullMQ over Redis.
//
// ARCHITECTURAL RULE: PostgreSQL AiJob is the source of truth. This module owns
// DELIVERY only. Consequences that are enforced here:
//
//   * The queue payload carries ONLY { aiJobId }. The authoritative AI input
//     lives in AiJob.requestPayload (PostgreSQL); copying it into Redis would
//     create a second, silently-stale copy of business data.
//   * BullMQ delivery is AT-LEAST-ONCE, never exactly-once. The deterministic
//     jobId below reduces duplicate enqueues, but it is NOT the correctness
//     mechanism — the atomic PENDING→PROCESSING claim in aiJob.repository.js is.
//   * A queue failure never invalidates committed database state. Start has
//     already committed Job ACTIVE + quota + AiJob PENDING before this module is
//     ever called, so a Redis outage here is reported (425) and the PENDING row
//     is left intact for reconciliation/re-enqueue.
// ---------------------------------------------------------------------------

const AI_JOB_QUEUE_NAME = "ai-job-analysis";
const AI_JOB_QUEUE_JOB_NAME = "job-analysis";

// Deterministic queue job id for a database AiJob. Re-enqueueing the same
// AiJob while its previous queue job still exists is a no-op in BullMQ, which
// keeps duplicate delivery bounded. Never random: a random id would let a retry
// or a re-enqueue create unlimited duplicate queue records.
//
// NOTE: a colon separator (aiJob:<id>) is NOT usable — BullMQ rejects custom job
// ids containing ":" ("Custom Id cannot contain :"), since it uses that
// character for its own Redis key namespacing. A dash keeps the id readable and
// still deterministic.
const buildAiJobQueueJobId = (aiJobId) => `aiJob-${aiJobId}`;

// Reported (HTTP 425) when Redis cannot accept the message. The database
// transaction has already committed by then, so this is a delivery error only.
const AI_QUEUE_UNAVAILABLE_CODE = "AI_QUEUE_UNAVAILABLE";

const queueUnavailableError = (cause) => {
  const error = new Error(
    "The AI analysis queue is temporarily unavailable; the job was started and its analysis stays pending"
  );
  error.status = 425;
  error.code = AI_QUEUE_UNAVAILABLE_CODE;
  error.cause = cause;
  return error;
};

// Named exponential backoff, capped at AI_RETRY_MAX_DELAY_MS. BullMQ's built-in
// "exponential" has no ceiling, so the cap the environment asks for is
// implemented as a custom strategy — the queue declares it by name and the
// worker registers the implementation via Worker `settings.backoffStrategy`
// (BullMQ v6 accepts exactly one custom strategy per worker; same module as the
// producer, so the two cannot drift).
const AI_BACKOFF_STRATEGY = "aiExponential";

const getAiBackoffDelay = (attemptsMade, _type, error) => {
  const { retryBaseDelayMs, retryMaxDelayMs } = getAiQueueConfig();
  const delay = Math.min(retryBaseDelayMs * 2 ** Math.max(attemptsMade - 1, 0), retryMaxDelayMs);
  const hint = Number(error?.retryAfterMs);
  return Math.max(delay, Number.isFinite(hint) ? Math.min(300000, Math.max(0, hint)) : 0);
};

const AI_BACKOFF_STRATEGIES = { [AI_BACKOFF_STRATEGY]: getAiBackoffDelay };

const buildDefaultJobOptions = () => {
  const { maxAttempts, retryBaseDelayMs } = getAiQueueConfig();

  return {
    attempts: maxAttempts,
    backoff: { type: AI_BACKOFF_STRATEGY, delay: retryBaseDelayMs },
    // Keep a bounded history instead of deleting finished jobs immediately: a
    // retained job keeps its deterministic id reserved, so a duplicate enqueue
    // of the same AiJob is ignored rather than re-queued. Bounded, so Redis
    // cannot grow without limit.
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  };
};

// Lazily-created singleton so that merely requiring this module (as
// job.service.js does) never opens a Redis socket: the API process only talks
// to Redis when it actually has something to enqueue.
let queue = null;
let producerConnection = null;

const getAiJobQueue = () => {
  if (queue) {
    return queue;
  }

  producerConnection = createRedisConnection({ role: "producer" });
  queue = new Queue(AI_JOB_QUEUE_NAME, {
    connection: producerConnection,
    prefix: getAiQueueConfig().prefix,
    defaultJobOptions: buildDefaultJobOptions(),
  });

  queue.on("error", () => console.error("[aiQueue] Redis delivery connection unavailable"));
  const { maxAttempts, retryBaseDelayMs, retryMaxDelayMs } = getAiQueueConfig();
  console.log(
    `[aiQueue] producer ready for queue "${AI_JOB_QUEUE_NAME}" (maxAttempts=${maxAttempts}, backoff=${retryBaseDelayMs}-${retryMaxDelayMs}ms)`
  );

  return queue;
};

// Enqueues the delivery message for an AiJob. Safe to call repeatedly for the
// same AiJob. Throws a 425-tagged error when Redis is unavailable — callers must
// NOT treat that as a reason to roll back the committed database transaction.
const enqueueAiJob = async (aiJobId) => {
  const target = getAiJobQueue();
  const queueJobId = buildAiJobQueueJobId(aiJobId);
  const { enqueueTimeoutMs } = getAiQueueConfig();

  let job;
  let timer;

  try {
    // Payload is intentionally minimal: { aiJobId } and nothing else.
    //
    // The timeout is what makes an unavailable Redis a prompt, honest error
    // instead of a hanging HTTP request. The producer connection stays buffered
    // and keeps retrying in the background, so a later enqueue succeeds as soon
    // as Redis is back — failing this one call is not a permanent state.
    job = await Promise.race([
      target.add(AI_JOB_QUEUE_JOB_NAME, { aiJobId }, { jobId: queueJobId }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`enqueue did not complete within ${enqueueTimeoutMs}ms`)),
          enqueueTimeoutMs
        );
      }),
    ]);
  } catch (cause) {
    throw queueUnavailableError(cause);
  } finally {
    clearTimeout(timer);
  }

  console.log(`[aiQueue] enqueued ${queueJobId}`);
  return { queued: true, aiJobId, queueJobId: job.id };
};

// Verification/introspection helper: reads the BullMQ record for an AiJob
// without touching business state.
const findQueuedAiJob = async (aiJobId) => {
  const target = getAiJobQueue();
  return target.getJob(buildAiJobQueueJobId(aiJobId));
};

const closeAiJobQueue = async () => {
  if (queue) {
    try {
      await queue.close();
    } catch (error) {
      console.error(`[aiQueue] error closing queue: ${error.message}`);
    }
    queue = null;
  }

  if (producerConnection) {
    // disconnect() is synchronous and safe on an already-closed client, unlike
    // quit(), which would hang or reject while the connection is down.
    producerConnection.disconnect();
    producerConnection = null;
  }
};

module.exports = {
  AI_JOB_QUEUE_NAME,
  AI_JOB_QUEUE_JOB_NAME,
  AI_QUEUE_UNAVAILABLE_CODE,
  AI_BACKOFF_STRATEGY,
  AI_BACKOFF_STRATEGIES,
  buildAiJobQueueJobId,
  buildDefaultJobOptions,
  getAiBackoffDelay,
  getAiJobQueue,
  enqueueAiJob,
  findQueuedAiJob,
  closeAiJobQueue,
};