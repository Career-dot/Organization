/* eslint-disable no-console */
// Stage 3 verification harness: the AI execution pipeline.
//
// Run with:  npm run verify:ai-job-stage3
//
// Proves the REAL Stage 3 integration end to end (no mocked queue, no fake
// Redis, no stubbed HTTP):
//
//   Job Start → AiJob PENDING (PostgreSQL)
//             → BullMQ / Redis delivery
//             → separate Node worker process (src/ai-worker.js)
//             → HTTP to the FastAPI ai-service (real uvicorn, real ASGI stack)
//             → validated analysis
//             → AiJob COMPLETED (PostgreSQL)
//
// The ai-service is started from ai-service/tests/integration_app.py: a REAL
// FastAPI application whose only substitution is the provider. A deterministic
// in-process provider replaces Gemini, so the run needs no API key and no
// network egress. Everything else — routing, bearer auth, pydantic validation,
// the "analysis preserves the input" gate, error normalization and the whole
// HTTP transport — is the production code path.
//
// Convention follows scripts/verifyAiJobStage1.js and verifyAiJobStage2.js
// (CommonJS, the application's own Prisma client, process.exitCode on failure).
//
// Safety: creates its own throwaway fixtures with a unique suffix, deletes
// exactly what it created, removes only the Redis queue records it added, and
// never resets/migrates the database. Platform row totals are printed before and
// after.
//
// Requires: a reachable Redis at REDIS_URL, a running PostgreSQL, and the
// ai-service virtualenv at ai-service/.venv (see ai-service/requirements-dev.txt).
require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const {
  attachJobCandidateList,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");
const aiJobRepository = require("../src/module/ai-job/aiJob.repository");
const aiJobClient = require("../src/module/ai-job/aiJob.client");
const aiJobValidation = require("../src/module/ai-job/aiJob.validation");

const BACKEND_ROOT = path.join(__dirname, "..");
const AI_SERVICE_ROOT = path.join(BACKEND_ROOT, "..", "ai-service");
const PYTHON_EXE = path.join(AI_SERVICE_ROOT, ".venv", "Scripts", "python.exe");
const WORKER_ENTRY = path.join(BACKEND_ROOT, "src", "ai-worker.js");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// --- harness configuration ---------------------------------------------------
//
// An isolated queue prefix: this run can never consume work belonging to another
// harness or to a real worker, and can never leave a record where they look.
process.env.AI_QUEUE_PREFIX = `stage3-${SUFFIX}`;
// A bounded retry budget — enough to prove release → retry → terminal state,
// small enough that the whole run stays quick. These are read at call time by
// both the harness (producer) and the worker child (consumer), so the two cannot
// disagree about the retry budget.
process.env.AI_JOB_MAX_ATTEMPTS = "2";
process.env.AI_RETRY_BASE_DELAY_MS = "250";
process.env.AI_RETRY_MAX_DELAY_MS = "1000";

const aiJobQueue = require("../src/module/ai-job/aiJob.queue");

// Shared secret for this run only. It is generated in memory, handed to the AI
// service and the worker through their environments, and never written to disk.
const SERVICE_API_KEY = `stage3-${SUFFIX}`;
let serviceUrl = null;

// --- reporting ---------------------------------------------------------------

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

const waitFor = async (label, probe, { timeoutMs = 30000, intervalMs = 150 } = {}) => {
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

// --- fixtures (same shape as the Stage 1 / Stage 2 harnesses) ----------------

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  aiJobIds: [],
  queueJobIds: [],
};

const children = [];

// One payload per scenario. `title` is the only thing the deterministic test
// provider keys off, so it is the control channel for the failure-path cases.
const buildPayload = (title) => ({
  title,
  yearsExperience: 7,
  description: "Own the billing platform end to end, including ledger correctness and payment integrations.",
  analysisDays: 4,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }, { name: "GitHub Actions" }],
  questions: [{ question: "Describe the most complex database transaction you have designed." }],
});

const HARMLESS_TITLE = "Senior Backend Engineer";

