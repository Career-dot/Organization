/* eslint-disable no-console */
// Stage 2 verification harness: Redis + BullMQ + AI worker foundation.
//
// Run with:  npm run verify:ai-job-stage2
//
// Proves the REAL integration (no mocked queue, no fake Redis):
//   enqueue → BullMQ/Redis → separate worker process → atomic PostgreSQL claim
//
// Convention follows scripts/verifyAiJobStage1.js (CommonJS, application Prisma
// client, process.exitCode on failure) and bootstrapSuperAdmin.js (manual
// scripts/ entry point).
//
// Safety: creates its own throwaway fixtures with a unique suffix, deletes
// exactly what it created, removes only the Redis queue records it added, and
// never resets/migrates the database. Platform row totals are printed before and
// after.
//
// Requires a reachable Redis at REDIS_URL (the project's ai-platform-redis
// container) and a running PostgreSQL.
require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Worker } = require("bullmq");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const aiJobRepository = require("../src/module/ai-job/aiJob.repository");
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const { createRedisConnection, getAiQueueConfig, getRedisUrl } = require("../src/config/redis");
const {
  attachJobCandidateList,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

const BACKEND_ROOT = path.join(__dirname, "..");
const WORKER_ENTRY = path.join(BACKEND_ROOT, "src", "ai-worker.js");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
process.env.AI_QUEUE_PREFIX = `stage2-${SUFFIX}`;

// --- reporting -------------------------------------------------------------

const results = [];

const section = (title) => console.log(`\n${title}`);

const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  console.log(!ok && detail ? `${line}\n        -> ${detail}` : line);
};

const jsonEqual = (actual, expected) => {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
};

const summarize = (value) => JSON.stringify(value ?? null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label, probe, { timeoutMs = 20000, intervalMs = 150 } = {}) => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await sleep(intervalMs);
  }
};

// --- fixtures (same shape as the Stage 1 harness) --------------------------

const READY_PAYLOAD = {
  title: "Senior Backend Engineer",
  yearsExperience: 7,
  description: "Own the billing platform end to end, including ledger correctness and payment integrations.",
  analysisDays: 4,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }, { name: "GitHub Actions" }],
  questions: [
    { question: "Describe the most complex database transaction you have designed." },
    { question: "How do you investigate a slow production query?" },
  ],
};

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  aiJobIds: [],
  queueJobIds: [],
};

const children = [];
const tempFiles = [];

