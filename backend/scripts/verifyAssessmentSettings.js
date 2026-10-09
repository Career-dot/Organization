/* eslint-disable no-console */
// Assessment-settings verification harness: Job Setup limits → AI contract.
//
// Run with:  npm run verify:assessment-settings
//
// Proves the recruiter's assessment configuration over the REAL pipeline
// (PostgreSQL → BullMQ/Redis → worker → FastAPI/uvicorn): Job Setup bounds,
// frozen request settings, the exact-count/≤45 AI contract, duration that is
// never AI-decided, edit caps, finalize/candidate preservation and untouched
// quota. Convention follows verifyAiJobStage3.js (CommonJS, throwaway
// fixtures, isolated Redis prefix, no DB reset).
require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const aiJobValidation = require("../src/module/ai-job/aiJob.validation");
const {
  attachJobCandidateList,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

const BACKEND_ROOT = path.join(__dirname, "..");
const AI_SERVICE_ROOT = path.join(BACKEND_ROOT, "..", "ai-service");
const PYTHON_EXE = path.join(AI_SERVICE_ROOT, ".venv", "Scripts", "python.exe");
const WORKER_ENTRY = path.join(BACKEND_ROOT, "src", "ai-worker.js");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

process.env.AI_QUEUE_PREFIX = `assessment-settings-${SUFFIX}`;
process.env.AI_JOB_MAX_ATTEMPTS = "2";
process.env.AI_RETRY_BASE_DELAY_MS = "250";
process.env.AI_RETRY_MAX_DELAY_MS = "1000";

const aiJobQueue = require("../src/module/ai-job/aiJob.queue");

// Shared secret for this run only — handed to the AI service and the worker
// through their environments, never written to disk.
const SERVICE_API_KEY = `settings-${SUFFIX}`;
let serviceUrl = null;

// The distinctive recruiter questions used throughout.
const RECRUITER_QUESTIONS = [
  "Which Python framework would you choose for this backend and why?",
  "Explain how you would design the authentication layer.",
  "How would you optimize this API under heavy traffic?",
];

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
const waitFor = async (label, probe, { timeoutMs = 45000, intervalMs = 150 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(intervalMs);
  }
};

// --- fixtures ----------------------------------------------------------------

const tracked = { userIds: [], planIds: [], subscriptionIds: [], jobIds: [], aiJobIds: [] };
const children = [];

const BASE_JOB = (title, overrides = {}) => ({
  title,
  yearsExperience: 7,
  description:
    "Own the billing platform end to end, including ledger correctness and payment integrations.",
  analysisDays: 4,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }, { name: "GitHub Actions" }],
  questions: RECRUITER_QUESTIONS.map((question) => ({ question })),
  ...overrides,
});