const createRecruiterFixture = async (label, jobPostingLimit = 20) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Stage3 Harness ${label}`,
      email: `stage3-aijob-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Stage3 Harness Plan ${label} ${SUFFIX}`,
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

// Goes through the real API service call, so the AiJob row, the request-payload
// snapshot and the queue record are all produced by production code — not by the
// harness. startJob also enqueues, which is what makes this a true end-to-end run
// rather than a queue injection.
const startJobFixture = async (recruiter, title) => {
  const draft = await jobService.createDraft(recruiter.user, buildPayload(title));
  tracked.jobIds.push(draft.id);

  // Start now REQUIRES a candidate Excel sheet; attach one through the
  // production upload path so the end-to-end run below is unchanged.
  await attachJobCandidateList(recruiter, draft.id);

  const started = await jobService.startJob(recruiter.user, draft.id);
  tracked.aiJobIds.push(started.aiJob.id);

  return { jobId: draft.id, aiJobId: started.aiJob.id };
};

// --- process control ---------------------------------------------------------

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const attachCapture = (child, label) => {
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

const startWorkerProcess = ({ env = {}, label = "worker" } = {}) =>
  attachCapture(
    spawn(process.execPath, [WORKER_ENTRY], {
      cwd: BACKEND_ROOT,
      // Inherit the harness environment, then apply overrides. The worker needs
      // only the AI service coordinates — never a provider credential.
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    label
  );

const waitForExit = (child, timeoutMs = 10000) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  child.kill();
  if (!(await waitForExit(child))) {
    child.kill("SIGKILL");
    await waitForExit(child, 5000);
  }
  return child.exitCode !== null || child.signalCode !== null;
};

// Starts the REAL FastAPI application under uvicorn. integration_app is imported
// exactly the way pytest imports it — as a top-level module in tests/ with the
// service package on PYTHONPATH — so the harness exercises the same wiring the
// Python suite does.
const startAiService = async (settingsEnv = {}) => {
  if (!fs.existsSync(PYTHON_EXE)) {
    throw new Error(
      `ai-service virtualenv not found at ${PYTHON_EXE}; create it and install ai-service/requirements-dev.txt`
    );
  }

  const port = await findFreePort();
  serviceUrl = `http://127.0.0.1:${port}`;

  const child = attachCapture(
    spawn(
      PYTHON_EXE,
      ["-m", "uvicorn", "integration_app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"],
      {
        cwd: AI_SERVICE_ROOT,
        env: {
          ...process.env,
          ...settingsEnv,
          // Blanked on purpose: this run must prove the pipeline needs no real
          // provider credential (the deterministic provider is injected).
          GEMINI_API_KEY: "",
          PYTHONPATH: [AI_SERVICE_ROOT, path.join(AI_SERVICE_ROOT, "tests")].join(path.delimiter),
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    ),
    "ai-service"
  );

  await waitFor("ai-service to answer /health", async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`ai-service exited during startup (code ${child.exitCode}):\n${child.output}`);
    }
    try {
      return (await fetch(`${serviceUrl}/health`)).status === 200;
    } catch {
      return false;
    }
  });

  return child;
};

// --- queue inspection --------------------------------------------------------

const ALL_QUEUE_STATES = ["completed", "failed", "delayed", "active", "waiting", "prioritized"];

const queueJobState = async (queueJobId) => {
  const job = await aiJobQueue.getAiJobQueue().getJob(queueJobId);
  return job ? job.getState() : null;
};

const queueJobsForAiJob = async (aiJobId) => {
  const jobs = await aiJobQueue.getAiJobQueue().getJobs(ALL_QUEUE_STATES, 0, -1);
  return jobs.filter((job) => job?.data?.aiJobId === aiJobId);
};

// Waits until the AiJob reaches a terminal state, so assertions never race the
// worker. Returns the row it settled on.
const waitForAiJob = async (aiJobId, status, timeoutMs = 45000) =>
  waitFor(
    `AiJob ${aiJobId} to reach ${status}`,
    async () => {
      const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
      return row && row.status === status ? row : null;
    },
    { timeoutMs }
  );

// --- Scenario A: the full pipeline ------------------------------------------