const createRecruiterFixture = async (label, jobPostingLimit = 20) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Stage2 Harness ${label}`,
      email: `stage2-aijob-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Stage2 Harness Plan ${label} ${SUFFIX}`,
      type: "RECRUITER",
      price: 0,
      billingCycle: "MONTHLY",
      jobPostingLimit,
    },
  });

  const subscription = await prisma.subscription.create({
    data: {
      planId: plan.id,
      userId: user.id,
      status: "ACTIVE",
      startDate: new Date(),
      expiryDate: new Date(Date.now() + 30 * DAY_IN_MS),
    },
  });

  tracked.userIds.push(user.id);
  tracked.planIds.push(plan.id);
  tracked.subscriptionIds.push(subscription.id);

  return { user: { id: user.id, role: "RECRUITER" }, subscription };
};

const createDraftFixture = async (recruiter, payload = READY_PAYLOAD) => {
  const draft = await jobService.createDraft(recruiter.user, payload);
  tracked.jobIds.push(draft.id);
  return draft;
};

// Inserts an AiJob directly, for states the API cannot produce (terminal rows,
// JSON-null payloads). FK-safe: the job must already be tracked.
const insertAiJobRow = async ({ jobId, status, requestPayload }) => {
  const row = await prisma.aiJob.create({
    data: {
      jobId,
      operation: "JOB_ANALYSIS",
      status,
      requestPayload: requestPayload === undefined ? { operation: "JOB_ANALYSIS", input: {} } : requestPayload,
    },
  });

  tracked.aiJobIds.push(row.id);
  return row;
};

// --- worker process control -------------------------------------------------

const startWorkerProcess = ({ env = {}, label = "worker", entry = path.join(__dirname, "fixtures", "stage2ClaimWorker.js") } = {}) => {
  const child = spawn(process.execPath, [entry], {
    cwd: BACKEND_ROOT,
    // Inherit the harness environment, then apply overrides. Nothing sensitive
    // is added: the worker's own banner redacts the Redis URL.
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.label = label;
  child.output = "";

  const capture = (chunk) => {
    child.output += chunk.toString();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  children.push(child);
  return child;
};

const stopWorkerProcess = async (child, signal = "SIGTERM") => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return child?.exitCode ?? null;
  }

  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill(signal);

  // On Windows libuv terminates the process instead of delivering SIGTERM, so a
  // timeout here is expected rather than a failure.
  return Promise.race([exited, sleep(6000).then(() => "timeout")]);
};

// --- queue inspection -------------------------------------------------------

const ALL_QUEUE_STATES = [
  "waiting",
  "waiting-children",
  "active",
  "delayed",
  "prioritized",
  "completed",
  "failed",
];

const queueJobsForAiJob = async (aiJobId) => {
  const queue = aiJobQueue.getAiJobQueue();
  const jobs = await queue.getJobs(ALL_QUEUE_STATES, 0, -1);
  return jobs.filter((job) => job?.data?.aiJobId === aiJobId);
};

const queueJobState = async (queueJobId) => {
  const queue = aiJobQueue.getAiJobQueue();
  const job = await queue.getJob(queueJobId);
  return job ? job.getState() : null;
};

// --- Scenario A: enqueue ----------------------------------------------------

const scenarioA = async (recruiter) => {
  section("A. Enqueue — Start commits AiJob PENDING and hands only its id to BullMQ");

  const draft = await createDraftFixture(recruiter);
  // Start now REQUIRES a candidate Excel sheet; attach one through the
  // production upload path so the enqueue contract below is unchanged.
  await attachJobCandidateList(recruiter, draft.id);
  // The real Start path: PostgreSQL transaction first, then the queue.
  const started = await jobService.startJob(recruiter.user, draft.id);
  const aiJobId = started.aiJob.id;
  tracked.aiJobIds.push(aiJobId);

  const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check("AiJob row exists and is PENDING", row?.status === "PENDING", `status=${row?.status}`);
  check("Start reported the AiJob as PENDING", started.aiJob.status === "PENDING", summarize(started.aiJob));

  const queued = await aiJobQueue.findQueuedAiJob(aiJobId);
  check("BullMQ holds a job for this AiJob (real Redis)", Boolean(queued), `job=${summarize(queued?.id)}`);
  check(
    "queue job id is deterministic: aiJob-<aiJobId>",
    queued?.id === `aiJob-${aiJobId}`,
    `queue id=${queued?.id}`
  );
  check(
    "queue payload is EXACTLY { aiJobId } (no requestPayload in Redis)",
    jsonEqual(queued?.data, { aiJobId }) && Object.keys(queued?.data ?? {}).length === 1,
    summarize(queued?.data)
  );

  const payloadText = JSON.stringify(queued?.data ?? {});
  const forbidden = ["title", "description", "skills", "tools", "questions", "requestPayload", "recruiterId", "subscription"];
  const leaked = forbidden.filter((key) => payloadText.includes(key));
  check("queue payload leaks no business/recruiter data", leaked.length === 0, `leaked: ${leaked.join(", ")}`);

  const { maxAttempts, retryBaseDelayMs } = getAiQueueConfig();
  check(
    `queue job carries the env retry budget (attempts=${maxAttempts}, ${aiJobQueue.AI_BACKOFF_STRATEGY})`,
    queued?.opts?.attempts === maxAttempts && queued?.opts?.backoff?.type === aiJobQueue.AI_BACKOFF_STRATEGY,
    summarize({ attempts: queued?.opts?.attempts, backoff: queued?.opts?.backoff, base: retryBaseDelayMs })
  );

  const again = await aiJobQueue.enqueueAiJob(aiJobId);
  check("re-enqueue returns the same deterministic queue id", again.queueJobId === `aiJob-${aiJobId}`, summarize(again));
  check(
    "re-enqueue did NOT create a second queue record",
    (await queueJobsForAiJob(aiJobId)).length === 1,
    `records=${(await queueJobsForAiJob(aiJobId)).length}`
  );

  const stillPending = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check(
    "AiJob stays PENDING while no worker runs (the queue alone never advances business state)",
    stillPending?.status === "PENDING" && stillPending?.attempts === 0 && stillPending?.workerId === null,
    summarize({ status: stillPending?.status, attempts: stillPending?.attempts, workerId: stillPending?.workerId })
  );

  return { draft, aiJobId };
};

// --- Scenario B: worker claim ----------------------------------------------

const scenarioB = async (aiJobId) => {
  section("B. Worker claim — a separate process moves PENDING → PROCESSING exactly once");

  const child = startWorkerProcess({ label: "worker-main" });

  await waitFor("worker startup banner", () => child.output.includes("waiting for jobs"));
  check(
    "worker runs as a separate process with its own pid",
    typeof child.pid === "number" && child.pid > 0,
    `pid=${child.pid}`
  );
  check("worker logs the queue name", child.output.includes(`Queue: ${aiJobQueue.AI_JOB_QUEUE_NAME}`));
  check("worker logs its concurrency", child.output.includes(`Concurrency: ${getAiQueueConfig().concurrency}`));
  check("worker logs a unique worker id", /Worker ID: ai-worker:.+:\d+/.test(child.output));

  const claimed = await waitFor("AiJob to be claimed", async () => {
    const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
    return row?.status === "PROCESSING" ? row : null;
  });

  check("status moved PENDING → PROCESSING", claimed.status === "PROCESSING", `status=${claimed.status}`);
  check("attempts incremented exactly once", claimed.attempts === 1, `attempts=${claimed.attempts}`);
  check("startedAt was populated", claimed.startedAt instanceof Date, `startedAt=${claimed.startedAt}`);
  check(
    "workerId identifies the claiming process (ai-worker:<host>:<pid>)",
    claimed.workerId === `ai-worker:${os.hostname()}:${child.pid}`,
    `workerId=${claimed.workerId} (expected pid ${child.pid})`
  );
  check("lastError is null after a successful claim", claimed.lastError === null, `lastError=${claimed.lastError}`);

  await waitFor("worker claim log", () => child.output.includes(`claimed AiJob ${aiJobId}`));
  check("worker logged the claim", child.output.includes(`claimed AiJob ${aiJobId}`));
  check(
    "worker states plainly that AI execution is not implemented in Stage 2",
    child.output.includes("AI execution not implemented in Stage 2")
  );

  const forbiddenLog = ["postgresql://", "GEMINI", "DATABASE_URL", "JWT_SECRET", "SMTP_PASSWORD"];
  const leakedLog = forbiddenLog.filter((needle) => child.output.includes(needle));
  check("worker logs no credentials/connection strings", leakedLog.length === 0, `leaked: ${leakedLog.join(", ")}`);

  return child;
};

// --- Scenario C: duplicate delivery ----------------------------------------

const scenarioC = async (aiJobId, workerChild, expectedWorkerId) => {
  section("C. Duplicate delivery — at-least-once delivery, exactly-one claim");

  const queue = aiJobQueue.getAiJobQueue();

  // Force a REAL second delivery of the same AiJob under a different queue id.
  // This is what an at-least-once redelivery looks like, and the deterministic
  // jobId cannot prevent it — which is exactly why the database claim exists.
  const forcedQueueId = `duplicate-${aiJobId}`;
  tracked.queueJobIds.push(forcedQueueId);
  await queue.add(aiJobQueue.AI_JOB_QUEUE_JOB_NAME, { aiJobId }, { jobId: forcedQueueId, attempts: 1 });

  await waitFor("forced duplicate to be handled", async () => (await queueJobState(forcedQueueId)) === "completed");

  const afterDuplicate = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check("duplicate delivery did not change the status", afterDuplicate.status === "PROCESSING", `status=${afterDuplicate.status}`);
  check(
    "duplicate delivery did NOT increment attempts",
    afterDuplicate.attempts === 1,
    `attempts=${afterDuplicate.attempts}`
  );
  check(
    "duplicate delivery did not steal the claim",
    afterDuplicate.workerId === expectedWorkerId,
    `workerId=${afterDuplicate.workerId}`
  );
  check(
    "worker logged that it ignored an AiJob already claimed by another delivery",
    workerChild.output.includes(`already claimed by ${expectedWorkerId}`)
  );

  // Database-level proof, independent of the worker process: the conditional
  // UPDATE refuses to hand out a second claim.
  const secondClaim = await aiJobRepository.claimAiJobForProcessing({
    aiJobId,
    workerId: "probe:harness-second-claim",
  });
  check("a second atomic claim is refused (0 rows updated)", secondClaim === null);

  const afterProbe = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check(
    "the refused claim left attempts/workerId untouched",
    afterProbe.attempts === 1 && afterProbe.workerId === expectedWorkerId,
    summarize({ attempts: afterProbe.attempts, workerId: afterProbe.workerId })
  );

  // Deterministic id: repeated enqueues must not pile up queue records.
  await aiJobQueue.enqueueAiJob(aiJobId);
  await aiJobQueue.enqueueAiJob(aiJobId);
  check(
    "repeated enqueues produced no additional deterministic queue record",
    (await queueJobsForAiJob(aiJobId)).length === 2,
    `records=${(await queueJobsForAiJob(aiJobId)).length} (expected 2: original + forced duplicate)`
  );
};

// --- Scenario D: missing AiJob (orphan queue message) ----------------------

const scenarioD = async (workerChild) => {
  section("D. Missing AiJob — an orphaned queue message is acked without creating state");

  const ghostId = `missing-aijob-${SUFFIX}`;
  tracked.queueJobIds.push(`aiJob-${ghostId}`);

  const rowsBefore = await prisma.aiJob.count({ where: { id: { in: tracked.aiJobIds } } });

  await aiJobQueue.enqueueAiJob(ghostId);
  await waitFor(
    "orphan message to be acknowledged",
    async () => (await queueJobState(`aiJob-${ghostId}`)) === "completed"
  );

  check("no AiJob row was created from queue data", (await prisma.aiJob.count({ where: { id: ghostId } })) === 0);
  check(
    "the tracked AiJob row count is unchanged",
    (await prisma.aiJob.count({ where: { id: { in: tracked.aiJobIds } } })) === rowsBefore
  );
  check(
    "worker logged the orphan as ignored",
    workerChild.output.includes(`ignoring orphaned message for missing AiJob ${ghostId}`)
  );
  check(
    "the orphan message was acknowledged, not retried",
    (await queueJobState(`aiJob-${ghostId}`)) === "completed"
  );
};

// --- Scenario E: terminal states -------------------------------------------

const scenarioE = async (recruiter, workerChild) => {
  section("E. Terminal AiJobs — COMPLETED/FAILED rows are never processed again");

  const failedDraft = await createDraftFixture(recruiter);
  const completedDraft = await createDraftFixture(recruiter);

  const failedRow = await insertAiJobRow({ jobId: failedDraft.id, status: "FAILED" });
  const completedRow = await insertAiJobRow({ jobId: completedDraft.id, status: "COMPLETED" });

  // Pre-existing bookkeeping that must survive untouched.
  await prisma.aiJob.update({
    where: { id: failedRow.id },
    data: { lastError: "pre-existing terminal failure", completedAt: new Date() },
  });

  tracked.queueJobIds.push(`aiJob-${failedRow.id}`, `aiJob-${completedRow.id}`);
  await aiJobQueue.enqueueAiJob(failedRow.id);
  await aiJobQueue.enqueueAiJob(completedRow.id);

  await waitFor("terminal rows to be acknowledged", async () => {
    const [a, b] = await Promise.all([
      queueJobState(`aiJob-${failedRow.id}`),
      queueJobState(`aiJob-${completedRow.id}`),
    ]);
    return a === "completed" && b === "completed";
  });

  const failedAfter = await prisma.aiJob.findUnique({ where: { id: failedRow.id } });
  const completedAfter = await prisma.aiJob.findUnique({ where: { id: completedRow.id } });

  check(
    "FAILED row untouched (status, attempts, workerId, startedAt)",
    failedAfter.status === "FAILED" &&
      failedAfter.attempts === 0 &&
      failedAfter.workerId === null &&
      failedAfter.startedAt === null,
    summarize({
      status: failedAfter.status,
      attempts: failedAfter.attempts,
      workerId: failedAfter.workerId,
      startedAt: failedAfter.startedAt,
    })
  );
  check(
    "FAILED row's lastError is preserved",
    failedAfter.lastError === "pre-existing terminal failure",
    `lastError=${failedAfter.lastError}`
  );
  check(
    "COMPLETED row untouched and still has no fabricated result",
    completedAfter.status === "COMPLETED" &&
      completedAfter.attempts === 0 &&
      completedAfter.workerId === null &&
      completedAfter.result === null,
    summarize({
      status: completedAfter.status,
      attempts: completedAfter.attempts,
      workerId: completedAfter.workerId,
      result: completedAfter.result,
    })
  );
  check(
    "worker logged both terminal ignores",
    workerChild.output.includes("in terminal state FAILED") &&
      workerChild.output.includes("in terminal state COMPLETED")
  );
};

// --- Scenario F: no fake AI -------------------------------------------------

const scenarioF = async (aiJobId, workerChild) => {
  section("F. No fake AI — placeholder processing fabricates nothing");

  const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });

  check("result is still null (no fabricated analysis)", row.result === null, summarize(row.result));
  check("provider is still null (no provider was called or selected)", row.provider === null, summarize(row.provider));
  check("completedAt is still null", row.completedAt === null, summarize(row.completedAt));
  check("status is NOT COMPLETED", row.status !== "COMPLETED", `status=${row.status}`);
  check("status remains PROCESSING (deliberate non-terminal placeholder)", row.status === "PROCESSING", `status=${row.status}`);
  check(
    "the authoritative Stage-1 snapshot is untouched in PostgreSQL",
    row.requestPayload?.input?.title === READY_PAYLOAD.title,
    summarize(row.requestPayload?.input?.title)
  );

  // Static guarantee: the delivery layer references no AI SDK or provider.
  const files = [
    "src/ai-worker.js",
    "src/module/ai-job/aiJob.queue.js",
    "src/module/ai-job/aiJob.repository.js",
    "src/config/redis.js",
  ];
  const providerPatterns = [
    "@google/genai",
    "openai",
    "anthropic",
    "gemini",
    "langchain",
    "fastapi",
    "flask",
    "axios",
    "node-fetch",
  ];

  const offenders = [];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
    for (const pattern of providerPatterns) {
      if (source.toLowerCase().includes(pattern)) {
        offenders.push(`${relative}:${pattern}`);
      }
    }
  }

  check("no provider SDK / AI client referenced in the Stage-2 delivery layer", offenders.length === 0, offenders.join(", "));
  check("worker output never mentions a provider", !/gemini|openai|anthropic/i.test(workerChild.output));
};

// --- Scenario G: Redis unavailable AFTER the database commit ---------------

const scenarioG = async (recruiter) => {
  section("G. Redis unavailable after commit — committed database state must survive");

  const originalUrl = process.env.REDIS_URL;

  // Drop the current producer so the next enqueue builds a fresh connection,
  // then point it at a port where nothing listens. This drives the REAL
  // production code path (config comes from REDIS_URL) with no test hooks.
  await aiJobQueue.closeAiJobQueue();
  process.env.REDIS_URL = "redis://127.0.0.1:6399";

  const draft = await createDraftFixture(recruiter);
  // Candidate validation runs BEFORE the queue hand-off: with the candidate
  // list attached, the failure below is the real 425 queue-unavailable path.
  await attachJobCandidateList(recruiter, draft.id);
  const usedBefore = await prisma.jobQuotaConsumption.count({
    where: { subscriptionId: recruiter.subscription.id },
  });

  const startedAt = Date.now();
  let caught = null;
  try {
    await jobService.startJob(recruiter.user, draft.id);
  } catch (error) {
    caught = error;
  }
  const elapsedMs = Date.now() - startedAt;

  check(
    "Start reports a queue-unavailable condition (HTTP 425)",
    caught?.status === 425,
    `${caught?.status}: ${caught?.message}`
  );
  check(
    "the condition is tagged AI_QUEUE_UNAVAILABLE (not a generic 500)",
    caught?.code === aiJobQueue.AI_QUEUE_UNAVAILABLE_CODE,
    `code=${caught?.code}`
  );
  check(
    "the error carries the durable facts (job id, AiJob id, still PENDING, queued:false)",
    caught?.queued === false && caught?.aiJobStatus === "PENDING" && typeof caught?.aiJobId === "string",
    summarize({ queued: caught?.queued, aiJobStatus: caught?.aiJobStatus, aiJobId: caught?.aiJobId })
  );
  check(
    `the request failed fast instead of buffering on Redis (${elapsedMs}ms)`,
    elapsedMs < 15000,
    `elapsed=${elapsedMs}ms`
  );

  const jobRow = await prisma.job.findUnique({ where: { id: draft.id } });
  check(
    "Job is STILL ACTIVE — the failed delivery did not roll back the transaction",
    jobRow.status === "ACTIVE",
    `status=${jobRow.status}`
  );
  check("Job.startedAt survived", jobRow.startedAt instanceof Date, summarize(jobRow.startedAt));

  const usedAfter = await prisma.jobQuotaConsumption.count({
    where: { subscriptionId: recruiter.subscription.id },
  });
  check(
    "quota was consumed exactly once (no rollback, no re-consumption)",
    usedAfter === usedBefore + 1,
    `before=${usedBefore} after=${usedAfter}`
  );
  check(
    "exactly one consumption row for this job",
    (await prisma.jobQuotaConsumption.count({ where: { jobId: draft.id } })) === 1
  );

  const aiJob = await prisma.aiJob.findFirst({ where: { jobId: draft.id } });
  check("AiJob still exists and is PENDING (the recovery anchor)", aiJob?.status === "PENDING", `status=${aiJob?.status}`);
  check("AiJob was not deleted or duplicated", (await prisma.aiJob.count({ where: { jobId: draft.id } })) === 1);
  check(
    "AiJob was not faked to COMPLETED and holds no result",
    aiJob?.status !== "COMPLETED" && aiJob?.result === null,
    summarize({ status: aiJob?.status, result: aiJob?.result })
  );
  tracked.aiJobIds.push(aiJob.id);

  // Recovery: once Redis is reachable again, the still-PENDING row can be
  // delivered without touching Job/quota.
  await aiJobQueue.closeAiJobQueue();
  process.env.REDIS_URL = originalUrl;

  const requeued = await aiJobQueue.enqueueAiJob(aiJob.id);
  tracked.queueJobIds.push(requeued.queueJobId);
  check(
    "after Redis recovers, the PENDING AiJob can be re-enqueued (reconciliation is possible)",
    requeued.queueJobId === `aiJob-${aiJob.id}`,
    summarize(requeued)
  );
  check("the recovered AiJob is present in BullMQ again", Boolean(await aiJobQueue.findQueuedAiJob(aiJob.id)));

  return aiJob.id;
};

// --- Scenario H: terminal failure end-to-end (through the real worker) -----

const scenarioH = async (recruiter) => {
  section("H. Terminal failure end-to-end — PROCESSING → FAILED, never stranded");

  const draft = await createDraftFixture(recruiter);
  const aiJob = await insertAiJobRow({ jobId: draft.id, status: "PENDING" });

  // Force a terminal processing failure with no test hooks in production code:
  // store a JSON null as the payload. The column is NOT NULL, but the JSON
  // scalar null is a legal jsonb value, so runPlaceholderProcessing rejects it.
  await prisma.$executeRaw`UPDATE "AiJob" SET "requestPayload" = 'null'::jsonb WHERE "id" = ${aiJob.id}`;

  const stored = await prisma.aiJob.findUnique({ where: { id: aiJob.id } });
  check(
    "harness stored a JSON-null payload (JSON null is not SQL NULL)",
    stored.requestPayload === null,
    summarize(stored.requestPayload)
  );

  const child = startWorkerProcess({ label: "worker-terminal" });
  await waitFor("terminal-test worker ready", () => child.output.includes("waiting for jobs"));

  tracked.queueJobIds.push(`aiJob-${aiJob.id}`);
  await aiJobQueue.enqueueAiJob(aiJob.id);

  const failed = await waitFor("AiJob to reach FAILED", async () => {
    const row = await prisma.aiJob.findUnique({ where: { id: aiJob.id } });
    return row?.status === "FAILED" ? row : null;
  });

  check("status moved PROCESSING → FAILED", failed.status === "FAILED", `status=${failed.status}`);
  check(
    "lastError records the terminal reason",
    failed.lastError === "AI_REQUEST_INVALID",
    `lastError=${failed.lastError}`
  );
  check("completedAt (finished-at) was stamped", failed.completedAt instanceof Date, summarize(failed.completedAt));
  check("attempts recorded exactly one claim", failed.attempts === 1, `attempts=${failed.attempts}`);
  check("workerId was released on the terminal transition", failed.workerId === null, `workerId=${failed.workerId}`);
  check(
    "the failure is not stranded in PROCESSING",
    failed.status !== "PROCESSING" && failed.status !== "PENDING"
  );
  check("no result/provider fabricated on failure", failed.result === null && failed.provider === null);

  await waitFor("queue job to be marked failed", async () => (await queueJobState(`aiJob-${aiJob.id}`)) === "failed");
  const queueJob = await aiJobQueue.getAiJobQueue().getJob(`aiJob-${aiJob.id}`);
  check(
    "UnrecoverableError: the queue job is failed without consuming the retry budget",
    queueJob?.attemptsMade === 1,
    `attemptsMade=${queueJob?.attemptsMade}`
  );
  check(
    "worker logged the terminal failure for this AiJob",
    child.output.includes(`terminal failure for ${aiJob.id}`),
    `output tail: ${child.output.slice(-400).replace(/\n/g, " | ")}`
  );
  // The terminal worker also consumed the Scenario-G recovery message, whose
  // placeholder acknowledgement is legitimate — so the "no placeholder
  // acknowledgement" assertion is scoped to THIS row, not the whole output.
  check(
    "the terminal AiJob was never acknowledged as placeholder-processed",
    !new RegExp(`AI job claimed[^\\n]*${aiJob.id}`).test(child.output)
  );

  await stopWorkerProcess(child);
  return aiJob.id;
};

// --- Scenario I: retry/backoff + claim state machine -----------------------

const scenarioI = async (recruiter) => {
  section("I. Retry/backoff + claim state machine + stale recovery");

  const { retryBaseDelayMs, retryMaxDelayMs } = getAiQueueConfig();

  // I1 — backoff maths (the same shared function the queue and worker use).
  const delays = [1, 2, 3, 4, 10].map((attempt) => aiJobQueue.getAiBackoffDelay(attempt));
  check(
    "backoff is exponential from the configured base (1x, 2x, 4x)",
    delays[0] === retryBaseDelayMs && delays[1] === 2 * retryBaseDelayMs && delays[2] === 4 * retryBaseDelayMs,
    summarize(delays)
  );
  check(
    `backoff is capped at AI_RETRY_MAX_DELAY_MS (${retryMaxDelayMs}ms)`,
    delays[3] <= retryMaxDelayMs && delays[4] === retryMaxDelayMs,
    summarize(delays)
  );

  // I2 — the claim/release/fail state machine on a real row.
  const draft = await createDraftFixture(recruiter);
  const row = await insertAiJobRow({ jobId: draft.id, status: "PENDING" });

  const firstClaim = await aiJobRepository.claimAiJobForProcessing({
    aiJobId: row.id,
    workerId: "probe:harness-1",
  });
  check(
    "first claim: PENDING → PROCESSING with attempts=1, workerId and startedAt",
    firstClaim?.status === "PROCESSING" &&
      firstClaim?.attempts === 1 &&
      firstClaim?.workerId === "probe:harness-1" &&
      firstClaim?.startedAt instanceof Date,
    summarize({ status: firstClaim?.status, attempts: firstClaim?.attempts, workerId: firstClaim?.workerId })
  );

  const released = await aiJobRepository.releaseAiJobForRetry({
    aiJobId: row.id,
    workerId: "probe:harness-1",
    lastError: "induced retryable failure",
  });
  const afterRelease = await prisma.aiJob.findUnique({ where: { id: row.id } });
  check(
    "retryable failure returns the row to PENDING (never left stuck in PROCESSING)",
    released === 1 && afterRelease.status === "PENDING" && afterRelease.workerId === null && afterRelease.startedAt === null,
    summarize({ released, status: afterRelease.status, workerId: afterRelease.workerId })
  );
  check("the retryable reason is recorded in lastError", afterRelease.lastError === "induced retryable failure");
  check("attempts is preserved across a retry (history not reset)", afterRelease.attempts === 1, `attempts=${afterRelease.attempts}`);

  const secondClaim = await aiJobRepository.claimAiJobForProcessing({
    aiJobId: row.id,
    workerId: "probe:harness-2",
  });
  check(
    "the retry is claimable again and attempts becomes 2",
    secondClaim?.attempts === 2 && secondClaim?.status === "PROCESSING",
    summarize({ attempts: secondClaim?.attempts, status: secondClaim?.status })
  );
  check("a new claim clears the previous attempt's lastError", secondClaim?.lastError === null);

  const failedCount = await aiJobRepository.markAiJobFailed({
    aiJobId: row.id,
    workerId: "probe:harness-2",
    lastError: "induced terminal failure",
  });
  const afterFail = await prisma.aiJob.findUnique({ where: { id: row.id } });
  check(
    "terminal failure: PROCESSING → FAILED with lastError and completedAt",
    failedCount === 1 &&
      afterFail.status === "FAILED" &&
      afterFail.lastError === "induced terminal failure" &&
      afterFail.completedAt instanceof Date,
    summarize({ failedCount, status: afterFail.status, lastError: afterFail.lastError })
  );
  check(
    "a terminal row can never be claimed again",
    (await aiJobRepository.claimAiJobForProcessing({ aiJobId: row.id, workerId: "probe:harness-3" })) === null
  );
  check(
    "markAiJobFailed is idempotent (a terminal row is not re-marked)",
    (await aiJobRepository.markAiJobFailed({ aiJobId: row.id, lastError: "second attempt to mark" })) === 0
  );

  // I3 — stale PROCESSING detection and reclaim.
  const staleDraft = await createDraftFixture(recruiter);
  const staleRow = await insertAiJobRow({ jobId: staleDraft.id, status: "PROCESSING" });
  // Parameterized JS Dates, not server-side now() arithmetic: the application
  // always writes absolute UTC instants, and findStaleProcessingAiJobs compares
  // stored timestamps against Node's Date.now() — so the fixture must be built
  // the same way, immune to the database session's TimeZone setting.
  const abandonedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.aiJob.update({
    where: { id: staleRow.id },
    data: { workerId: "dead-worker", startedAt: abandonedAt, updatedAt: abandonedAt },
  });

  const stale = await aiJobRepository.findStaleProcessingAiJobs({ olderThanMs: 60_000 });
  check("a long-abandoned PROCESSING row is detected as stale", stale.some((item) => item.id === staleRow.id));

  const reclaimed = await aiJobRepository.reclaimStaleAiJobForRetry({
    aiJobId: staleRow.id,
    reason: "reclaimed by harness",
  });
  const afterReclaim = await prisma.aiJob.findUnique({ where: { id: staleRow.id } });
  check(
    "stale PROCESSING → PENDING so it can be delivered again",
    reclaimed === 1 &&
      afterReclaim.status === "PENDING" &&
      afterReclaim.workerId === null &&
      afterReclaim.lastError === "reclaimed by harness",
    summarize({ reclaimed, status: afterReclaim.status, workerId: afterReclaim.workerId })
  );
  check(
    "reclaim is a no-op for a row that is no longer PROCESSING",
    (await aiJobRepository.reclaimStaleAiJobForRetry({ aiJobId: staleRow.id, reason: "again" })) === 0
  );

  const freshDraft = await createDraftFixture(recruiter);
  const freshRow = await insertAiJobRow({ jobId: freshDraft.id, status: "PROCESSING" });
  const staleNow = await aiJobRepository.findStaleProcessingAiJobs({ olderThanMs: 60_000 });
  check(
    "a freshly-claimed PROCESSING row is NOT treated as stale",
    !staleNow.some((item) => item.id === freshRow.id),
    `stale rows found: ${staleNow.length}`
  );

  // I4 — real BullMQ retry + backoff through real Redis. A harness-owned worker
  // reuses the SAME queue configuration and backoff registry, with a processor
  // that always throws, so the retry mechanics are exercised rather than merely
  // read back from configuration.
  const probeQueueId = `retry-probe-${SUFFIX}`;
  const probeJobId = `retry-probe-aijob-${SUFFIX}`;
  tracked.queueJobIds.push(probeQueueId);

  const probeBaseDelayMs = 250;
  const queue = aiJobQueue.getAiJobQueue();

  await queue.add(
    aiJobQueue.AI_JOB_QUEUE_JOB_NAME,
    { aiJobId: probeJobId },
    {
      jobId: probeQueueId,
      attempts: 2,
      backoff: { type: aiJobQueue.AI_BACKOFF_STRATEGY, delay: probeBaseDelayMs },
    }
  );

  const probeStartedAt = Date.now();
  const connection = createRedisConnection({ role: "worker" });
  const probeWorker = new Worker(
    aiJobQueue.AI_JOB_QUEUE_NAME,
    async () => {
      throw new Error("harness induced retryable failure");
    },
    {
      connection,
      prefix: getAiQueueConfig().prefix,
      concurrency: 1,
      settings: { backoffStrategy: aiJobQueue.AI_BACKOFF_STRATEGIES.aiExponential },
    }
  );

  try {
  const probeJob = await waitFor(
    "probe job to exhaust its attempts",
    async () => {
      const job = await queue.getJob(probeQueueId);
      return job && (await job.getState()) === "failed" ? queue.getJob(probeQueueId) : null;
    },
    { timeoutMs: 25000 }
  );
  const probeElapsedMs = Date.now() - probeStartedAt;

  check(
    "BullMQ retried the job up to the configured attempts",
    probeJob.attemptsMade === 2,
    `attemptsMade=${probeJob.attemptsMade}`
  );
  check(
    `backoff delay was actually applied between attempts (>= ${probeBaseDelayMs}ms)`,
    probeElapsedMs >= probeBaseDelayMs,
    `elapsed=${probeElapsedMs}ms`
  );
  check(
    "the custom capped-exponential strategy is registered (no 'Unknown backoff strategy')",
    !/unknown backoff strategy/i.test(String(probeJob.failedReason ?? "")),
    `failedReason=${probeJob.failedReason}`
  );
  check(
    "the exhausted queue job is observable in the failed set",
    (await queueJobState(probeQueueId)) === "failed"
  );
  check("the harness retry probe never touched a database row", (await prisma.aiJob.count({ where: { id: probeJobId } })) === 0);

  } finally {
    await probeWorker.close();
    connection.disconnect();
  }
};

// --- Scenario J: graceful shutdown -----------------------------------------

const scenarioJ = async () => {
  section("J. Graceful shutdown — worker closes worker/queue/Redis/Prisma cleanly");

  // The SIGINT/SIGTERM handlers call the runtime's shutdown(). Windows/libuv
  // TERMINATES a child process instead of delivering SIGTERM, so a signal cannot
  // be used to exercise the handler body here. Instead the real worker entry
  // point is loaded in a real separate process and the SAME shutdown routine the
  // signals invoke is called — so the whole shutdown implementation runs, only
  // the signal-delivery step is substituted.
  const runnerPath = path.join(os.tmpdir(), `stage2-shutdown-runner-${SUFFIX}.js`);
  tempFiles.push(runnerPath);
  fs.writeFileSync(
    runnerPath,
    [
      `const { startAiJobWorker } = require(${JSON.stringify(WORKER_ENTRY)});`,
      'startAiJobWorker().then((runtime) => { setTimeout(() => runtime.shutdown("SIGTERM"), 1500); });',
      "",
    ].join("\n"),
    "utf8"
  );

  const child = startWorkerProcess({ label: "worker-shutdown", entry: runnerPath });

  const exit = await waitFor(
    "worker process to exit after shutdown",
    () => (child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : null),
    { timeoutMs: 25000 }
  );

  check("the worker exited cleanly with code 0", exit.code === 0, summarize(exit));
  check("shutdown stopped accepting new work", child.output.includes("no new jobs will be accepted"));
  check("the BullMQ worker was closed", child.output.includes("worker closed"));
  check("the queue producer/Redis connection was closed", child.output.includes("shutdown complete"));
  check("the Prisma connection was disconnected", child.output.includes("database disconnected"));
  check("no forced/timeout exit was needed", !child.output.includes("graceful shutdown timed out"));

  // Signal wiring is verified statically because Windows cannot deliver these
  // signals to a child process.
  const workerSource = fs.readFileSync(WORKER_ENTRY, "utf8");
  check(
    "SIGINT and SIGTERM handlers are registered on the worker",
    workerSource.includes('process.on("SIGINT"') &&
      workerSource.includes('process.on("SIGTERM"') &&
      /worker\.close\(\)/.test(workerSource)
  );
};

// --- cleanup & report -------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  subscription: await prisma.subscription.count(),
  subscriptionPlan: await prisma.subscriptionPlan.count(),
});

// Removes only the Redis queue records this harness added (tracked ids plus the
// deterministic ids of its own AiJobs). Unrelated queue records are untouched.
const removeHarnessQueueJobs = async () => {
  const removed = [];

  try {
    const queue = aiJobQueue.getAiJobQueue();
    const ids = new Set(tracked.queueJobIds);
    for (const aiJobId of tracked.aiJobIds) {
      ids.add(`aiJob-${aiJobId}`);
    }

    for (const id of ids) {
      const job = await queue.getJob(id);
      if (job) {
        await job.remove();
        removed.push(id);
      }
    }
  } catch (error) {
    console.error(`  queue cleanup issue: ${error.message}`);
  }

  return removed;
};

// FK-safe order: AiJob and JobQuotaConsumption reference Job with Restrict, and
// Job references User with Restrict. Every statement is scoped to a tracked id.
const cleanupDatabase = async () => {
  const removed = {};

  if (tracked.jobIds.length > 0) {
    // Candidate lists (JobCandidateList + StoredFile + disk content) must be
    // removed BEFORE job rows: the candidateList.jobId FK is Restrict.
    Object.assign(removed, await cleanupJobCandidateLists(prisma, tracked.jobIds));
    // Scoped by jobId as well as by id: an AiJob created by Start is committed
    // before the queue call, so it must be removed even if the scenario aborted
    // before the harness could track its id.
    removed.aiJob = (
      await prisma.aiJob.deleteMany({
        where: {
          OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }],
        },
      })
    ).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
    ).count;
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: tracked.jobIds } } })).count;
  }
  if (tracked.subscriptionIds.length > 0) {
    removed.subscription = (
      await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } })
    ).count;
  }
  if (tracked.planIds.length > 0) {
    removed.subscriptionPlan = (
      await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } })
    ).count;
  }
  if (tracked.userIds.length > 0) {
    removed.user = (await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } })).count;
  }

  return removed;
};

const countLeftovers = async () => {
  const [jobs, aiJobs, consumptions, subscriptions, plans, users] = await Promise.all([
    prisma.job.count({ where: { id: { in: tracked.jobIds } } }),
    prisma.aiJob.count({
      where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }] },
    }),
    prisma.jobQuotaConsumption.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.subscription.count({ where: { id: { in: tracked.subscriptionIds } } }),
    prisma.subscriptionPlan.count({ where: { id: { in: tracked.planIds } } }),
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
  ]);

  return (
    jobs + aiJobs + consumptions + subscriptions + plans + users +
    (await countCandidateListLeftovers(prisma, tracked.jobIds))
  );
};

const finish = async (before) => {
  section("Cleanup — stopping workers and removing everything this harness created");

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      await stopWorkerProcess(child);
    }
  }
  check(
    "all harness worker processes were stopped",
    children.every((child) => child.exitCode !== null || child.signalCode !== null),
    summarize(children.map((child) => ({ label: child.label, exit: child.exitCode, signal: child.signalCode })))
  );

  try {
    console.log(`  removed queue records: ${summarize(await removeHarnessQueueJobs())}`);
  } catch (error) {
    console.error(`  queue cleanup failed: ${error.message}`);
  }

  await aiJobQueue.closeAiJobQueue();

  try {
    console.log(`  deleted rows: ${summarize(await cleanupDatabase())}`);
    check("no harness fixture row is left behind", (await countLeftovers()) === 0);
  } catch (error) {
    check("no harness fixture row is left behind", false, error.message);
  }

  for (const file of tempFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // temp file already gone — nothing to do
    }
  }

  // Redis should hold no harness AiJob records any more.
  const leftovers = [];
  for (const aiJobId of tracked.aiJobIds) {
    const jobs = await queueJobsForAiJob(aiJobId).catch(() => []);
    if (jobs.length > 0) {
      leftovers.push(aiJobId);
    }
  }
  check("no harness queue record is left in Redis", leftovers.length === 0, `leftover=${leftovers.length}`);

  const after = await snapshotTotals();
  console.log(`\nplatform totals at start: ${summarize(before)}`);
  console.log(`platform totals at end:   ${summarize(after)}`);
  check(
    "the database was not reset (every pre-existing row count held or grew)",
    Object.keys(before).every((table) => after[table] >= before[table]),
    summarize({ before, after })
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.log("FAILED CHECKS:");
    failed.forEach((entry) => console.log(`  - ${entry.label}`));
    process.exitCode = 1;
    return;
  }

  console.log(
    "Stage 2 verified: Start → PostgreSQL AiJob PENDING → BullMQ/Redis → separate worker → atomic claim."
  );
};

const run = async () => {
  console.log("Stage 2 verification harness: Redis + BullMQ + AI worker");
  console.log(`run id: ${SUFFIX}`);
  console.log("contract: PostgreSQL AiJob is the source of truth; Redis/BullMQ is delivery only");
  console.log("Redis: configured through REDIS_URL (credentials not logged)");
  console.log(`queue: ${aiJobQueue.AI_JOB_QUEUE_NAME} | worker entrypoint: src/ai-worker.js`);

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);

  try {
    try {
      const counts = await aiJobQueue.getAiJobQueue().getJobCounts(...ALL_QUEUE_STATES);
      check("Redis is reachable at REDIS_URL (real queue inspection succeeded)", true, summarize(counts));
    } catch (error) {
      check("Redis is reachable at REDIS_URL (real queue inspection succeeded)", false, error.message);
      throw error;
    }

    const recruiter = await createRecruiterFixture("main");

    const { aiJobId } = await scenarioA(recruiter);
    const mainWorker = await scenarioB(aiJobId);
    const expectedWorkerId = `ai-worker:${os.hostname()}:${mainWorker.pid}`;

    await scenarioC(aiJobId, mainWorker, expectedWorkerId);
    await scenarioD(mainWorker);
    await scenarioE(recruiter, mainWorker);
    await scenarioF(aiJobId, mainWorker);

    // Stop the main worker before the Redis-outage scenario (G) and before the
    // retry probe (I4), which must be the only consumer of the queue.
    await stopWorkerProcess(mainWorker);

    await scenarioG(recruiter);
    await scenarioH(recruiter);
    await scenarioI(recruiter);
    await scenarioJ();
  } catch (error) {
    console.error("\nUNEXPECTED harness error:", error);
    check("every scenario ran without an unexpected error", false, error.message);
  } finally {
    await finish(before);
  }
};

run()
  .catch((error) => {
    console.error("Harness failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await aiJobQueue.closeAiJobQueue();
    await prisma.$disconnect();
  });