const createRecruiterFixture = async (label, jobPostingLimit = 20) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Settings Harness ${label}`,
      email: `settings-harness-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Settings Harness Plan ${label} ${SUFFIX}`,
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

// Creates a draft through the production service and tracks it.
const draftFixture = async (recruiter, title, overrides = {}) => {
  const draft = await jobService.createDraft(recruiter.user, BASE_JOB(title, overrides));
  tracked.jobIds.push(draft.id);
  return draft;
};

// start → analysis COMPLETED → Continue → assessment COMPLETED (real services).
const runToAssessment = async (recruiter, draft) => {
  await attachJobCandidateList(recruiter, draft.id);
  const started = await jobService.startJob(recruiter.user, draft.id);
  tracked.aiJobIds.push(started.aiJob.id);
  await waitForAiJob(started.aiJob.id, "COMPLETED");
  const continued = await jobService.continueClarifications(recruiter.user, draft.id);
  tracked.aiJobIds.push(continued.aiJob.id);
  // The assessment job must settle before any JobAssessment read: the row is
  // created in the SAME transaction that marks the AiJob COMPLETED, so this
  // wait also guarantees the persistence read below never races the worker.
  await waitForAiJob(continued.aiJob.id, "COMPLETED");
  return continued.aiJob.id;
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

const waitForExit = (child, timeoutMs = 10000) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill();
  if (!(await waitForExit(child))) {
    child.kill("SIGKILL");
    await waitForExit(child, 5000);
  }
  return child.exitCode !== null || child.signalCode !== null;
};

const startAiService = async () => {
  if (!fs.existsSync(PYTHON_EXE)) {
    throw new Error(`ai-service virtualenv not found at ${PYTHON_EXE}`);
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
          // This run's shared secret overrides anything in backend/.env (env
          // passed to the child always wins over dotenv-loaded values).
          AI_SERVICE_API_KEY: SERVICE_API_KEY,
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

const startWorkerProcess = ({ env = {}, label = "worker" } = {}) =>
  attachCapture(
    spawn(process.execPath, [WORKER_ENTRY], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    label
  );

const ALL_QUEUE_STATES = ["completed", "failed", "delayed", "active", "waiting", "prioritized"];
const queueJobsForAiJob = async (aiJobId) => {
  const jobs = await aiJobQueue.getAiJobQueue().getJobs(ALL_QUEUE_STATES, 0, -1);
  return jobs.filter((job) => job?.data?.aiJobId === aiJobId);
};

const waitForAiJob = async (aiJobId, status, timeoutMs = 60000) =>
  waitFor(
    `AiJob ${aiJobId} to reach ${status}`,
    async () => {
      const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
      return row && row.status === status ? row : null;
    },
    { timeoutMs }
  );

// --- scenario 1: Job Setup boundary (backend schema = authoritative) ---------

const jobValidation = require("../src/module/job/job.validation");

const rejectedBy = (schema, value) => {
  try {
    schema.parse(value);
    return null;
  } catch (error) {
    return error?.issues?.[0]?.message ?? String(error?.message ?? error);
  }
};
const acceptedBy = (schema, value) => {
  try {
    schema.parse(value);
    return true;
  } catch {
    return false;
  }
};
const withSettings = (settings) => ({ ...BASE_JOB("Boundary Probe"), ...settings });

const scenario1 = async () => {
  section("1. Job Setup boundary — createDraftSchema / updateDraftSchema / assessmentUpdateSchema");

  check("question count 45 is accepted",
    acceptedBy(jobValidation.createDraftSchema, withSettings({ assessmentQuestionCount: 45 })));
  check("question count 46 is rejected",
    (rejectedBy(jobValidation.createDraftSchema, withSettings({ assessmentQuestionCount: 46 })))?.includes("45"));
  check("question count 0 is rejected",
    rejectedBy(jobValidation.createDraftSchema, withSettings({ assessmentQuestionCount: 0 })) !== null);
  check("non-integer question count is rejected",
    rejectedBy(jobValidation.createDraftSchema, withSettings({ assessmentQuestionCount: 45.5 })) !== null);
  check("duration 5400 seconds (90 min) is accepted",
    acceptedBy(jobValidation.createDraftSchema, withSettings({ assessmentDurationSeconds: 5400 })));
  check("duration 5401 seconds is rejected",
    (rejectedBy(jobValidation.createDraftSchema, withSettings({ assessmentDurationSeconds: 5401 })))?.includes("5400"));
  check("duration 5460 seconds (91 min) is rejected",
    rejectedBy(jobValidation.createDraftSchema, withSettings({ assessmentDurationSeconds: 5460 })) !== null);
  check("duration 59 seconds is rejected",
    rejectedBy(jobValidation.createDraftSchema, withSettings({ assessmentDurationSeconds: 59 })) !== null);
  check("duration 60 seconds is accepted",
    acceptedBy(jobValidation.createDraftSchema, withSettings({ assessmentDurationSeconds: 60 })));
  check("duration 45.5 seconds is rejected",
    rejectedBy(jobValidation.createDraftSchema, withSettings({ assessmentDurationSeconds: 45.5 })) !== null);
  check("updateDraftSchema rejects 46 questions",
    rejectedBy(jobValidation.updateDraftSchema, { assessmentQuestionCount: 46 }) !== null);
  check("updateDraftSchema rejects 5401 seconds",
    rejectedBy(jobValidation.updateDraftSchema, { assessmentDurationSeconds: 5401 }) !== null);

  // Assessment editing: the recruiter must never be able to edit an assessment
  // beyond the hard platform limits.
  const questionEdit = (count) =>
    Array.from({ length: count }, (_, index) => ({ id: `q${index}`, prompt: `P${index}`, points: 1 }));
  check("assessment edit with 46 questions is rejected",
    (rejectedBy(jobValidation.assessmentUpdateSchema, { questions: questionEdit(46) }))?.includes("45"));
  check("assessment edit with exactly 45 questions is accepted",
    acceptedBy(jobValidation.assessmentUpdateSchema, { questions: questionEdit(45) }));
  check("assessment edit to 5401 seconds is rejected",
    rejectedBy(jobValidation.assessmentUpdateSchema, { durationSeconds: 5401 }) !== null);
  check("assessment edit to 5400 seconds is accepted",
    acceptedBy(jobValidation.assessmentUpdateSchema, { durationSeconds: 5400 }));
};

// --- scenario 2: Node backstop over the frozen requestPayload ----------------

const assessmentQuestionFixtures = (count, recruiterTexts) => {
  const recruiter = (text) => ({
    section: "REQUIRED_SKILLS", prompt: text, questionType: "SHORT_ANSWER",
    points: 10, difficulty: "INTERMEDIATE", guidance: "G", options: [],
  });
  const filler = (index) => ({
    section: "JOB_OVERVIEW", prompt: `Additional scenario ${index + 1}: core skills.`,
    questionType: "SCENARIO", points: 10, difficulty: "INTERMEDIATE", guidance: "G", options: [],
  });
  return [
    ...recruiterTexts.map(recruiter),
    ...Array.from({ length: Math.max(count - recruiterTexts.length, 0) }, (_, index) => filler(index)),
  ];
};

const frozenRow = ({ settings = {}, questions = RECRUITER_QUESTIONS } = {}) => ({
  id: `row-${SUFFIX}`,
  operation: "ASSESSMENT_GENERATION",
  requestPayload: {
    operation: "ASSESSMENT_GENERATION",
    input: {
      job: {
        title: "Settings Backstop Probe", yearsExperience: 3,
        description: "Backstop probe description.", skills: [{ name: "Node.js", weight: 100 }],
        tools: ["Docker"], questions,
      },
      clarifications: [],
      requestedQuestionCount: null,
      requestedDurationSeconds: null,
      ...settings,
    },
  },
});

const rawAssessment = (questions, extraAssessmentKeys = {}) => ({
  schemaVersion: "1", aiJobId: `row-${SUFFIX}`, operation: "ASSESSMENT_GENERATION",
  provider: "gemini", model: "test-model",
  assessment: { title: "T", description: "D", questions, ...extraAssessmentKeys },
});

const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const scenario2 = async () => {
  section("2. Node backstop — validateAssessmentResponse over the frozen AiJob.requestPayload");

  const okRow = frozenRow({ settings: { requestedQuestionCount: 6, requestedDurationSeconds: 2700 } });
  const okRequest = aiJobValidation.buildRequest(okRow);
  check("the frozen settings survive buildRequest",
    okRequest.request.requestedQuestionCount === 6 && okRequest.request.requestedDurationSeconds === 2700);
  check("an exact-count, recruiter-preserving response passes the backstop",
    (() => {
      try {
        aiJobValidation.validateResponse(rawAssessment(assessmentQuestionFixtures(6, RECRUITER_QUESTIONS)), okRequest);
        return true;
      } catch {
        return false;
      }
    })());
  check("a response with the wrong total is rejected",
    throws(() => aiJobValidation.validateResponse(
      rawAssessment(assessmentQuestionFixtures(7, RECRUITER_QUESTIONS)), okRequest)));
  check("a 46-question response is rejected (hard 45 cap)",
    throws(() => aiJobValidation.validateResponse(
      rawAssessment(assessmentQuestionFixtures(46, RECRUITER_QUESTIONS)), okRequest)));
  check("a rewritten recruiter question is rejected",
    throws(() => aiJobValidation.validateResponse(
      rawAssessment(assessmentQuestionFixtures(6, ["Rewritten question one", ...RECRUITER_QUESTIONS.slice(1)])), okRequest)));
  check("a duration key injected by the AI is rejected (strict schema)",
    throws(() => aiJobValidation.validateResponse(
      rawAssessment(assessmentQuestionFixtures(6, RECRUITER_QUESTIONS), { durationSeconds: 999999 }), okRequest)));
  check("requested count below the recruiter-question count fails fast in buildRequest",
    (() => {
      try {
        aiJobValidation.buildRequest(frozenRow({ settings: { requestedQuestionCount: 2 } }));
        return false;
      } catch (error) {
        return error.message === "AI_REQUEST_INVALID";
      }
    })());
  check("requested count 46 fails fast in buildRequest (above the platform cap)",
    throws(() => aiJobValidation.buildRequest(frozenRow({ settings: { requestedQuestionCount: 46 } }))));
  check("requested duration 5401 fails fast in buildRequest",
    throws(() => aiJobValidation.buildRequest(frozenRow({ settings: { requestedDurationSeconds: 5401 } }))));
};

// --- scenario 3: FastAPI contract over real HTTP ------------------------------

const postAssessment = async (body) =>
  fetch(`${serviceUrl}/internal/v1/assessment-generation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_API_KEY}` },
    body: JSON.stringify(body),
  });

const httpJob = (title, overrides = {}) => ({
  title,
  yearsExperience: 5,
  description: "Build Node.js services with real traffic.",
  skills: [{ name: "Node.js", weight: 100 }],
  tools: ["Docker"],
  questions: RECRUITER_QUESTIONS,
  ...overrides,
});
const httpBody = (title, { settings = {}, questions = RECRUITER_QUESTIONS } = {}) => ({
  schemaVersion: "1",
  aiJobId: `http-${SUFFIX}`,
  operation: "ASSESSMENT_GENERATION",
  request: { job: httpJob(title), clarifications: [], requestedQuestionCount: null, requestedDurationSeconds: null, ...settings },
});
// Overrides request-level settings after the job defaults.
const withRequest = (body, settings) => ({
  ...body,
  request: { ...body.request, ...settings },
});
const httpQuestionsOf = (body, count) => ({
  ...body,
  request: { ...body.request, job: { ...body.request.job, questions: RECRUITER_QUESTIONS.slice(0, count) } },
});

const scenario3 = async () => {
  section("3. FastAPI contract — real HTTP against the assessment-generation route");

  const happy = await postAssessment(
    withRequest(httpBody("Settings HTTP Happy"), { requestedQuestionCount: 6, requestedDurationSeconds: 2700 })
  );
  check("a configured request is accepted (200)", happy.status === 200, `status=${happy.status}`);
  const happyEnvelope = await happy.json();
  const happyQuestions = happyEnvelope.assessment?.questions ?? [];
  check("the assessment contains EXACTLY the requested 6 questions", happyQuestions.length === 6,
    `count=${happyQuestions.length}`);
  check("the recruiter questions survive verbatim at the head of the assessment",
    jsonEqual(happyQuestions.slice(0, 3).map((q) => q.prompt), RECRUITER_QUESTIONS));
  check("the AI response carries no duration anywhere",
    !Object.keys(happyEnvelope).includes("durationSeconds") &&
      !Object.keys(happyEnvelope.assessment).includes("durationSeconds") &&
      happyQuestions.every((q) => !Object.keys(q).includes("durationSeconds")));

  const below = await postAssessment(
    withRequest(httpBody("Settings Below"), { requestedQuestionCount: 2 })
  );
  check("requested count below the recruiter-question count is rejected with 422",
    below.status === 422, `status=${below.status}`);
  check("the 422 carries the sanitized request code",
    jsonEqual(await below.json(), { error: { code: "AI_REQUEST_INVALID" } }));

  check("requested count 46 is rejected with 422 (above the platform cap)",
    (await postAssessment(withRequest(httpBody("Settings Above"), { requestedQuestionCount: 46 }))).status === 422);
  check("requested duration 5401 is rejected with 422",
    (await postAssessment(withRequest(httpBody("Settings Duration Over"), { requestedDurationSeconds: 5401 }))).status === 422);
  check("requested duration 59 is rejected with 422",
    (await postAssessment(withRequest(httpBody("Settings Duration Under"), { requestedDurationSeconds: 59 }))).status === 422);
  const atCap = await postAssessment(
    withRequest(httpBody("Settings Duration Cap"), { requestedQuestionCount: 6, requestedDurationSeconds: 5400 })
  );
  check("requested duration 5400 (90 min) is accepted", atCap.status === 200, `status=${atCap.status}`);
  check("even at the cap the response carries no duration",
    !Object.keys((await atCap.json()).assessment).includes("durationSeconds"));

  const oversized = await postAssessment(
    withRequest(httpBody("Assess46"), { requestedQuestionCount: 6 })
  );
  check("an AI response with 46 questions is rejected with 502", oversized.status === 502,
    `status=${oversized.status}`);
  check("the 502 carries the sanitized validation code",
    jsonEqual(await oversized.json(), { error: { code: "AI_RESPONSE_VALIDATION_FAILED" } }));

  const wrongCount = await postAssessment(
    withRequest(httpBody("AssessWrongCount"), { requestedQuestionCount: 6 })
  );
  check("an AI response with the wrong total is rejected with 502", wrongCount.status === 502,
    `status=${wrongCount.status}`);
};

// --- scenario 4: the real pipeline (settings frozen, honored, persisted) -----

const scenario4a = async (recruiter) => {
  section("4. Real pipeline — Job A: 6 requested questions / 2700s configured duration");

  const draft = await draftFixture(recruiter, "Settings Pipeline A", {
    assessmentQuestionCount: 6,
    assessmentDurationSeconds: 2700,
  });
  const persisted = await prisma.job.findUnique({ where: { id: draft.id } });
  check("Job Setup persists assessmentQuestionCount on the Job",
    persisted.assessmentQuestionCount === 6, `count=${persisted.assessmentQuestionCount}`);
  check("Job Setup persists assessmentDurationSeconds on the Job",
    persisted.assessmentDurationSeconds === 2700, `duration=${persisted.assessmentDurationSeconds}`);

  // Recruiter edits the settings before starting: the update path persists too.
  await jobService.updateDraft(recruiter.user, draft.id, {
    assessmentQuestionCount: 8,
    assessmentDurationSeconds: 2700,
  });
  const edited = await prisma.job.findUnique({ where: { id: draft.id } });
  check("a draft edit of the settings persists", edited.assessmentQuestionCount === 8);
  await jobService.updateDraft(recruiter.user, draft.id, { assessmentQuestionCount: 6 });

  const aiJobId = await runToAssessment(recruiter, draft);
  const frozen = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check("the requested count is frozen into AiJob.requestPayload",
    frozen.requestPayload?.input?.requestedQuestionCount === 6);
  check("the requested duration is frozen into AiJob.requestPayload",
    frozen.requestPayload?.input?.requestedDurationSeconds === 2700);
  check("the recruiter questions are frozen into AiJob.requestPayload",
    jsonEqual(frozen.requestPayload?.input?.job?.questions, RECRUITER_QUESTIONS));

  const withQuestions = { include: { questions: { orderBy: { sortOrder: "asc" } } } };
  const assessment = await prisma.jobAssessment.findUnique({ where: { jobId: draft.id }, ...withQuestions });
  check("the generated assessment contains EXACTLY the requested 6 questions",
    assessment.questions.length === 6, `count=${assessment.questions.length}`);
  check("the recruiter questions survive verbatim in the persisted assessment",
    jsonEqual(assessment.questions.slice(0, 3).map((q) => q.prompt), RECRUITER_QUESTIONS));
  check("JobAssessment.durationSeconds comes from the Job configuration, not the AI",
    assessment.durationSeconds === 2700, `duration=${assessment.durationSeconds}`);
  check("the AI result itself carries no duration",
    Object.keys(frozen.result?.assessment ?? {}).every((key) => key !== "durationSeconds"));

  // Edit within the limits before finalization.
  await jobService.updateAssessment(recruiter.user, draft.id, { durationSeconds: 5400 });
  const afterEdit = await prisma.jobAssessment.findUnique({ where: { jobId: draft.id }, ...withQuestions });
  check("a valid duration edit (5400) persists before finalization",
    afterEdit.durationSeconds === 5400, `duration=${afterEdit.durationSeconds}`);
  check("editing preserved the recruiter questions",
    jsonEqual(afterEdit.questions.slice(0, 3).map((q) => q.prompt), RECRUITER_QUESTIONS));

  await jobService.finalizeAssessment(recruiter.user, draft.id);
  const finalized = await prisma.jobAssessment.findUnique({ where: { jobId: draft.id }, ...withQuestions });
  check("finalization preserves the configured duration", finalized.durationSeconds === 5400);
  check("finalization preserves all 6 questions", finalized.questions.length === 6);

  // Activation gate (previous stage's invariant): a finalized-but-inactive
  // link must NOT be candidate-readable.
  let preActivation = null;
  try {
    await jobService.getAssessmentForCandidate(finalized.publicId);
  } catch (error) {
    preActivation = error.status ?? error.message;
  }
  check("before activation the finalized link is not candidate-readable",
    preActivation === 404, summarize(preActivation));

  await jobService.activateAssessment(recruiter.user, draft.id);
  const activated = await prisma.jobAssessment.findUnique({ where: { jobId: draft.id } });
  check("activation stamps activatedAt on the finalized assessment",
    activated.activatedAt instanceof Date);

  const candidate = await jobService.getAssessmentForCandidate(finalized.publicId);
  check("the candidate-facing read returns the configured duration",
    candidate.durationSeconds === 5400, summarize(candidate.durationSeconds));
  check("the candidate-facing read returns the exact questions",
    jsonEqual(candidate.questions.slice(0, 3).map((q) => q.prompt), RECRUITER_QUESTIONS) &&
      candidate.questions.length === 6);
  check("the candidate-facing read leaks no internals",
    ["requestPayload", "aiJobId", "provider", "model", "status", "id", "jobId"].every((key) => !(key in candidate)));

  return draft.id;
};

// --- scenario 5: legacy job (no settings) keeps the default timer ------------

const scenario4b = async (recruiter) => {
  section("5. Real pipeline — legacy Job B without settings keeps the default timer");

  const draft = await draftFixture(recruiter, "Settings Legacy B");
  const aiJobId = await runToAssessment(recruiter, draft);
  const frozen = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
  check("a legacy job's payload carries null settings",
    frozen.requestPayload?.input?.requestedQuestionCount === null &&
      frozen.requestPayload?.input?.requestedDurationSeconds === null);
  const assessment = await prisma.jobAssessment.findUnique({
    where: { jobId: draft.id }, include: { questions: { orderBy: { sortOrder: "asc" } } },
  });
  check("a legacy job's assessment falls back to the 600s default",
    assessment.durationSeconds === 600, `duration=${assessment.durationSeconds}`);
  check("a legacy job still preserves the recruiter questions verbatim",
    jsonEqual(assessment.questions.slice(0, 3).map((q) => q.prompt), RECRUITER_QUESTIONS));
  return draft.id;
};

// --- scenario 6: Continue-time gate rejects an impossible configuration ------

const scenario4c = async (recruiter) => {
  section("6. Continue-time gate — requested count below the recruiter-question count");

  const draft = await draftFixture(recruiter, "Settings Gate C", { assessmentQuestionCount: 2 });
  await attachJobCandidateList(recruiter, draft.id);
  const started = await jobService.startJob(recruiter.user, draft.id);
  tracked.aiJobIds.push(started.aiJob.id);
  await waitForAiJob(started.aiJob.id, "COMPLETED");

  let message = null;
  try {
    await jobService.continueClarifications(recruiter.user, draft.id);
  } catch (error) {
    message = error.message;
  }
  check("Continue rejects the impossible configuration with 422",
    message?.includes("at least 3"), summarize(message));
  check("no ASSESSMENT_GENERATION AiJob was created for the rejected job",
    (await prisma.aiJob.count({ where: { jobId: draft.id, operation: "ASSESSMENT_GENERATION" } })) === 0);
  check("no JobAssessment was persisted for the rejected job",
    (await prisma.jobAssessment.count({ where: { jobId: draft.id } })) === 0);
  return draft.id;
};

// --- quota, cleanup & report -------------------------------------------------

const quotaCount = async () =>
  prisma.jobQuotaConsumption.count({ where: { jobId: { in: tracked.jobIds } } });

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  subscription: await prisma.subscription.count(),
  subscriptionPlan: await prisma.subscriptionPlan.count(),
});

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

// FK-safe order: assessment invitations → assessments → clarification rows
// (their aiJobId FK is Restrict) → AiJobs → quota → candidate lists
// (Restrict FK) → jobs → subscription → plan → user.
const cleanupDatabase = async () => {
  const removed = {};
  if (tracked.jobIds.length > 0) {
    removed.jobAssessmentInvitation = (
      await prisma.jobAssessmentInvitation.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
    ).count;
    removed.jobAssessment = (
      await prisma.jobAssessment.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
    ).count;
    removed.jobClarificationQuestion = (
      await prisma.jobClarificationQuestion.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
    ).count;
    removed.aiJob = (
      await prisma.aiJob.deleteMany({
        where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }] },
      })
    ).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
    ).count;
    Object.assign(removed, await cleanupJobCandidateLists(prisma, tracked.jobIds));
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
  const [jobs, aiJobs, consumptions, subscriptions, plans, users, assessments, invitations] =
    await Promise.all([
      prisma.job.count({ where: { id: { in: tracked.jobIds } } }),
      prisma.aiJob.count({
        where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }] },
      }),
      prisma.jobQuotaConsumption.count({ where: { jobId: { in: tracked.jobIds } } }),
      prisma.subscription.count({ where: { id: { in: tracked.subscriptionIds } } }),
      prisma.subscriptionPlan.count({ where: { id: { in: tracked.planIds } } }),
      prisma.user.count({ where: { id: { in: tracked.userIds } } }),
      prisma.jobAssessment.count({ where: { jobId: { in: tracked.jobIds } } }),
      prisma.jobAssessmentInvitation.count({ where: { jobId: { in: tracked.jobIds } } }),
    ]);
  return (
    jobs + aiJobs + consumptions + subscriptions + plans + users + assessments + invitations +
    (await countCandidateListLeftovers(prisma, tracked.jobIds))
  );
};

const finish = async (before) => {
  section("Cleanup — stopping processes and removing everything this harness created");

  for (const child of children) {
    await stopProcess(child);
  }
  check("every harness process was stopped (AI service and worker)",
    children.every((child) => child.exitCode !== null || child.signalCode !== null));

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
    if (records.length > 0) leftovers.push(aiJobId);
  }
  check("no harness queue record is left in Redis", leftovers.length === 0, `leftover=${leftovers.length}`);

  const after = await snapshotTotals();
  console.log(`\nplatform totals at start: ${summarize(before)}`);
  console.log(`platform totals at end:   ${summarize(after)}`);
  check("the database was not reset (every pre-existing row count held or grew)",
    Object.keys(before).every((table) => after[table] >= before[table]));

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED CHECKS:");
    failed.forEach((entry) => console.log(`  - ${entry.label}`));
    process.exitCode = 1;
    return;
  }
  console.log("Assessment settings verified: Job Setup limits → frozen payload → AI contract → persistence.");
};

// --- entrypoint --------------------------------------------------------------

const run = async () => {
  console.log("Assessment settings verification harness");
  console.log(`run id: ${SUFFIX}`);
  console.log("contract: Job Setup settings → frozen AiJob payload → exact-count/≤45 AI gates → JobAssessment");
  console.log("provider: deterministic test double injected into the REAL FastAPI app");

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);

  try {
    const recruiter = await createRecruiterFixture("main");

    await scenario1();
    await scenario2();

    const aiService = await startAiService();
    check("the real FastAPI service started under uvicorn and answered /health", true);
    await scenario3();

    // The worker receives only the service coordinates — never a provider key.
    const worker = startWorkerProcess({
      label: "ai-worker",
      env: { AI_SERVICE_URL: serviceUrl, AI_SERVICE_API_KEY: SERVICE_API_KEY },
    });
    await waitFor("worker to connect to Redis", () => worker.output.includes("Redis connected"));

    await scenario4a(recruiter);
    await scenario4b(recruiter);
    await scenario4c(recruiter);

    const quota = await quotaCount();
    check("no additional job quota was consumed by the settings (exactly the three Starts)",
      quota === 3, `quota=${quota}`);

    await stopProcess(worker);
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