const scenarioA = async (recruiter, workerChild) => {
  section("A. Happy path — Start → Redis → worker → FastAPI → validated COMPLETED");

  const { aiJobId } = await startJobFixture(recruiter, HARMLESS_TITLE);

  const pending = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check("Start committed the AiJob as PENDING", pending.status === "PENDING", `status=${pending.status}`);
  check("Start enqueued a delivery for exactly this AiJob", (await queueJobsForAiJob(aiJobId)).length === 1);
  check("the queue payload is only the identifier", jsonEqual(
    (await queueJobsForAiJob(aiJobId))[0].data, { aiJobId }
  ));

  const completed = await waitForAiJob(aiJobId, "COMPLETED");

  check("the AiJob reached COMPLETED", completed.status === "COMPLETED");
  check("attempts counted exactly one claim", completed.attempts === 1, `attempts=${completed.attempts}`);
  check("completedAt (finished-at) was stamped", completed.completedAt instanceof Date);
  check("workerId was released on completion", completed.workerId === null, `workerId=${completed.workerId}`);
  check("startedAt was cleared on completion", completed.startedAt === null, `startedAt=${completed.startedAt}`);
  check("lastError is null after success", completed.lastError === null, `lastError=${completed.lastError}`);

  // The provider identity is reported by the AI service, not hardcoded by the
  // backend: prove the persisted value is the one the service returned.
  check(
    "provider records the provider reported by the AI service",
    completed.provider === "gemini",
    `provider=${completed.provider}`
  );

  const snapshot = pending.requestPayload.input;
  const analysis = completed.result?.analysis;
  check("a result was persisted with the contract schema version", completed.result?.schemaVersion === "1");
  check("the result carries an analysis object", Boolean(analysis));
  check("the analysis summary came from the service", analysis?.summary === "Deterministic test analysis");
  check(
    "the analysis preserves every supplied skill and its integer weight",
    jsonEqual(
      (analysis?.skillAnalysis ?? []).map((s) => [s.name, s.weight]).sort(),
      (snapshot.skills ?? []).map((s) => [s.name, s.weight]).sort()
    ),
    summarize(analysis?.skillAnalysis)
  );
  check(
    "the analysis preserves every supplied tool and fabricates none",
    jsonEqual((analysis?.toolAnalysis ?? []).map((t) => t.name).sort(), [...(snapshot.tools ?? [])].sort()),
    summarize(analysis?.toolAnalysis)
  );
  check(
    "every skill source is one of the contract values",
    (analysis?.skillAnalysis ?? []).every((s) => ["EXPLICIT", "INFERRED", "UNCLEAR"].includes(s.source)),
    summarize((analysis?.skillAnalysis ?? []).map((s) => s.source))
  );
  check("no fabricated responsibilities were invented", jsonEqual(analysis?.responsibilities, []));
  check("the request snapshot in PostgreSQL was not rewritten by the worker", jsonEqual(snapshot, {
    title: HARMLESS_TITLE, yearsExperience: 7,
    description: "Own the billing platform end to end, including ledger correctness and payment integrations.",
    skills: [{ name: "Node.js", weight: 60 }, { name: "PostgreSQL", weight: 40 }],
    tools: ["Docker", "GitHub Actions"],
    questions: ["Describe the most complex database transaction you have designed."],
  }));

  // The worker writes COMPLETED inside the processor; BullMQ acks the queue
  // record only after that resolves, so this must be awaited rather than
  // asserted immediately.
  await waitFor("the queue record to be acked", async () => (await queueJobState(`aiJob-${aiJobId}`)) === "completed");
  check("the queue record for this AiJob is acked, not retried", (await queueJobState(`aiJob-${aiJobId}`)) === "completed");
  check("worker logged the claim", workerChild.output.includes(`claimed AiJob ${aiJobId}`));
  check("worker logged the completion", workerChild.output.includes(`completed AiJob ${aiJobId}`));

  // The AI payload must not leak transport metadata or ownership data.
  check(
    "the service never receives the aiJobId inside the model input",
    !Object.prototype.hasOwnProperty.call(snapshot, "aiJobId") &&
      !workerChild.output.includes("requestPayload")
  );

  return completed;
};

// --- Scenario B: the AI service contract over real HTTP ----------------------

