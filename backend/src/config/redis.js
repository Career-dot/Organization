const IORedis = require("ioredis");

// ---------------------------------------------------------------------------
// Redis configuration for the AI delivery layer (Stage 2).
//
// ARCHITECTURAL RULE: PostgreSQL owns business state. Redis/BullMQ is only the
// delivery/processing mechanism — it must never hold state that PostgreSQL does
// not also know about. Nothing here is business state: it is transport config.
//
// Configuration is read from the environment at CALL time (not at require time)
// so that:
//   * the API process only touches Redis when it actually enqueues (requiring
//     this module never opens a socket, so Express boots fine without Redis),
//   * a process can point at a different Redis without being restarted with a
//     different NODE_OPTIONS hack (used by the Stage 2 verification harness to
//     simulate an unavailable Redis with the real code path).
//
// No credentials are hardcoded: REDIS_URL comes from the environment, and the
// defaults below are localhost-only development values.
// ---------------------------------------------------------------------------

// The one place REDIS_URL is read. Never logged, never returned by an API.
const DEFAULT_REDIS_URL = "redis://localhost:6379";

const readPositiveInt = (raw, fallback) => {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getRedisUrl = () => process.env.REDIS_URL || DEFAULT_REDIS_URL;

const getAiQueueConfig = () => ({
  // BullMQ consumes this; the worker's own max-attempts also bound DB retries.
  prefix: process.env.AI_QUEUE_PREFIX || "bull",
  concurrency: readPositiveInt(process.env.AI_QUEUE_CONCURRENCY, 2),
  maxAttempts: readPositiveInt(process.env.AI_JOB_MAX_ATTEMPTS, 3),
  retryBaseDelayMs: readPositiveInt(process.env.AI_RETRY_BASE_DELAY_MS, 1000),
  retryMaxDelayMs: readPositiveInt(process.env.AI_RETRY_MAX_DELAY_MS, 30000),
  // Budget for one AI execution step. There is no AI call in Stage 2; the
  // worker applies this timeout to its placeholder processing step so the
  // plumbing (and its failure path) exists before Stage 3 needs it.
  requestTimeoutMs: readPositiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 30000),
  // Stale recovery is repository-only; no periodic sweeper in Stage 2.
  // Upper bound on a single enqueue call in the API process. A healthy Redis
  // answers in milliseconds; this only decides how long a Start request may wait
  // for the queue before reporting it as unavailable (425). Bounded on purpose:
  // the database transaction has already committed, so the request must not hang.
  enqueueTimeoutMs: readPositiveInt(process.env.AI_QUEUE_ENQUEUE_TIMEOUT_MS, 5000),
});

// Two deliberately different connection profiles.
//
// producer (API process): must not hang the HTTP request.
//   enableOfflineQueue stays TRUE so a command issued during the initial
//   connect (or a brief blip) is buffered rather than failing immediately —
//   without this, the very first Start after a process restart could report a
//   spurious 425 while the socket was still coming up. Fail-fast behaviour is
//   instead enforced per call by enqueueTimeoutMs in aiJob.queue.js, and the
//   connection keeps retrying (capped) so the API recovers by itself once Redis
//   returns.
//
// worker (worker process): must be RESILIENT. BullMQ requires
//   maxRetriesPerRequest:null on worker connections, and queued commands must
//   be buffered while Redis restarts rather than discarded.
const PRODUCER_OPTIONS = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: true,
  enableReadyCheck: true,
  connectTimeout: 2000,
  // Keeps retrying on a capped interval: a long-lived API must recover when
  // Redis comes back, while a per-call timeout still protects each request.
  retryStrategy: (times) => Math.min(times * 200, 2000),
};

const WORKER_OPTIONS = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: 10000,
  // Keep retrying forever: a worker is expected to be long-lived and to resume
  // once Redis returns. This is not busy-waiting — ioredis caps the delay.
  retryStrategy: (times) => Math.min(times * 500, 5000),
};

// ---------------------------------------------------------------------------
// Phase 4 — realtime Pub/Sub profiles.
//
// Redis Pub/Sub needs its OWN connections and must never share one with
// BullMQ:
//   * a SUBSCRIBE turns an ioredis connection into "subscriber mode", after
//     which every non-pub/sub command is rejected on that socket, so reusing
//     the BullMQ producer/worker connection would break job delivery;
//   * a subscriber must keep buffering/retrying while Redis restarts
//     (maxRetriesPerRequest: null), while the publish side must never hang a
//     request.
//
// publisher (API process): same fail-fast-but-recovering shape as the BullMQ
//   producer. A publish that cannot be delivered is reported, never thrown.
//
// subscriber (API process): LONG-LIVED and separate. Exactly ONE per process
//   feeds every connected SSE client (see config/redis.pubsub.js), so N
//   recruiters never open N Redis connections.
// ---------------------------------------------------------------------------
const PUBSUB_PUBLISHER_OPTIONS = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: true,
  enableReadyCheck: true,
  connectTimeout: 2000,
  retryStrategy: (times) => Math.min(times * 200, 2000),
};

const PUBSUB_SUBSCRIBER_OPTIONS = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: 10000,
  // Reconnect with a capped delay: the subscription is re-established by
  // ioredis automatically once the socket is back.
  retryStrategy: (times) => Math.min(times * 500, 5000),
};

const CONNECTION_OPTIONS_BY_ROLE = {
  producer: PRODUCER_OPTIONS,
  worker: WORKER_OPTIONS,
  publisher: PUBSUB_PUBLISHER_OPTIONS,
  subscriber: PUBSUB_SUBSCRIBER_OPTIONS,
};

// ioredis is an EventEmitter: a connection error with NO 'error' listener would
// surface as an unhandled error event and can take the API process down. Every
// connection therefore gets a listener that logs a sanitized line only — never
// the URL (it may contain a password) and never a stack that embeds it.
const attachErrorLogger = (client, role) => {
  client.on("error", (error) => {
    console.error(`[redis] ${role} connection error: ${error.message}`);
  });
  return client;
};

const createRedisConnection = ({ role = "producer" } = {}) => {
  const options = CONNECTION_OPTIONS_BY_ROLE[role] ?? PRODUCER_OPTIONS;
  return attachErrorLogger(new IORedis(getRedisUrl(), options), role);
};

module.exports = {
  getRedisUrl,
  getAiQueueConfig,
  createRedisConnection,
};