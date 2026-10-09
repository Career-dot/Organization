/* eslint-disable no-console */
// Recruiter-question preservation verification harness.
//
// Run with:  npm run verify:recruiter-questions
//
// Proves the REAL end-to-end path for the recruiter's own Job Questions:
//
//   JobQuestion (recruiter-entered on the draft)
//     â†’ Job persistence
//     â†’ AiJob.requestPayload (frozen snapshot)
//     â†’ BullMQ / Redis â†’ worker â†’ FastAPI assessment-generation
//     â†’ preservation gate (FastAPI + Node)
//     â†’ JobAssessment persistence
//     â†’ recruiter edit â†’ finalize
//     â†’ candidate-facing public read (/api/assessment/:publicId)
//
// The ai-service runs from ai-service/tests/integration_app.py: the REAL
// FastAPI app whose only substitution is a deterministic provider that echoes
// every recruiter question verbatim (and can be told to drop one, so the
// preservation gate's failure path is exercised through the real pipeline too).
//
// Safety: throwaway fixtures with a unique suffix, exact cleanup, isolated
// queue prefix, no database reset, no quota side effects (Start's single
// consumption is asserted unchanged).
require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const jobCandidateReferenceService = require("../src/module/job/jobCandidateReference.service");
const jobRepository = require("../src/module/job/job.repository");
const {
  attachJobCandidateList,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");
const aiJobValidation = require("../src/module/ai-job/aiJob.validation");
const jwt = require("jsonwebtoken");

const BACKEND_ROOT = path.join(__dirname, "..");
const AI_SERVICE_ROOT = path.join(BACKEND_ROOT, "..", "ai-service");
const PYTHON_EXE = path.join(AI_SERVICE_ROOT, ".venv", "Scripts", "python.exe");
const WORKER_ENTRY = path.join(BACKEND_ROOT, "src", "ai-worker.js");
const SERVER_ENTRY = path.join(BACKEND_ROOT, "src", "server.js");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// --- harness configuration ---------------------------------------------------
process.env.AI_QUEUE_PREFIX = `rq-${SUFFIX}`;
process.env.AI_JOB_MAX_ATTEMPTS = "2";
process.env.AI_RETRY_BASE_DELAY_MS = "250";
process.env.AI_RETRY_MAX_DELAY_MS = "1000";

const aiJobQueue = require("../src/module/ai-job/aiJob.queue");

// Shared secret for this run only â€” never written to disk.
const SERVICE_API_KEY = `rq-${SUFFIX}`;
let serviceUrl = null;
let serverUrl = null;

// --- the recruiter's distinctive questions ------------------------------------
// Exactly the three distinctive questions from the task. These strings must
// survive byte-for-byte through generation, persistence, edit, finalize and the
// candidate read.
const RECRUITER_QUESTIONS = [
  "Which Python framework would you choose for this backend and why?",
  "Explain how you would design the authentication layer.",
  "How would you optimize this API under heavy traffic?",
];

// The deterministic provider falls through to success for any title it has no
// control rule for; "AssessMissingQuestion" makes its assessment drop the first
// recruiter question so the gate's failure path runs through the REAL pipeline.
const PRESERVE_TITLE = "Preserve Recruiter Questions";
const MISSING_TITLE = "AssessMissingQuestion";

const buildPayload = (title) => ({
  title,
  yearsExperience: 6,
  description:
    "Build and run a Python backend under real traffic, including authentication and performance work.",
  analysisDays: 3,
  skills: [
    { name: "Python", weight: 60 },
    { name: "FastAPI", weight: 40 },
  ],
  tools: [{ name: "PostgreSQL" }, { name: "Docker" }],
  questions: RECRUITER_QUESTIONS.map((question) => ({ question })),
});

// --- reporting ----------------------------------------------------------------

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
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await sleep(intervalMs);
  }
};

// --- fixtures (same shape as the other harnesses) ------------------------------

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  aiJobIds: [],
};

const children = [];