const postAnalysis = (body, token) =>
  fetch(`${serviceUrl}/internal/v1/job-analysis`, {
    method: "POST",
    headers: token === null
      ? { "Content-Type": "application/json" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const scenarioB = async (completedRow) => {
  section("B. AI service over real HTTP — health, bearer auth, contract validation");

  const health = await fetch(`${serviceUrl}/health`);
  check("GET /health answers without credentials", health.status === 200);
  check("the health payload is minimal (no build/config disclosure)", jsonEqual(await health.json(), { status: "ok" }));

  // Exactly the bytes the worker sends: built by the production request builder
  // from a real PostgreSQL snapshot, so this proves the two sides agree.
  const body = aiJobValidation.buildRequest(completedRow);

  const noToken = await postAnalysis(body, null);
  check("an unauthenticated call is rejected with 401", noToken.status === 401, `status=${noToken.status}`);
  check(
    "the rejection carries the fixed sanitized code",
    jsonEqual(await noToken.json(), { error: { code: "AI_SERVICE_UNAUTHORIZED" } })
  );

  const wrongToken = await postAnalysis(body, "not-the-key");
  check("a wrong bearer token is rejected with 401", wrongToken.status === 401, `status=${wrongToken.status}`);

  const malformed = await postAnalysis({ ...body, operation: "SOMETHING_ELSE" }, SERVICE_API_KEY);
  check("an unsupported operation is rejected with 422", malformed.status === 422, `status=${malformed.status}`);
  check(
    "the validation failure carries the fixed sanitized code",
    jsonEqual(await malformed.json(), { error: { code: "AI_REQUEST_INVALID" } })
  );

  const accepted = await postAnalysis(body, SERVICE_API_KEY);
  check("the worker's exact request is accepted by the service", accepted.status === 200, `status=${accepted.status}`);
  check(
    "the service response is JSON",
    (accepted.headers.get("content-type") ?? "").includes("application/json")
  );

  const envelope = await accepted.json();
  check("the response repeats the correlation identifier", envelope.aiJobId === body.aiJobId);
  check("the response declares the contract version and operation",
    envelope.schemaVersion === "1" && envelope.operation === "JOB_ANALYSIS");
  check("the response declares the provider and the model actually used",
    envelope.provider === "gemini" && typeof envelope.model === "string" && envelope.model.length > 0,
    summarize({ provider: envelope.provider, model: envelope.model }));
  check(
    "the response passes the worker's own response validator",
    (() => {
      try {
        aiJobValidation.validateResponse(envelope, body);
        return true;
      } catch {
        return false;
      }
    })()
  );
};

// --- Scenario C: retryable failure → retry → exhausted -----------------------

const scenarioC = async (recruiter, workerChild) => {
  section("C. Retryable failure — release to PENDING, retry with backoff, then FAILED");

  const startedAt = Date.now();
  const { aiJobId } = await startJobFixture(recruiter, "Retry");
  const failed = await waitForAiJob(aiJobId, "FAILED");
  const elapsed = Date.now() - startedAt;

  check("a provider rate limit ends in FAILED, not a stuck PROCESSING row", failed.status === "FAILED");
  check(
    `attempts consumed the configured retry budget (AI_JOB_MAX_ATTEMPTS=${process.env.AI_JOB_MAX_ATTEMPTS})`,
    failed.attempts === Number(process.env.AI_JOB_MAX_ATTEMPTS),
    `attempts=${failed.attempts}`
  );
  check("lastError records the normalized provider code, not raw provider text",
    failed.lastError === "AI_PROVIDER_RATE_LIMITED", `lastError=${failed.lastError}`);
  check("completedAt (finished-at) was stamped on the terminal transition", failed.completedAt instanceof Date);
  check("workerId was released", failed.workerId === null, `workerId=${failed.workerId}`);
  check("startedAt was cleared", failed.startedAt === null, `startedAt=${failed.startedAt}`);
  check("no result was fabricated on failure", failed.result === null, summarize(failed.result));
  check("no provider was recorded on failure", failed.provider === null, summarize(failed.provider));

  const queueJob = await aiJobQueue.getAiJobQueue().getJob(`aiJob-${aiJobId}`);
  check("the queue job was retried and is observable in the failed set",
    (await queueJobState(`aiJob-${aiJobId}`)) === "failed");
  check("BullMQ recorded both attempts", queueJob?.attemptsMade === 2, `attemptsMade=${queueJob?.attemptsMade}`);
  check("the backoff delay was actually applied between attempts", elapsed >= Number(process.env.AI_RETRY_BASE_DELAY_MS),
    `elapsed=${elapsed}ms`);
  check("worker logged the retryable release", workerChild.output.includes(`retryable failure for ${aiJobId}`));
  check("worker logged the eventual terminal failure", workerChild.output.includes(`terminal failure for ${aiJobId}: AI_PROVIDER_RATE_LIMITED`));

  return failed;
};

// --- Scenario D: non-retryable failure → terminal immediately ----------------

const scenarioD = async (recruiter, workerChild) => {
  section("D. Non-retryable failure — terminal on the first attempt, retries not burned");

  const { aiJobId } = await startJobFixture(recruiter, "Terminal");
  const failed = await waitForAiJob(aiJobId, "FAILED");

  check("a safety block is terminal", failed.status === "FAILED");
  check("exactly one attempt was spent (the retry budget was not burned)", failed.attempts === 1, `attempts=${failed.attempts}`);
  check("lastError records the normalized safety code",
    failed.lastError === "AI_PROVIDER_SAFETY_BLOCKED", `lastError=${failed.lastError}`);
  check("completedAt was stamped", failed.completedAt instanceof Date);
  check("startedAt was cleared, so the row is not left looking owned", failed.startedAt === null, `startedAt=${failed.startedAt}`);
  check("no result was fabricated", failed.result === null);
  check("no provider was recorded", failed.provider === null);

  const queueJob = await aiJobQueue.getAiJobQueue().getJob(`aiJob-${aiJobId}`);
  check("the queue job failed without consuming further attempts", queueJob?.attemptsMade === 1,
    `attemptsMade=${queueJob?.attemptsMade}`);
  check("worker logged the terminal failure", workerChild.output.includes(`terminal failure for ${aiJobId}: AI_PROVIDER_SAFETY_BLOCKED`));
};

// --- Scenario E: the service's preservation gate -----------------------------

const scenarioE = async (recruiter, workerChild) => {
  section("E. Preservation gate — a fabricated requirement never reaches PostgreSQL");

  // The deterministic provider answers with an extra, invented tool. The service
  // must reject it; the worker must never write it.
  const { aiJobId } = await startJobFixture(recruiter, "Mismatch");
  const failed = await waitForAiJob(aiJobId, "FAILED");

  check("a non-preserving analysis is rejected, not persisted", failed.status === "FAILED");
  check("lastError records the validation code",
    failed.lastError === "AI_RESPONSE_VALIDATION_FAILED", `lastError=${failed.lastError}`);
  check("no result was persisted at all", failed.result === null, summarize(failed.result));
  check("no provider was recorded", failed.provider === null);
  check("worker logged the validation failure",
    workerChild.output.includes(`terminal failure for ${aiJobId}: AI_RESPONSE_VALIDATION_FAILED`));

  // Independent proof that the worker also rejects it on its own side: if the
  // service's gate were ever removed, this gate is what still protects the row.
  const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  const request = aiJobValidation.buildRequest(row);
  const fabricated = {
    schemaVersion: "1",
    aiJobId: request.aiJobId,
    operation: "JOB_ANALYSIS",
    provider: "gemini",
    model: "test-model",
    analysis: {
      summary: "Fabricated", responsibilities: [],
      skillAnalysis: request.request.skills.map((s) => ({ ...s, expectation: "x", source: "EXPLICIT" })),
      toolAnalysis: [...request.request.tools, "FabricatedTool"].map((name) => ({ name, expectation: "x" })),
      ambiguities: [], clarificationQuestions: [], warnings: [],
    },
  };

  check(
    "the worker's own validator refuses an analysis that fabricates a tool",
    (() => {
      try {
        aiJobValidation.validateResponse(fabricated, request);
        return false;
      } catch {
        return true;
      }
    })()
  );

  check(
    "the worker's own validator refuses a mismatched correlation identifier",
    (() => {
      try {
        aiJobValidation.validateResponse({ ...fabricated, aiJobId: "someone-elses-job" }, request);
        return false;
      } catch {
        return true;
      }
    })()
  );
};

// --- Scenario F: retryable failure that recovers to COMPLETED ----------------

const scenarioF = async (recruiter, workerChild) => {
  section("F. Recovery — a transient failure retries and still reaches COMPLETED");

  const { aiJobId } = await startJobFixture(recruiter, "Flaky");
  const completed = await waitForAiJob(aiJobId, "COMPLETED");

  check("a transient provider outage still produces a completed analysis", completed.status === "COMPLETED");
  check("two attempts were needed (one failed, one succeeded)", completed.attempts === 2, `attempts=${completed.attempts}`);
  check("the recovery cleared lastError", completed.lastError === null, `lastError=${completed.lastError}`);
  check("a real result was persisted", completed.result?.analysis?.summary === "Deterministic test analysis");
  check("the provider was recorded on the successful attempt", completed.provider === "gemini");
  check("worker logged the retryable release", workerChild.output.includes(`retryable failure for ${aiJobId}`));
  check("worker logged the completion after the retry", workerChild.output.includes(`completed AiJob ${aiJobId}`));
};

// --- Scenario G: the AI service is unreachable or not configured -------------

const rejectedWith = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

const scenarioG = async (sampleRow) => {
  section("G. Service unavailable — normalized, retryable, and never hung");

  const originalUrl = process.env.AI_SERVICE_URL;
  const originalKey = process.env.AI_SERVICE_API_KEY;

  try {
    // Nothing listens on this port. This drives the REAL client code path (the
    // URL comes from the environment) with no test hooks.
    process.env.AI_SERVICE_URL = "http://127.0.0.1:9";
    process.env.AI_SERVICE_API_KEY = SERVICE_API_KEY;

    const unreachable = await rejectedWith(() => aiJobClient.analyzeAiJob(sampleRow));
    check("an unreachable service is reported as a network error",
      unreachable instanceof aiJobClient.AiServiceError && unreachable.code === "AI_PROVIDER_NETWORK_ERROR",
      summarize({ name: unreachable?.name, code: unreachable?.code }));
    check("a network error is marked retryable", unreachable?.retryable === true);
    check("no raw connection error text escapes the client",
      !/ECONNREFUSED|127\.0\.0\.1:9|fetch failed/i.test(String(unreachable?.message)));

    // A missing shared secret must be a configuration fault, not a retry storm.
    delete process.env.AI_SERVICE_API_KEY;
    const unconfigured = await rejectedWith(() => aiJobClient.analyzeAiJob(sampleRow));
    check("a missing AI_SERVICE_API_KEY is reported as not configured",
      unconfigured?.code === "AI_SERVICE_NOT_CONFIGURED", summarize(unconfigured?.code));
    check("a configuration fault is NOT retryable", unconfigured?.retryable === false);

    // A service that reports a provider failure must map onto the fixed code set
    // rather than surfacing provider wording.
    process.env.AI_SERVICE_URL = serviceUrl;
    process.env.AI_SERVICE_API_KEY = SERVICE_API_KEY;
    const retryable = await rejectedWith(() => aiJobClient.analyzeAiJob({ ...sampleRow, requestPayload: {
      operation: "JOB_ANALYSIS",
      input: { ...sampleRow.requestPayload.input, title: "Retry" },
    } }));
    check("the service's normalized provider error is preserved end to end",
      retryable?.code === "AI_PROVIDER_RATE_LIMITED", summarize(retryable?.code));
    check("the retry hint is clamped to a bounded delay",
      retryable?.retryAfterMs === 100, `retryAfterMs=${retryable?.retryAfterMs}`);
  } finally {
    process.env.AI_SERVICE_URL = originalUrl;
    process.env.AI_SERVICE_API_KEY = originalKey;
  }
};

// --- source inspection -------------------------------------------------------

// Strips JavaScript comments, so a forbidden-pattern scan can never be tripped by
// documentation (the aiJob.repository.js comment mentioning the AI service's
// framework is a comment, not an import). String, template and regex literals are
// preserved verbatim: a real require("@google/genai") or process.env.GEMINI_API_KEY
// stays visible to the scan — only comment spans are dropped. Deterministic and
// dependency-free: a single left-to-right pass that never rewrites non-comment code.
const REGEX_PREFIX_CHARS = "([{,:;=!&|?+-*%^~<>";
const REGEX_PREFIX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "throw", "yield", "await",
]);

const stripJsComments = (source) => {
  let code = "";
  let index = 0;
  // Just enough context to tell a regex literal (/\/\//) from a division (a / b):
  // the last significant token, which is a word whenever one is still open.
  let previousToken = "";
  let word = "";

  const push = (text) => {
    code += text;
    for (const char of text) {
      if (/[A-Za-z0-9_$]/.test(char)) {
        word += char;
        continue;
      }
      if (word !== "") {
        previousToken = word;
        word = "";
      }
      if (!/\s/.test(char)) {
        previousToken = char;
      }
    }
  };

  const regexAllowed = () => {
    const token = word !== "" ? word : previousToken;
    return token === "" || REGEX_PREFIX_CHARS.includes(token) || REGEX_PREFIX_KEYWORDS.has(token);
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    // Line comment: dropped, but the newline is kept so line structure survives.
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    // String / template literal: copied whole, escapes included.
    if (char === '"' || char === "'" || char === "`") {
      let literal = char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "\\") {
          literal += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        literal += inner;
        index += 1;
        if (inner === char) {
          break;
        }
      }
      push(literal);
      continue;
    }

    // Regex literal: copied whole, so a \/ or // inside it is not read as a comment.
    if (char === "/" && regexAllowed()) {
      let literal = "/";
      let inCharacterClass = false;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "\\") {
          literal += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (inner === "\n") {
          break; // not a regex after all: leave the rest to normal scanning
        }
        literal += inner;
        index += 1;
        if (inCharacterClass) {
          inCharacterClass = inner !== "]";
        } else if (inner === "[") {
          inCharacterClass = true;
        } else if (inner === "/") {
          break;
        }
      }
      push(literal);
      continue;
    }

    push(char);
    index += 1;
  }

  return code;
};