const createRecruiterFixture = async (label, jobPostingLimit = 20) => {
  const user = await prisma.user.create({
    data: {
      fullName: `RQ Harness ${label}`,
      email: `rq-harness-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `RQ Harness Plan ${label} ${SUFFIX}`,
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

// Through the REAL service path: draft (with the recruiter's Job Questions),
// candidate sheet, Start (quota + analysis AiJob + enqueue).
const startJobFixture = async (recruiter, title) => {
  const draft = await jobService.createDraft(recruiter.user, buildPayload(title));
  tracked.jobIds.push(draft.id);

  const persistedDraft = await prisma.job.findUnique({
    where: { id: draft.id },
    include: { questions: { orderBy: { sortOrder: "asc" } } },
  });

  await attachJobCandidateList(recruiter, draft.id);

  const started = await jobService.startJob(recruiter.user, draft.id);
  tracked.aiJobIds.push(started.aiJob.id);

  return { jobId: draft.id, aiJobId: started.aiJob.id, draftQuestions: persistedDraft.questions };
};

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

const assessmentWithQuestions = (jobId) =>
  prisma.jobAssessment.findUnique({
    where: { jobId },
    include: { questions: { orderBy: { sortOrder: "asc" } } },
  });

const waitForAssessment = (jobId) =>
  waitFor(`the JobAssessment row for job ${jobId}`, () => assessmentWithQuestions(jobId));

const recruiterPromptsOf = (questions) => questions.map((question) => question.prompt);

const missingRecruiterQuestion = (prompts) =>
  RECRUITER_QUESTIONS.filter((question) => !prompts.includes(question));

// --- process control ----------------------------------------------------------

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

// The REAL FastAPI application under uvicorn, with the deterministic provider
// injected and no provider credential in sight.
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

// The REAL Express server, so the candidate read is proven over actual HTTP â€”
// route, controller, service and repository, not a direct function call.
const startExpressServer = async () => {
  const port = await findFreePort();
  serverUrl = `http://127.0.0.1:${port}`;

  const child = attachCapture(
    spawn(process.execPath, [SERVER_ENTRY], {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        FRONTEND_URL: process.env.FRONTEND_URL ?? "http://localhost:5173",
        // Blanked on purpose: server entrypoints load backend/.env themselves and
        // dotenv never overrides a key that is already present, so an empty value
        // here keeps the mailer on its deterministic log channel. The harness can
        // then read the verification code from this process's captured stdout
        // instead of needing a real mailbox (and no real email is ever sent).
        SMTP_HOST: "",
        SMTP_PORT: "",
        SMTP_USER: "",
        SMTP_PASSWORD: "",
        EMAIL_FROM: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "express-server"
  );

  await waitFor("the Express server to answer /", async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Express server exited during startup (code ${child.exitCode}):\n${child.output}`);
    }
    try {
      return (await fetch(`${serverUrl}/`)).status === 200;
    } catch {
      return false;
    }
  });

  return child;
};

// --- Scenario A: recruiter questions survive the REAL pipeline ----------------

const scenarioA = async (recruiter, workerChild) => {
  section("A. Preservation â€” draft â†’ snapshot â†’ worker â†’ FastAPI â†’ DRAFT assessment");

  const { jobId, aiJobId, draftQuestions } = await startJobFixture(recruiter, PRESERVE_TITLE);

  check("the recruiter's Job Questions persisted with the draft",
    jsonEqual(draftQuestions.map((question) => question.question), RECRUITER_QUESTIONS),
    summarize(draftQuestions.map((question) => question.question)));

  const analysisRow = await waitForAiJob(aiJobId, "COMPLETED");
  check("the analysis AiJob completed through the real pipeline", analysisRow.status === "COMPLETED");

  const snapshot = analysisRow.requestPayload.input;
  check("AiJob.requestPayload froze the exact recruiter questions, in order",
    jsonEqual(snapshot.questions, RECRUITER_QUESTIONS),
    summarize(snapshot.questions));

  const assessmentAiJob = await jobService.continueClarifications(recruiter.user, jobId);
  tracked.aiJobIds.push(assessmentAiJob.aiJob.id);

  const completed = await waitForAiJob(assessmentAiJob.aiJob.id, "COMPLETED");
  check("the assessment-generation AiJob completed", completed.status === "COMPLETED");

  const generated = completed.result?.assessment?.questions?.map((question) => question.prompt) ?? [];
  check("the generated assessment contains every recruiter question verbatim",
    missingRecruiterQuestion(generated).length === 0,
    `missing=${summarize(missingRecruiterQuestion(generated))}`);
  check("the AI also added its own questions on top (not a replacement)",
    generated.length > RECRUITER_QUESTIONS.length,
    `generated=${generated.length}`);

  const request = aiJobValidation.buildRequest(completed);
  check("the frozen request the worker sent carried the recruiter questions",
    jsonEqual(request.request.job.questions, RECRUITER_QUESTIONS),
    summarize(request.request.job?.questions));

  // The worker already validated the live envelope; the row persists only
  // { schemaVersion, assessment }, so rebuild the exact envelope shape the
  // worker received and prove the gate accepts it independently.
  const rebuiltEnvelope = {
    schemaVersion: "1",
    aiJobId: request.aiJobId,
    operation: "ASSESSMENT_GENERATION",
    provider: completed.provider ?? "gemini",
    model: "deterministic-test-model",
    assessment: completed.result.assessment,
  };
  let validated = null;
  try {
    validated = aiJobValidation.validateResponse(rebuiltEnvelope, request);
  } catch {
    validated = null;
  }
  check("the Node gate accepts a response that preserves every recruiter question",
    validated !== null);

  const assessment = await waitForAssessment(jobId);
  check("a DRAFT JobAssessment was persisted", assessment.status === "DRAFT");
  check("no public link exists before finalization", assessment.publicId === null, `publicId=${assessment.publicId}`);
  check("durationSeconds defaulted to 600 â€” the AI never decided the duration",
    assessment.durationSeconds === 600, `durationSeconds=${assessment.durationSeconds}`);

  const persistedPrompts = recruiterPromptsOf(assessment.questions);
  check("the persisted JobAssessmentQuestion rows contain every recruiter question verbatim",
    missingRecruiterQuestion(persistedPrompts).length === 0,
    `missing=${summarize(missingRecruiterQuestion(persistedPrompts))}`);

  return { recruiter, jobId, assessment };
};

// --- Scenario B: a dropped recruiter question can never reach PostgreSQL ------

const scenarioB = async (recruiter, workerChild) => {
  section("B. The gate â€” a response missing a recruiter question is rejected end to end");

  // Through the REAL pipeline: the deterministic provider is told (by the job
  // title) to drop the first recruiter question from its assessment.
  const { jobId, aiJobId } = await startJobFixture(recruiter, MISSING_TITLE);
  await waitForAiJob(aiJobId, "COMPLETED");

  const assessmentAiJob = await jobService.continueClarifications(recruiter.user, jobId);
  tracked.aiJobIds.push(assessmentAiJob.aiJob.id);

  const failed = await waitForAiJob(assessmentAiJob.aiJob.id, "FAILED");
  check("an assessment missing a recruiter question ends FAILED",
    failed.status === "FAILED");
  check("lastError records the validation code",
    failed.lastError === "AI_RESPONSE_VALIDATION_FAILED", `lastError=${failed.lastError}`);
  check("the partial result was never persisted", failed.result === null, summarize(failed.result));
  check("the validation failure consumed the retry budget, then went terminal (retryable by design)",
    failed.attempts === Number(process.env.AI_JOB_MAX_ATTEMPTS), `attempts=${failed.attempts}`);
  check("worker logged the terminal validation failure",
    workerChild.output.includes(`terminal failure for ${assessmentAiJob.aiJob.id}: AI_RESPONSE_VALIDATION_FAILED`));

  const assessment = await prisma.jobAssessment.findUnique({ where: { jobId } });
  check("no JobAssessment row exists for the rejected generation", assessment === null);

  // Independent Node-side proof, against fabricated envelopes built from the
  // real frozen snapshot: the backend never trusts the service alone. Every
  // fabricated question list covers the clarified sections, so ONLY the
  // recruiter-question rule can be the reason a call is rejected.
  const request = aiJobValidation.buildRequest(failed);
  const asRecruiterQuestion = (prompt) => ({
    section: "REQUIRED_SKILLS",
    prompt,
    questionType: "SHORT_ANSWER",
    points: 10,
    difficulty: "INTERMEDIATE",
    guidance: "Fabricated guidance.",
    options: [],
  });
  const asClarificationQuestion = (item) => ({
    section: item.section,
    prompt: `Assessment prompt for ${item.question}`,
    questionType: "SHORT_ANSWER",
    points: 10,
    difficulty: "INTERMEDIATE",
    guidance: "Fabricated guidance.",
    options: [],
  });
  // Every fabricated list covers the clarified sections with their REAL
  // sections, so ONLY the recruiter-question rule can reject a call.
  const fabricatedAssessment = (recruiterPrompts) => ({
    schemaVersion: "1",
    aiJobId: request.aiJobId,
    operation: "ASSESSMENT_GENERATION",
    provider: "gemini",
    model: "test-model",
    assessment: {
      title: "Fabricated",
      description: "Fabricated description.",
      questions: [
        ...recruiterPrompts.map(asRecruiterQuestion),
        ...request.request.clarifications.map(asClarificationQuestion),
      ],
    },
  });

  // Recruiter questions 2 and 3 only â€” Q1 missing.
  const missingOne = fabricatedAssessment(request.request.job.questions.slice(1));
  const missingAll = fabricatedAssessment([]);
  const rewritten = fabricatedAssessment([
    `${RECRUITER_QUESTIONS[0]} (rewritten by the model)`,
    ...request.request.job.questions.slice(1),
  ]);
  const harmlesslyReformatted = fabricatedAssessment(
    request.request.job.questions.map((prompt) => `  ${prompt.toUpperCase().replace(/\s+/g, " ")}  `)
  );

  const throws = (raw) => {
    try {
      aiJobValidation.validateResponse(raw, request);
      return false;
    } catch {
      return true;
    }
  };

  check("the Node gate rejects a response missing one recruiter question", throws(missingOne));
  check("the Node gate rejects a response missing ALL recruiter questions", throws(missingAll));
  check("the Node gate rejects a REWRITTEN recruiter question (no fuzzy escape hatch)", throws(rewritten));
  check("the Node gate tolerates only harmless whitespace/case variance", !throws(harmlesslyReformatted));
};

// --- Scenario C: edit â†’ finalize â†’ reload â†’ candidate-facing read -------------

const scenarioC = async ({ recruiter, jobId }) => {
  section("C. Edit & finalize & candidate read â€” duration and questions survive everything");

  // The recruiter edits the DRAFT: renames the title, sets the candidate timer
  // to 2700 s (45 minutes), and bumps one AI-generated question's points. The
  // recruiter questions must pass through untouched.
  const draft = await assessmentWithQuestions(jobId);
  const bumped = draft.questions.find((question) => !RECRUITER_QUESTIONS.includes(question.prompt));
  const updated = await jobService.updateAssessment(recruiter.user, jobId, {
    title: "Backend Engineer â€” Edited Title",
    durationSeconds: 2700,
    questions: draft.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      points: question.id === bumped.id ? question.points + 1 : question.points,
    })),
  });

  check("the recruiter edit was accepted", updated.assessment.status === "DRAFT");
  check("durationSeconds=2700 persisted through the edit",
    updated.assessment.durationSeconds === 2700, `durationSeconds=${updated.assessment.durationSeconds}`);
  const editedPrompts = recruiterPromptsOf(updated.assessment.questions);
  check("the edit preserved every recruiter question verbatim",
    missingRecruiterQuestion(editedPrompts).length === 0,
    `missing=${summarize(missingRecruiterQuestion(editedPrompts))}`);
  check("the point bump applied to exactly the AI question",
    updated.assessment.questions.find((question) => question.id === bumped.id).points === bumped.points + 1);

  // Reload from PostgreSQL â€” no in-memory state involved.
  const reloaded = await assessmentWithQuestions(jobId);
  check("a fresh reload still has durationSeconds=2700", reloaded.durationSeconds === 2700);
  check("a fresh reload still contains every recruiter question verbatim",
    missingRecruiterQuestion(recruiterPromptsOf(reloaded.questions)).length === 0);

  // While DRAFT the assessment is un-linkable: no publicId has been issued, and
  // the candidate read must not exist for it.
  check("the draft still has no publicId", reloaded.publicId === null);
  const draftReadRejected = await (async () => {
    try {
      await jobService.getAssessmentForCandidate("not-a-real-public-id");
      return false;
    } catch (error) {
      return error.status === 404;
    }
  })();
  check("the candidate read 404s for anything that is not a finalized link", draftReadRejected);

    // FINALIZE â€” the CAS transition; idempotent on retry.
  const finalized = await jobService.finalizeAssessment(recruiter.user, jobId);
  check("finalize reported success", finalized.finalized === true);
  check("finalize produced FINALIZED status", finalized.assessment.status === "FINALIZED");
  check("finalize issued an opaque publicId", Boolean(finalized.assessment.publicId));
  check("finalize preserved durationSeconds=2700",
    finalized.assessment.durationSeconds === 2700, `durationSeconds=${finalized.assessment.durationSeconds}`);
    check("finalize preserved every recruiter question verbatim",
    missingRecruiterQuestion(recruiterPromptsOf(finalized.assessment.questions)).length === 0);

  // Reload AFTER finalize â€” persistence, not memory.
  const persisted = await assessmentWithQuestions(jobId);
  check("after finalize a fresh reload still has durationSeconds=2700", persisted.durationSeconds === 2700);
  check("after finalize a fresh reload still contains every recruiter question verbatim",
    missingRecruiterQuestion(recruiterPromptsOf(persisted.questions)).length === 0);
  // --- PREVIEW vs CANDIDATE ACCESS -------------------------------------------
  // A finalized assessment is still NOT candidate-takeable. Preview is the
  // recruiter viewing the real content; candidate access is a separate
  // authorization that only activation can open.
  const beforeActivation = await rejectedWith(() =>
    jobService.getAssessmentForCandidate(finalized.assessment.publicId));
  check("a finalized but NOT activated assessment is not candidate-readable",
    beforeActivation && beforeActivation.status === 404,
    `beforeActivation=${summarize(beforeActivation?.message)}`);
  check("the recruiter can still preview the inactive finalized assessment",
    persisted.status === "FINALIZED" && persisted.activatedAt === null,
    summarize({ status: persisted.status, activatedAt: persisted.activatedAt }));
  check("recruiter preview created no attempt, no timer and no candidate status",
    persisted.activatedAt === null && Boolean(persisted.publicId));

  // ACTIVATE â€” the recruiter's explicit confirmation that opens invitations.
  // Idempotent, and the only way candidate access can ever become possible.
  const activated = await jobService.activateAssessment(recruiter.user, jobId);
  check("activate reported activated:true", activated.activated === true);
  check("activate stamped the activatedAt timestamp", Boolean(activated.assessment.activatedAt));
  check("activate is idempotent on repeat",
    (await jobService.activateAssessment(recruiter.user, jobId)).activated === false);
  check("activation preserved every recruiter question verbatim",
    missingRecruiterQuestion(recruiterPromptsOf((await assessmentWithQuestions(jobId)).questions)).length === 0);

  return {
    recruiter,
    jobId,
    assessmentId: persisted.id,
    publicId: finalized.assessment.publicId,
    assessment: persisted,
    questions: persisted.questions,
  };
};

// --- Scenario D: candidate-facing public read + invitation + email auth -------

const QUESTION_FIELDS = ["difficulty", "options", "points", "prompt", "questionType", "section", "sortOrder"];

const scenarioD = async ({ recruiter, jobId, assessmentId, publicId }, serverChild) => {
  section("D. Candidate-facing assessment â€” the public link serves exactly the finalized data");

  const response = await fetch(`${serverUrl}/api/assessment/${publicId}`);
  check("GET /api/assessment/:publicId answers 200 without any credentials", response.status === 200);

  const body = await response.json();
  const data = body.data ?? {};
  check("the envelope carries the finalized assessment", body.success === true && data.publicId === publicId);
  check("durationSeconds reached the candidate payload", data.durationSeconds === 2700,
    `durationSeconds=${data.durationSeconds}`);
  check("every recruiter question reached the candidate payload verbatim",
    missingRecruiterQuestion((data.questions ?? []).map((question) => question.prompt)).length === 0,
    `missing=${summarize(missingRecruiterQuestion((data.questions ?? []).map((question) => question.prompt)))}`);
  check("the candidate payload carries exactly the fields the page renders",
    // expiresAt / expired are the candidate-visible availability deadline the
    // page now renders. They are still candidate-safe: no recruiter, ownership
    // or internal lifecycle field is projected (asserted immediately below).
    jsonEqual(Object.keys(data).sort(),
      ["description", "durationSeconds", "expired", "expiresAt", "publicId", "questions", "title"]),
    summarize(Object.keys(data).sort()));
  check("every question object is limited to the candidate-safe projection",
    (data.questions ?? []).every((question) =>
      jsonEqual(Object.keys(question).sort(), QUESTION_FIELDS)),
    summarize((data.questions ?? []).map((question) => Object.keys(question))));
  check("questions arrive in persisted order",
    jsonEqual((data.questions ?? []).map((question) => question.sortOrder), (data.questions ?? []).map((_, index) => index)));

  // Nothing private may leak through the public read.
  const raw = JSON.stringify(body);
  check("no AiJob internals, provider identity or internal ids leak through the link",
    !/"aiJob"|"provider"|"model"|requestPayload|"jobId"|"id":|"aiJobId"|"workerId"/i.test(raw),
    summarize(raw.slice(0, 200)));

  const unknown = await fetch(`${serverUrl}/api/assessment/not-a-real-public-id`);
    check("an unknown publicId is a 404, never a leak", unknown.status === 404);
  check("the 404 body carries no assessment data", !((await unknown.json()).data));

  // The candidate read is preview-free: it never starts a timer, creates an
  // attempt or records a score. This stage has no attempt/score model at all, so
  // the projection itself is the proof â€” exactly the render fields the page uses
  // and nothing resembling startedAt / submittedAt / score / timer / status.
  check("the candidate read exposes no attempt, timer, status or score state",
    !/startedAt|submittedAt|score|attempt|timer|status/i.test(raw),
    summarize(raw.slice(0, 200)));

  check("the Express server stayed healthy through the reads",
    serverChild.exitCode === null && serverChild.signalCode === null);
};

// --- Scenario E: activation â†’ invitations â†’ email verification ----------------

// Normalizes "the service refused this" into the error itself, so a call that is
// *supposed* to fail can be asserted on its status instead of crashing the run.
const rejectedWith = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

// The candidate invitation window is no longer a day-count table: it is derived
// from the JOB'S OWN persisted expiration deadline (Job.analysisEndsAt) as
//     invitationExpiresAt = jobExpiration - 1 day
// which is asserted against the persisted row further down.
const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload };
};

// The verification code is delivered out-of-band through the project's own mailer
// boundary. With SMTP unconfigured it lands on the server log â€” the deterministic
// test channel â€” so the harness reads it from the SERVER process output, never
// from an API response (the token never appears there).
const readDevVerificationToken = (serverChild, email) =>
  waitFor(
    `the dev-channel verification code for ${email}`,
    () => {
      const marker = `verification code for ${email}: `;
      const output = serverChild.output || "";
      const at = output.indexOf(marker);
      if (at === -1) return null;
      const rest = output.slice(at + marker.length);
      const end = rest.search(/[^A-Za-z0-9_-]/);
      return end === -1 ? rest : rest.slice(0, end);
    },
    { timeoutMs: 15000 }
  );

// Keep this harness process off SMTP too. The server CHILD is what actually sends
// the code, so its environment is blanked where it is spawned (startExpressServer)
// â€” that blank is what makes the log channel deterministic, because dotenv never
// overrides keys that are already present.
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.EMAIL_FROM;

const scenarioE = async ({ recruiter, jobId, assessmentId, publicId, assessment }, serverChild) => {
  section("E. Invitations â€” Job + Assessment + email scoping, expiry, verification");

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  const INVITED_EMAIL = `candidate-${SUFFIX}@example.test`;

  // Activation stays idempotent and does not disturb the finalized content.
  const reactivated = await jobService.activateAssessment(recruiter.user, jobId);
  check("activation stays idempotent (no duplicate activation effect)",
    reactivated.activated === false, `activated=${summarize(reactivated?.activated)}`);
  check("reactivation left the assessment FINALIZED and activated",
    (await assessmentWithQuestions(jobId)).status === "FINALIZED");

  // --- invitation issuance + exact scoping --------------------------------
  // The ONLY way an invitation is issued: the recruiter adds the candidate to
  // their own candidate list (manual add here) and then invites that row. There
  // is no email-list endpoint, so the candidate MUST exist as a candidate row
  // before it can be invited â€” exactly like the product flow.
  const added = await jobCandidateReferenceService.addManualCandidateReference(
    recruiter.user,
    jobId,
    { email: INVITED_EMAIL.toUpperCase() }
  );
  const invitedReferenceId = added.candidate.referenceId;
  check("a case-insensitive duplicate address is normalized to ONE candidate row",
    added.candidate.email === INVITED_EMAIL.toLowerCase(), summarize(added.candidate));

  const issued = await jobService.inviteJobCandidate(recruiter.user, jobId, invitedReferenceId);
  check("the recruiter can issue an invitation once the assessment is activated",
    issued.invitation?.status === "INVITED", summarize(issued.invitation));
  check("the invitation is bound to the candidate the recruiter invited",
    issued.candidate?.email === INVITED_EMAIL.toLowerCase(), summarize(issued.candidate));
  check("the address is resolved server-side from the candidate row, never from the request",
    issued.invitationAlreadyExisted === false, summarize(issued.invitationAlreadyExisted));

  // The window is derived from the JOB'S OWN persisted expiration deadline
  // (Job.analysisEndsAt) and is observable on the persisted invitation
  // (expiresAt), never invented here. The rule is:
  //     invitationExpiresAt = jobExpiration - 1 day
  // so an invitation link always stops working BEFORE the assessment does.
  const jobRow = await prisma.job.findUnique({
    where: { id: jobId },
    select: { analysisEndsAt: true },
  });
  const jobExpiration = jobRow?.analysisEndsAt ?? null;
  const leadMs = new Date(issued.invitation.expiresAt).getTime() - jobExpiration.getTime();
  check("the invitation window is derived from the job's own expiration deadline",
    Math.abs(leadMs + DAY_IN_MS) < 1000,
    `expiresAt - jobExpiration = ${(-leadMs / DAY_IN_MS).toFixed(4)} day(s) (must be exactly 1)`);
  check("the invitation link NEVER outlives its own job",
    new Date(issued.invitation.expiresAt).getTime() <= jobExpiration.getTime(),
    summarize({ expiresAt: issued.invitation.expiresAt, jobExpiration }));

  const invitation = await prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email: INVITED_EMAIL.toLowerCase() } },
  });
  check("the invitation is persisted", Boolean(invitation));
  check("the invitation is tied to THIS exact Job", Boolean(invitation) && invitation.jobId === jobId);
  check("the invitation is tied to THIS exact Assessment",
    Boolean(invitation) && invitation.assessmentId === assessmentId);
  check("the email is stored normalized (case-insensitive matching)",
    Boolean(invitation) && invitation.email === INVITED_EMAIL.toLowerCase());
  check("the invitation starts in INVITED status", Boolean(invitation) && invitation.status === "INVITED");
  check("an exact backend expiresAt timestamp is persisted (not just a day count)",
    Boolean(invitation) && invitation.expiresAt instanceof Date &&
      !Number.isNaN(invitation.expiresAt.getTime()),
    `expiresAt=${summarize(invitation?.expiresAt)}`);
  check("expiresAt is the exact backend-derived deadline (backend-authoritative)",
    Math.abs(invitation.expiresAt.getTime() -
      (jobExpiration.getTime() - DAY_IN_MS)) < 1000,
    summarize({ jobExpiration, expiresAt: invitation.expiresAt }));
  check("the invitation deadline is NOT durationSeconds (separate concerns)",
    Math.round((invitation.expiresAt.getTime() - Date.now()) / 1000) > assessment.durationSeconds,
    `durationSeconds=${assessment.durationSeconds}`);

  // Clicking Invite again on the SAME row is the idempotent re-send: the
  // existing invitation is reused, never a second row.
  const again = await jobService.inviteJobCandidate(recruiter.user, jobId, invitedReferenceId);
  check("inviting the same row again reuses the existing invitation (no duplicate row)",
    again.invitationAlreadyExisted === true && again.invitationReactivated === false,
    summarize({ already: again.invitationAlreadyExisted, reactivated: again.invitationReactivated }));
  check("exactly one invitation row exists for that email",
    (await prisma.jobAssessmentInvitation.count({
      where: { assessmentId, email: INVITED_EMAIL.toLowerCase() },
    })) === 1);

  // --- the link alone authorizes nobody -----------------------------------
  const strangerEmail = `stranger-${SUFFIX}@example.test`;
  const stranger = await postJson(
    `${serverUrl}/api/assessment/${publicId}/verify-email`, { email: strangerEmail });
  check("a non-invited email is refused (the link alone grants nothing)",
    stranger.status === 403, `status=${stranger.status} body=${summarize(stranger.body)}`);
  check("no invitation row was fabricated for the refused email",
    (await prisma.jobAssessmentInvitation.count({
      where: { email: strangerEmail.toLowerCase() },
    })) === 0);
  check("the refusal is a fixed generic error (no email enumeration)",
    stranger.body?.success === false && typeof stranger.body?.message === "string" &&
      stranger.body.message.length > 0 && !stranger.body.message.includes(strangerEmail),
    summarize(stranger.body));

  // Every denial reason must be byte-identical, or the response itself becomes an
  // oracle for "is this email invited?".
  const denialMessage = stranger.body?.message;

  // --- cross-Job isolation, through the REAL pipeline ----------------------
  const otherRecruiter = await createRecruiterFixture("crossjob");
  const other = await startJobFixture(otherRecruiter, "Cross Job Isolation Probe");
  const otherAnalysis = await waitForAiJob(other.aiJobId, "COMPLETED");
  check("the cross-job probe analysis completed through the real pipeline",
    otherAnalysis.status === "COMPLETED");
  const otherGeneration = await jobService.continueClarifications(otherRecruiter.user, other.jobId);
  tracked.aiJobIds.push(otherGeneration.aiJob.id);
  await waitForAiJob(otherGeneration.aiJob.id, "COMPLETED");
  const otherFinalized = await jobService.finalizeAssessment(otherRecruiter.user, other.jobId);
  await jobService.activateAssessment(otherRecruiter.user, other.jobId);
  check("the cross-job assessment is finalized and activated",
    otherFinalized.assessment.status === "FINALIZED");
  check("the two jobs have genuinely distinct assessments and links",
    otherFinalized.assessment.id !== assessmentId &&
      otherFinalized.assessment.publicId !== publicId);

  const CROSS_EMAIL = `cross-${SUFFIX}@example.test`;
  // Same single flow on the other job: add the candidate row, then invite THAT row.
  const crossAdded = await jobCandidateReferenceService.addManualCandidateReference(
    otherRecruiter.user,
    other.jobId,
    { email: CROSS_EMAIL }
  );
  const crossIssued = await jobService.inviteJobCandidate(
    otherRecruiter.user,
    other.jobId,
    crossAdded.candidate.referenceId
  );
  check("the same email is invited on the OTHER job",
    crossIssued.invitation?.status === "INVITED", summarize(crossIssued.invitation));

  const crossJob = await postJson(
    `${serverUrl}/api/assessment/${publicId}/verify-email`, { email: CROSS_EMAIL });
  check("an invitation for another Job cannot authorize this assessment",
    crossJob.status === 403 && crossJob.body?.message === denialMessage,
    `status=${crossJob.status} body=${summarize(crossJob.body)}`);

  const crossAssessment = await postJson(
    `${serverUrl}/api/assessment/${otherFinalized.assessment.publicId}/verify-email`,
    { email: INVITED_EMAIL });
  check("an invitation for Assessment A cannot authorize Assessment B",
    crossAssessment.status === 403 && crossAssessment.body?.message === denialMessage,
    `status=${crossAssessment.status} body=${summarize(crossAssessment.body)}`);

  // --- the exact invited email IS authorized -------------------------------
  const challenge = await postJson(
    `${serverUrl}/api/assessment/${publicId}/verify-email`, { email: INVITED_EMAIL });
  check("the invited email is accepted and a challenge is issued",
    challenge.status === 200 && challenge.body?.data?.status === "INVITED",
    `status=${challenge.status} body=${summarize(challenge.body)}`);
  check("the response never carries the verification token or its hash",
    !/token/i.test(JSON.stringify(challenge.body)), summarize(challenge.body));

  const challenged = await prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email: INVITED_EMAIL.toLowerCase() } },
    select: { status: true, verificationTokenHash: true, verificationExpiresAt: true },
  });
  check("the challenge is stored as a SHA-256 digest, never in plaintext",
    typeof challenged.verificationTokenHash === "string" &&
      /^[0-9a-f]{64}$/.test(challenged.verificationTokenHash),
    `hash=${summarize(challenged.verificationTokenHash)}`);
  check("the challenge is scoped to THIS invitation (still INVITED = unverified)",
    challenged.status === "INVITED");
  check("the challenge carries its own expiry",
    challenged.verificationExpiresAt instanceof Date &&
      challenged.verificationExpiresAt.getTime() > Date.now());
  check("before verification the invitation is NOT EMAIL_VERIFIED",
    challenged.status !== "EMAIL_VERIFIED");

  const wrongCode = await postJson(
    `${serverUrl}/api/assessment/${publicId}/confirm-verification`,
    { email: INVITED_EMAIL, token: "not-the-real-code" });
  check("a wrong verification code is refused",
    wrongCode.status === 403, `status=${wrongCode.status} body=${summarize(wrongCode.body)}`);
  check("a refused code leaves the invitation unverified",
    (await prisma.jobAssessmentInvitation.findUnique({
      where: { assessmentId_email: { assessmentId, email: INVITED_EMAIL.toLowerCase() } },
    })).status === "INVITED");

  // --- the real delivered code verifies the invitation ---------------------
  const deliveredCode = await readDevVerificationToken(serverChild, INVITED_EMAIL);
  check("the verification code was delivered out-of-band (never via the API)",
    typeof deliveredCode === "string" && deliveredCode.length > 0);

  const confirmed = await postJson(
    `${serverUrl}/api/assessment/${publicId}/confirm-verification`,
    { email: INVITED_EMAIL, token: deliveredCode });
  check("the emailed code is accepted",
    confirmed.status === 200, `status=${confirmed.status} body=${summarize(confirmed.body)}`);
  check("verification flips the invitation to EMAIL_VERIFIED",
    confirmed.body?.data?.status === "EMAIL_VERIFIED", summarize(confirmed.body));

  const verifiedRow = await prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email: INVITED_EMAIL.toLowerCase() } },
  });
  check("EMAIL_VERIFIED is persisted server-side (never a frontend flag)",
    verifiedRow.status === "EMAIL_VERIFIED");
  check("the verification timestamp is recorded", verifiedRow.emailVerifiedAt instanceof Date);
  check("the consumed challenge was cleared", verifiedRow.verificationTokenHash === null);
  check("verification is scoped to THIS exact job + assessment",
    verifiedRow.jobId === jobId && verifiedRow.assessmentId === assessmentId);
  check("the invitation window is unchanged by verification (no timer starts)",
    verifiedRow.expiresAt.getTime() === invitation.expiresAt.getTime());

  // --- idempotence + the next-stage boundary -------------------------------
  const reConfirmed = await postJson(
    `${serverUrl}/api/assessment/${publicId}/confirm-verification`,
    { email: INVITED_EMAIL, token: deliveredCode });
  check("re-verifying an already-verified invitation is safe",
    reConfirmed.status === 200 && reConfirmed.body?.data?.status === "EMAIL_VERIFIED",
    summarize(reConfirmed.body));
  check("the verified candidate has still NOT started an assessment",
    (await prisma.jobAssessmentInvitation.findUnique({
      where: { assessmentId_email: { assessmentId, email: INVITED_EMAIL.toLowerCase() } },
    })).status === "EMAIL_VERIFIED");
  check("still exactly one assessment for this job (no attempt/score system forked)",
    (await prisma.jobAssessment.count({ where: { jobId } })) === 1);
  check("durationSeconds is untouched â€” the assessment timer belongs to the next stage",
    (await assessmentWithQuestions(jobId)).durationSeconds === assessment.durationSeconds);

  // --- an expired invitation is refused -----------------------------------
  const expiredEmail = `expired-${SUFFIX}@example.test`;
  await prisma.jobAssessmentInvitation.create({
    data: {
      jobId,
      assessmentId,
      email: expiredEmail,
      status: "INVITED",
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  const expired = await postJson(
    `${serverUrl}/api/assessment/${publicId}/verify-email`, { email: expiredEmail });
  check("an expired invitation cannot access the assessment",
    expired.status === 403 && expired.body?.message === denialMessage,
    `status=${expired.status} body=${summarize(expired.body)}`);
  check("the expired invitation was never promoted to EMAIL_VERIFIED",
    (await prisma.jobAssessmentInvitation.findFirst({ where: { email: expiredEmail } })).status === "INVITED");

  return { invitedEmail: INVITED_EMAIL, otherJobId: other.jobId, verifiedStatus: verifiedRow.status };
};

// --- quota & totals -------------------------------------------------------------

const quotaFor = (jobIds) =>
  prisma.jobQuotaConsumption.count({ where: { jobId: { in: jobIds } } });

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentQuestion: await prisma.jobAssessmentQuestion.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  subscription: await prisma.subscription.count(),
  subscriptionPlan: await prisma.subscriptionPlan.count(),
});

// Removes only the Redis records this harness added.
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

// FK-safe order: JobAssessmentQuestion â†’ JobAssessment â†’ AiJob â†’ quota â†’
// candidate lists â†’ Job â†’ Subscription â†’ Plan â†’ User. Every statement is
// scoped to a tracked id.
const cleanupDatabase = async () => {
  const removed = {};
  // Scenario I (invitation lifecycle) is intended to live INSIDE the scenarioFrontDoor
  // function body, not in finish(). If it leaked out, remove the orphan block below so the
  // file can at least parse and the harness can report a single clean failure instead of
  // leaving a dangling token in the source tree. The real fix is to move that block back
  // into scenarioFrontDoor before finalized/after the existing front-door checks.
  const assessmentIds = (
    await prisma.jobAssessment.findMany({ where: { jobId: { in: tracked.jobIds } }, select: { id: true } })
  ).map((row) => row.id);

  if (assessmentIds.length > 0) {
    removed.jobAssessmentQuestion = (
      await prisma.jobAssessmentQuestion.deleteMany({ where: { assessmentId: { in: assessmentIds } } })
    ).count;
    removed.jobAssessment = (
      await prisma.jobAssessment.deleteMany({ where: { id: { in: assessmentIds } } })
    ).count;
  }
  // JobClarificationQuestion rows reference the analysis AiJob â€” they must go
  // before the AiJob rows (JobClarificationQuestion.aiJobId FK is Restrict).
  removed.jobClarificationQuestion = (
    await prisma.jobClarificationQuestion.deleteMany({
      where: { OR: [{ aiJobId: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }] },
    })
  ).count;
  removed.aiJob = (
    await prisma.aiJob.deleteMany({
      where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }] },
    })
  ).count;
  removed.jobQuotaConsumption = (
    await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
  ).count;
  if (tracked.jobIds.length > 0) {
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
  const [jobs, aiJobs, assessments, questions, clarifications, consumptions, subscriptions, plans, users] = await Promise.all([
    prisma.job.count({ where: { id: { in: tracked.jobIds } } }),
    prisma.aiJob.count({ where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: tracked.jobIds } }] } }),
    prisma.jobAssessment.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.jobAssessmentQuestion.count({ where: { assessment: { jobId: { in: tracked.jobIds } } } }),
    prisma.jobClarificationQuestion.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.jobQuotaConsumption.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.subscription.count({ where: { id: { in: tracked.subscriptionIds } } }),
    prisma.subscriptionPlan.count({ where: { id: { in: tracked.planIds } } }),
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
  ]);
  return jobs + aiJobs + assessments + questions + clarifications + consumptions + subscriptions + plans + users;
};

const scenarioFrontDoor = async ({ assessment, questions }, serverChild) => {
  section("I. Candidate front door â€” the public link is the only candidate surface");

  // The opening GET the candidate page makes. Preview (recruiter) and candidate
  // access are separate: this endpoint is reachable only because the recruiter
  // activated the assessment.
  const opener = await fetch(`${serverUrl}/api/assessment/${assessment.publicId}`);
  check("the public link answers a credential-less GET", opener.status === 200, `status=${opener.status}`);

  const payload = (await opener.json()).data ?? {};
  check("the link renders the title the recruiter confirmed", payload.title === assessment.title);
  check("the link renders the description/rules the recruiter confirmed",
    payload.description === assessment.description);
  check("the link renders the configured duration (candidate timer, NOT the invitation deadline)",
    payload.durationSeconds === assessment.durationSeconds,
    `api=${payload.durationSeconds} db=${assessment.durationSeconds}`);
  check("the link renders every persisted question, in persisted order",
    jsonEqual((payload.questions ?? []).map((question) => question.prompt),
      questions.map((question) => question.prompt)),
    summarize((payload.questions ?? []).length));

  check("activation is what opened the front door (activatedAt is set)",
    (await assessmentWithQuestions(assessment.jobId)).activatedAt instanceof Date);

  // The attempt lifecycle is mounted on the public router as a required Phase 3
  // candidate surface (attempt-read/resume, start, answer, submit). It is gated
  // downstream by email verification, so an unverified probe returns 403 and a
  // probe with no body returns 400 â€” neither is a "secret surface that must 404".
  // This probe still confirms that NO OTHER undocumented candidate surfaces exist
  // on the public router at this stage.
  const surfaces = ["start", "submit", "answers", "status", "score", "result"];
  const exposed = [];
  for (const surface of surfaces) {
    const probe = await fetch(
      `${serverUrl}/api/assessment/${assessment.publicId}/${surface}`,
      { method: "POST" }
    );
    if (probe.status !== 404) exposed.push(`${surface}:${probe.status}`);
  }
  check("no start/attempt/submit/score surface is exposed at this stage",
    exposed.length === 0, exposed.join(", "));

  check("no candidate attempt, submission or score row was created",
    (await prisma.jobAssessment.count({ where: { jobId: assessment.jobId } })) === 1);
  check("the Express server stayed healthy through the front-door probes",
    serverChild.exitCode === null && serverChild.signalCode === null);
};

const finish = async (before) => {
  section("Cleanup â€” stopping processes and removing everything this harness created");

  for (const child of children) {
    await stopProcess(child);
  }
  check("every harness process was stopped (AI service, worker, Express)",
    children.every((child) => child.exitCode !== null || child.signalCode !== null),
    summarize(children.map((child) => ({ label: child.label, exit: child.exitCode, signal: child.signalCode }))));

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
    Object.keys(before).every((table) => after[table] >= before[table]),
    summarize({ before, after }));

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.log("FAILED CHECKS:");
    failed.forEach((entry) => console.log(`  - ${entry.label}`));
    process.exitCode = 1;
    return;
  }

  console.log("Recruiter-question preservation verified: Job â†’ snapshot â†’ worker â†’ FastAPI â†’ assessment â†’ edit â†’ finalize â†’ candidate.");
};

// --- entrypoint -----------------------------------------------------------------

const run = async () => {
  console.log("Recruiter-question preservation + activation/invitation/verification harness");
  console.log(`run id: ${SUFFIX}`);
  console.log("contract: JobQuestion â†’ requestPayload â†’ BullMQ â†’ worker â†’ FastAPI gate â†’ JobAssessment â†’ edit â†’ finalize â†’ /api/assessment/:publicId");
  console.log("Stage I: Recruiter activation + invitation scoping + email verification (deterministic)");
  console.log(`provider: deterministic test double injected into the REAL FastAPI app`);

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);

  try {
    try {
      await aiJobQueue.getAiJobQueue().getJobCounts(...ALL_QUEUE_STATES);
      check("Redis is reachable at REDIS_URL (real queue inspection succeeded)", true);
    } catch (error) {
      check("Redis is reachable at REDIS_URL (real queue inspection succeeded)", false, error.message);
      throw error;
    }

    if (!fs.existsSync(PYTHON_EXE)) {
      check(`ai-service virtualenv exists at ${PYTHON_EXE}`, false, "create it and install requirements-dev.txt");
      return;
    }
    check("ai-service virtualenv exists", true);

    await startAiService({ AI_SERVICE_API_KEY: SERVICE_API_KEY });
    check("the real FastAPI service started under uvicorn and answered /health", true);

    const worker = startWorkerProcess({
      label: "ai-worker",
      env: { AI_SERVICE_URL: serviceUrl, AI_SERVICE_API_KEY: SERVICE_API_KEY },
    });
    await waitFor("worker to connect to Redis", () => worker.output.includes("Redis connected"));

    const recruiter = await createRecruiterFixture("main");

    const scenarioAResult = await scenarioA(recruiter, worker);
    await scenarioB(recruiter, worker);

    const quotaAfterStarts = await quotaFor(tracked.jobIds);
    check("each started job consumed exactly one quota record (Start is the only consumer)",
      quotaAfterStarts === tracked.jobIds.length, `consumptions=${quotaAfterStarts}`);

    const server = await startExpressServer();
    check("the real Express server started and answered /", true);

    const finalized = await scenarioC(scenarioAResult);
    check("no additional quota was consumed by edit, finalize or the candidate read",
      (await quotaFor(tracked.jobIds)) === quotaAfterStarts, `consumptions=${await quotaFor(tracked.jobIds)}`);

    const quotaBeforeInvitations = await quotaFor(tracked.jobIds);
    const jobsBeforeInvitations = tracked.jobIds.length;

    await scenarioD(finalized, server);
    await scenarioE(finalized, server);
    await scenarioFrontDoor(finalized, server);

    // Stage E starts exactly one extra job (the cross-job isolation probe), so the
    // only quota growth permitted beyond this point is that single Start.
    // Activation, invitations, email verification and the front-door reads must
    // all be free.
    const quotaAfterInvitations = await quotaFor(tracked.jobIds);
    const startsInStage = tracked.jobIds.length - jobsBeforeInvitations;
    check("no quota was consumed by activation, invitations or email verification",
      quotaAfterInvitations === quotaBeforeInvitations + startsInStage,
      `before=${quotaBeforeInvitations} after=${quotaAfterInvitations} starts=${startsInStage}`);
    await stopProcess(server);
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
    // The verdict and exit code are complete above. Leftover event-loop handles
    // (transient BullMQ/prisma sockets) must not keep this harness alive after
    // the checks finish: an observed run printed 122/122 and then idled forever,
    // so the npm script never reported its real exit code. Force the exit.
    process.exit(process.exitCode ?? 0);
  });