// --- Scenario H: claim fencing + provider separation -------------------------

const emptyAnalysis = {
  summary: "Probe", responsibilities: [], skillAnalysis: [], toolAnalysis: [],
  ambiguities: [], clarificationQuestions: [], warnings: [],
};

const scenarioH = async (recruiter) => {
  section("H. Claim fencing — a stale attempt can never overwrite a newer result");

  const { aiJobId } = await startJobFixture(recruiter, HARMLESS_TITLE);
  const claim = await aiJobRepository.claimAiJobForProcessing({ aiJobId, workerId: "probe:attempt-one" });
  check("the repository hands out exactly one claim", claim?.attempts === 1, summarize(claim?.attempts));

  const wrongAttempt = await aiJobRepository.completeAiJob({
    aiJobId, workerId: "probe:attempt-one", attempts: 999, analysis: emptyAnalysis, provider: "gemini",
  });
  check("a superseded attempt number updates 0 rows", wrongAttempt === 0, `updated=${wrongAttempt}`);

  const wrongOwner = await aiJobRepository.completeAiJob({
    aiJobId, workerId: "probe:someone-else", attempts: claim.attempts, analysis: emptyAnalysis, provider: "gemini",
  });
  check("a different worker updates 0 rows", wrongOwner === 0, `updated=${wrongOwner}`);

  const badProvider = await rejectedWith(() => aiJobRepository.completeAiJob({
    aiJobId, workerId: "probe:attempt-one", attempts: claim.attempts, analysis: emptyAnalysis, provider: "",
  }));
  check("an invalid provider is refused before any write", badProvider?.message === "AI_PROVIDER_INVALID",
    summarize(badProvider?.message));

  const completed = await aiJobRepository.completeAiJob({
    aiJobId, workerId: "probe:attempt-one", attempts: claim.attempts, analysis: emptyAnalysis, provider: "gemini",
  });
  check("the owning attempt completes the row", completed === 1, `updated=${completed}`);

  const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check("the completion was fenced onto the exact claim", row.status === "COMPLETED" && row.attempts === 1,
    summarize({ status: row.status, attempts: row.attempts }));
  check("provider is persisted from the caller, not hardcoded in the repository", row.provider === "gemini");

  const reopened = await aiJobRepository.releaseAiJobForRetry({
    aiJobId, workerId: "probe:attempt-one", attempts: 1, lastError: "probe",
  });
  check("a terminal row can never be released back to PENDING", reopened === 0, `updated=${reopened}`);

  const refailed = await aiJobRepository.markAiJobFailed({
    aiJobId, workerId: "probe:attempt-one", attempts: 1, lastError: "probe",
  });
  check("a terminal row can never be re-marked FAILED", refailed === 0, `updated=${refailed}`);
  check("a second claim on a completed row is refused",
    (await aiJobRepository.claimAiJobForProcessing({ aiJobId, workerId: "probe:late" })) === null);

  // --- separation of concerns ------------------------------------------------

  const transportFiles = [
    "src/ai-worker.js",
    "src/module/ai-job/aiJob.client.js",
    "src/module/ai-job/aiJob.queue.js",
    "src/module/ai-job/aiJob.repository.js",
    "src/config/redis.js",
    "src/config/aiService.js",
  ];
  const forbidden = [
    "@google/genai", "openai", "anthropic", "langchain", "fastapi", "flask",
    "axios", "node-fetch", "GEMINI_API_KEY", "gemini_api_key",
  ];

  const offenders = [];
  for (const relative of transportFiles) {
    // Comments are stripped first: only real code (a required module or a
    // credential reference) may fail this check, never documentation.
    const source = stripJsComments(fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8")).toLowerCase();
    for (const pattern of forbidden) {
      if (source.includes(pattern.toLowerCase())) {
        offenders.push(`${relative}:${pattern}`);
      }
    }
  }
  check("the backend holds no provider SDK and no provider credential", offenders.length === 0, offenders.join(", "));

  // The stripper must not weaken the scan: every forbidden pattern is still found
  // in real code, and the same words commented out are not. Deterministic fixture,
  // no files and no environment involved.
  const realCode = `
const { GoogleGenAI } = require("@google/genai");
const openai = require("openai");
const anthropic = require("anthropic");
const langchain = require("langchain");
const fastapi = require("fastapi");
const flask = require("flask");
const axios = require("axios");
const fetch = require("node-fetch");
const key = process.env.GEMINI_API_KEY;
const lowerKey = process.env.gemini_api_key;
`;
  const commentedOut = `
// @google/genai openai anthropic langchain fastapi
// flask axios node-fetch GEMINI_API_KEY gemini_api_key
/* @google/genai openai anthropic langchain fastapi flask axios node-fetch */
`;
  const matchesCode = (text) => forbidden.filter((pattern) => stripJsComments(text).toLowerCase().includes(pattern.toLowerCase()));
  const missedInCode = forbidden.filter((pattern) => !matchesCode(realCode).includes(pattern));
  const matchedInComments = matchesCode(commentedOut);
  check(
    "the provider scan still catches real imports/credentials and ignores comments alone",
    missedInCode.length === 0 && matchedInComments.length === 0,
    summarize({ missedInCode, matchedInComments })
  );

  const repositorySource = stripJsComments(fs.readFileSync(path.join(BACKEND_ROOT, "src/module/ai-job/aiJob.repository.js"), "utf8"));
  check("the persistence layer does not hardcode a provider name", !repositorySource.toLowerCase().includes("gemini"));

  const clientSource = fs.readFileSync(path.join(BACKEND_ROOT, "src/config/aiService.js"), "utf8");
  check("the worker authenticates to the AI service with its own key", clientSource.includes("AI_SERVICE_API_KEY"));
};

// --- cleanup & report --------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  subscription: await prisma.subscription.count(),
  subscriptionPlan: await prisma.subscriptionPlan.count(),
});

// Removes only the Redis records this harness added. Unrelated queue records are
// untouched, and the isolated prefix means another harness's records are never
// even visible here.
const removeHarnessQueueJobs = async () => {
  const removed = [];

  try {
    for (const aiJobId of tracked.aiJobIds) {
      for (const job of await queueJobsForAiJob(aiJobId)) {
        await job.remove();
        removed.push(job.id);
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
    // before the queue call, so it must be removed even if a scenario aborted
    // before the harness could track its id.
    removed.aiJob = (
      await prisma.aiJob.deleteMany({
        where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }] },
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
  section("Cleanup — stopping processes and removing everything this harness created");

  for (const child of children) {
    await stopProcess(child);
  }
  check(
    "every harness process was stopped (AI service and worker)",
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

  const leftovers = [];
  for (const aiJobId of tracked.aiJobIds) {
    const records = await queueJobsForAiJob(aiJobId).catch(() => []);
    if (records.length > 0) {
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

  console.log("Stage 3 verified: Start → PENDING → Redis → worker → FastAPI → validated COMPLETED.");
};

// --- entrypoint --------------------------------------------------------------

const run = async () => {
  console.log("Stage 3 verification harness: FastAPI AI service + validated analysis");
  console.log(`run id: ${SUFFIX}`);
  console.log("contract: PENDING AiJob → BullMQ → worker → FastAPI → validated analysis → COMPLETED");
  console.log(`queue: ${aiJobQueue.AI_JOB_QUEUE_NAME} | prefix: ${process.env.AI_QUEUE_PREFIX}`);
  console.log("worker entrypoint: src/ai-worker.js | AI service: ai-service (uvicorn)");
  console.log("provider: deterministic test double injected into the REAL FastAPI app");

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

    if (!fs.existsSync(PYTHON_EXE)) {
      check(`ai-service virtualenv exists at ${PYTHON_EXE}`, false, "create it and install requirements-dev.txt");
      return;
    }
    check(`ai-service virtualenv exists`, true);

    await startAiService({ AI_SERVICE_API_KEY: SERVICE_API_KEY });
    check("the real FastAPI service started under uvicorn and answered /health", true);

    // The worker receives only the service coordinates — never a provider key.
    const worker = startWorkerProcess({
      label: "ai-worker",
      env: { AI_SERVICE_URL: serviceUrl, AI_SERVICE_API_KEY: SERVICE_API_KEY },
    });
    await waitFor("worker to connect to Redis", () => worker.output.includes("Redis connected"));

    const recruiter = await createRecruiterFixture("main");

    const completedRow = await scenarioA(recruiter, worker);
    await scenarioB(completedRow);
    await scenarioC(recruiter, worker);
    await scenarioD(recruiter, worker);
    await scenarioE(recruiter, worker);
    await scenarioF(recruiter, worker);

    // Stop the worker before the probes that must own the queue and the row
    // exclusively (no consumer may race a deliberate PENDING row).
    await stopProcess(worker);

    await scenarioG(completedRow);
    await scenarioH(recruiter);
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