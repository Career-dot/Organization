/* eslint-disable no-console */
// Phase 7 Step 4 verification: real CandidateReference → AiJob → BullMQ →
// separate Node worker → real FastAPI app → PostgreSQL JobCandidateAnalysis.
//
// Analysis is never recruiter-initiated: each scenario commits a real terminal
// assessment attempt and then invokes the one automatic entry point
// (runAutomaticCandidateAnalysis), which is exactly what the assessment lifecycle
// does after it commits SUBMITTED / TIMED_UP / CHEATED.
//
// The only provider substitution is the existing deterministic FastAPI test
// provider. The primary success path uses real PostgreSQL, Redis, BullMQ, the
// production worker, HTTP, Pydantic validation, Node response validation, and
// transactional persistence. Failure controls live only in that test provider.
//
// Run: npm run verify:candidate-analysis-pipeline
require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const XLSX = require("xlsx");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const referenceService = require("../src/module/job/jobCandidateReference.service");
const aiJobRepository = require("../src/module/ai-job/aiJob.repository");
const aiJobClient = require("../src/module/ai-job/aiJob.client");
const aiJobValidation = require("../src/module/ai-job/aiJob.validation");
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const {
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

const BACKEND_ROOT = path.join(__dirname, "..");
const ROOT = path.join(BACKEND_ROOT, "..");
const AI_SERVICE_ROOT = path.join(ROOT, "ai-service");
const PYTHON_EXE = path.join(AI_SERVICE_ROOT, ".venv", "Scripts", "python.exe");
const WORKER_ENTRY = path.join(BACKEND_ROOT, "src", "ai-worker.js");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Isolated queue namespace and a short retry budget make the real failure paths
// deterministic without touching any production worker or queue.
process.env.AI_QUEUE_PREFIX = `candidate-pipeline-${SUFFIX}`;
process.env.AI_JOB_MAX_ATTEMPTS = "2";
process.env.AI_RETRY_BASE_DELAY_MS = "100";
process.env.AI_RETRY_MAX_DELAY_MS = "500";
process.env.AI_REQUEST_TIMEOUT_MS = "300";
const SERVICE_API_KEY = `candidate-pipeline-${SUFFIX}`;

const results = [];
const children = [];
const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  aiJobIds: [],
};
let serviceUrl = null;
let workerChild = null;

const section = (title) => console.log(`\n${title}`);
const summarize = (value) => JSON.stringify(value ?? null);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (label, probe, { timeoutMs = 30000, intervalMs = 100 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
};
const expectRejection = async (label, fn, status) => {
  try {
    await fn();
    check(label, false, `expected ${status}, but resolved`);
    return null;
  } catch (error) {
    check(label, error.status === status, `expected ${status}, got ${error.status}: ${error.message}`);
    return error;
  }
};
const fileExists = async (filePath) => {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
};


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

const capture = (child, label) => {
  child.label = label;
  child.output = "";
  child.stdout.on("data", (chunk) => {
    child.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk.toString();
  });
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
  if (!fs.existsSync(PYTHON_EXE)) throw new Error(`Missing Python environment: ${PYTHON_EXE}`);
  const port = await findFreePort();
  serviceUrl = `http://127.0.0.1:${port}`;
  const child = capture(
    spawn(
      PYTHON_EXE,
      ["-m", "uvicorn", "integration_app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"],
      {
        cwd: AI_SERVICE_ROOT,
        env: {
          ...process.env,
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
  await waitFor("FastAPI /health", async () => {
    if (child.exitCode !== null) throw new Error(`FastAPI exited: ${child.output}`);
    try {
      return (await fetch(`${serviceUrl}/health`)).status === 200;
    } catch {
      return false;
    }
  });
  return child;
};

const startWorker = () => {
  workerChild = capture(
    spawn(process.execPath, [WORKER_ENTRY], {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        AI_SERVICE_URL: serviceUrl,
        AI_SERVICE_API_KEY: SERVICE_API_KEY,
        GEMINI_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "ai-worker"
  );
  return workerChild;
};

const queueJobsFor = async (aiJobId) => {
  const queue = aiJobQueue.getAiJobQueue();
  const states = ["completed", "failed", "delayed", "active", "waiting", "prioritized"];
  const jobs = await queue.getJobs(states, 0, -1);
  return jobs.filter((job) => job?.data?.aiJobId === aiJobId);
};

const waitForQueueFailure = (aiJobId, timeoutMs = 10000) =>
  waitFor(
    `BullMQ ${aiJobId} to become failed`,
    async () => {
      const queue = aiJobQueue.getAiJobQueue();
      const direct = await queue.getJob(`aiJob-${aiJobId}`);
      if (direct?.getState() === "failed") return direct;
      const failedJobs = await queue.getJobs(["failed"], 0, -1);
      return failedJobs.find((job) => job?.data?.aiJobId === aiJobId) ?? null;
    },
    { timeoutMs }
  );

const waitForAiJob = (aiJobId, status, timeoutMs = 30000) =>
  waitFor(
    `AiJob ${aiJobId} → ${status}`,
    async () => {
      const row = await prisma.aiJob.findUnique({ where: { id: aiJobId } });
      return row?.status === status ? row : null;
    },
    { timeoutMs }
  );
const waitForAnalysis = (aiJobId, timeoutMs = 30000) =>
  waitFor(
    `JobCandidateAnalysis ${aiJobId}`,
    async () => {
      const row = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId } });
      return row?.completedAt ? row : null;
    },
    { timeoutMs }
  );

const createRecruiter = async () => {
  const user = await prisma.user.create({
    data: {
      fullName: `Candidate Pipeline ${SUFFIX}`,
      email: `candidate-pipeline-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Candidate Pipeline Plan ${SUFFIX}`,
      type: "RECRUITER",
      price: 0,
      billingCycle: "MONTHLY",
      jobPostingLimit: 20,
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
  return { id: user.id, role: "RECRUITER" };
};

const buildWorkbook = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Email", "LinkedIn", "GitHub", "Preferred Role", "Skills", "Skill Notes"],
    ...rows,
  ]);
  return XLSX.write(
    { SheetNames: ["Candidates"], Sheets: { Candidates: sheet } },
    { type: "buffer", bookType: "xlsx" }
  );
};

const JOB_PAYLOAD = {
  title: "Candidate Pipeline Backend Engineer",
  yearsExperience: 5,
  description: "Build and operate reliable backend services using Node.js and PostgreSQL.",
  analysisDays: 3,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe one production reliability decision you owned." }],
};

const createActiveJob = async (recruiter, rows, name) => {
  const draft = await jobService.createDraft(recruiter, { ...JOB_PAYLOAD, title: name });
  tracked.jobIds.push(draft.id);
  const buffer = buildWorkbook(rows);
  await jobService.uploadCandidateList(recruiter, draft.id, {
    originalname: `candidate-pipeline-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
  const started = await jobService.startJob(recruiter, draft.id);
  const startAiJobId = started.aiJob.id;
  tracked.aiJobIds.push(startAiJobId);
  return { jobId: draft.id, startAiJobId };
};

const candidateEmail = (label) => `candidate-${label}-${SUFFIX}@example.test`;
const getReference = async (jobId, email) =>
  prisma.jobCandidateReference.findUnique({ where: { jobId_candidateEmail: { jobId, candidateEmail: email } } });
const getReferenceById = (jobId, id) =>
  prisma.jobCandidateReference.findFirst({ where: { id, jobId } });

const setReferenceEvidence = async (jobId, referenceId, data) => {
  const result = await prisma.jobCandidateReference.updateMany({
    where: { id: referenceId, jobId },
    data,
  });
  if (result.count !== 1) throw new Error("Reference fixture update failed");
  return getReferenceById(jobId, referenceId);
};

// A job owns exactly one assessment (JobAssessment.jobId is unique) and one attempt
// per candidate (@@unique([assessmentId, email])), so the assessment and its question
// are created once per job and reused by every candidate analyzed in it.
const ensureAssessment = async (jobId) => {
  const existing = await prisma.jobAssessment.findUnique({ where: { jobId } });
  if (existing) return existing;
  const assessment = await prisma.jobAssessment.create({
    data: {
      jobId,
      title: "Pipeline backend assessment",
      description: "Authoritative assessment evidence.",
      status: "FINALIZED",
      publicId: `pipe-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
      durationSeconds: 600,
    },
  });
  await prisma.jobAssessmentQuestion.create({
    data: {
      assessmentId: assessment.id,
      section: "REQUIRED_SKILLS",
      sortOrder: 0,
      prompt: "Explain how you would migrate a production PostgreSQL schema safely.",
      questionType: "SHORT_ANSWER",
      points: 10,
    },
  });
  return assessment;
};

// Commits an attempt exactly as the assessment lifecycle commits it: terminal, with
// its authoritative score. This committed row is the only input the automatic
// analysis trigger ever receives, which is why the evidence can never be captured
// before it exists.
const createAssessmentAttempt = async ({ jobId, email, answerText, status = "SUBMITTED" }) => {
  const assessment = await ensureAssessment(jobId);
  const question = await prisma.jobAssessmentQuestion.findFirst({ where: { assessmentId: assessment.id } });
  const invitation = await prisma.jobAssessmentInvitation.create({
    data: {
      jobId,
      assessmentId: assessment.id,
      email,
      expiresAt: new Date(Date.now() + DAY_IN_MS),
      status: "EMAIL_VERIFIED",
      emailVerifiedAt: new Date(),
    },
  });
  const now = new Date();
  const attempt = await prisma.jobAssessmentAttempt.create({
    data: {
      jobId,
      assessmentId: assessment.id,
      invitationId: invitation.id,
      email,
      status,
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      deadlineAt: new Date(Date.now() + DAY_IN_MS),
      submittedAt: status === "SUBMITTED" ? now : null,
      timedOutAt: status === "TIMED_UP" ? now : null,
      cheatedAt: status === "CHEATED" ? now : null,
      ...(status === "SUBMITTED" ? { score: 8, maxScore: 10, scorePercentage: 80 } : {}),
    },
  });
  await prisma.jobAssessmentAttemptAnswer.create({
    data: { attemptId: attempt.id, questionId: question.id, answer: { text: answerText } },
  });
  return { assessment, attempt, question };
};

// The recruiter no longer starts candidate analysis: the SYSTEM does, once the
// assessment attempt has been COMMITTED in a terminal state. Every scenario below
// therefore drives that real funnel - commit the terminal attempt, then invoke the
// one entry point that still exists - and asserts the trigger's own refusals.
const requestAnalysis = async (recruiter, jobId, referenceId, { answerText, status } = {}) => {
  const reference = (await referenceService.listCandidateReferences(recruiter, jobId))
    .find((row) => row.id === referenceId);
  if (!reference) throw new Error(`Reference ${referenceId} does not belong to job ${jobId}`);
  const { attempt } = await createAssessmentAttempt({
    jobId,
    email: reference.candidateEmail,
    answerText,
    status,
  });
  const result = await referenceService.runAutomaticCandidateAnalysis({
    id: attempt.id,
    jobId: attempt.jobId,
    assessmentId: attempt.assessmentId,
    email: attempt.email,
    status: attempt.status,
  });
  if (result.triggered) tracked.aiJobIds.push(result.aiJob.id);
  return result;
};

// Replays the terminal lifecycle touch for a candidate whose attempt is already
// committed - exactly what the assessment lifecycle does when it re-enters the same
// post-commit funnel. It must never create a second attempt, and the trigger must
// decline to analyze the same terminal attempt twice.
const replayAutomaticAnalysis = async (recruiter, jobId, referenceId) => {
  const reference = (await referenceService.listCandidateReferences(recruiter, jobId))
    .find((row) => row.id === referenceId);
  if (!reference) throw new Error(`Reference ${referenceId} does not belong to job ${jobId}`);
  const attempt = await prisma.jobAssessmentAttempt.findFirst({
    where: { jobId, assessment: { jobId }, email: reference.candidateEmail },
  });
  if (!attempt) throw new Error(`No committed assessment attempt for reference ${referenceId}`);
  return referenceService.runAutomaticCandidateAnalysis({
    id: attempt.id,
    jobId: attempt.jobId,
    assessmentId: attempt.assessmentId,
    email: attempt.email,
    status: attempt.status,
  });
};

const scenarioHappyPath = async (recruiter) => {
  section("A. Real end-to-end pipeline and frozen sanitized request");
  const email = candidateEmail("happy");
  const jobA = await createActiveJob(
    recruiter,
    [["Happy Candidate", email, "https://linkedin.com/in/happy", "github.com/happy", "Backend Engineer", "Node.js, PostgreSQL", "Recruiter evidence"]],
    "Pipeline Happy A"
  );
  const jobB = await createActiveJob(
    recruiter,
    [["Happy Candidate", email, "", "", "Backend Engineer", "Node.js", "Different job evidence"]],
    "Pipeline Happy B"
  );
  const refA = await getReference(jobA.jobId, email);
  const refB = await getReference(jobB.jobId, email);
  check("the same email in two jobs creates two distinct job-scoped references", refA.id !== refB.id);
  check("each reference remains anchored to its requested job", refA.jobId === jobA.jobId && refB.jobId === jobB.jobId);

  const fullAnswer = `M${"igration-evidence-".repeat(260)}`;
  await setReferenceEvidence(jobA.jobId, refA.id, {
    resumeText: "Resume evidence unique to Job A.",
    linkedinText: "LinkedIn text evidence for Job A.",
    githubText: "GitHub text evidence for Job A.",
    skillNotes: `Job A recruiter notes ${email.toUpperCase()}`,
  });
  await setReferenceEvidence(jobB.jobId, refB.id, {
    resumeText: "Resume evidence unique to Job B.",
    linkedinUrl: "https://linkedin.com/in/happy-b",
    githubUrl: "https://github.com/happy-b",
  });
  const created = await requestAnalysis(recruiter, jobA.jobId, refA.id, { answerText: fullAnswer });
  check("the automatic trigger refuses nothing here: the committed terminal attempt starts the analysis", created.triggered === true && created.analysis?.analysisVersion === 1 && created.aiJob?.status === "PENDING", summarize(created));
  const pending = await prisma.aiJob.findUnique({ where: { id: created.aiJob.id } });
  const analysisPending = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: created.aiJob.id } });
  check("the service commits one PENDING CANDIDATE_ANALYSIS AiJob", pending?.operation === "CANDIDATE_ANALYSIS" && pending.status === "PENDING");
  check("AiJob scope is opaque candidate reference + version (never email)", pending.scopeKey === `${refA.id}:v1` && !pending.scopeKey.includes(email));
  check("the frozen payload uses the opaque reference id as candidateKey", pending.requestPayload.input.candidateKey === refA.id);
  check("the analysis row is 1:1 with the AiJob and starts at version 1", analysisPending.aiJobId === pending.id && analysisPending.analysisVersion === 1);
  check("the assessment attempt is linked only by internal lineage", analysisPending.attemptId && analysisPending.candidateEmail === email);
  const queued = await queueJobsFor(pending.id);
  check("BullMQ receives exactly one minimal { aiJobId } delivery", queued.length === 1 && jsonEqual(queued[0].data, { aiJobId: pending.id }));

  const completed = await waitForAiJob(pending.id, "COMPLETED");
  const analysis = await waitForAnalysis(pending.id);
  const request = aiJobValidation.buildRequest(completed);
  const requestText = JSON.stringify(request);
  check("the worker completes the claimed AiJob", completed.attempts === 1 && completed.workerId === null);
  check("JobCandidateAnalysis materializes in the same completion lifecycle", analysis.completedAt instanceof Date && analysis.provider === "gemini" && Boolean(analysis.model));
  check("the validated qualitative analysis is persisted", analysis.result?.jobFitSummary && analysis.result?.finalRecruiterReview);
  check("the persisted analysis contains no combined/ranking/hiring score", !/overallScore|combinedScore|candidateScore|fitPercentage|weightedOverallScore|candidateRankingScore|hiringDecision/i.test(JSON.stringify(analysis.result)));
  check("the exact worker request preserves the job requirements", request.job.title === "Pipeline Happy A" && request.job.skills.length === 2);
  check("case-insensitive email occurrences in recruiter evidence are redacted from the request", request.candidate.skillNotes.includes("[REDACTED_EMAIL]") && !request.candidate.skillNotes.includes(email));
  check("the request maps recruiter questions and leaves responsibilities empty", request.job.recruiterQuestions.length === 1 && request.job.responsibilities.length === 0);
  check("available resume/LinkedIn/GitHub text maps with explicit AVAILABLE statuses", request.candidate.resumeEvidenceStatus === "AVAILABLE" && request.candidate.linkedinEvidenceStatus === "AVAILABLE" && request.candidate.githubEvidenceStatus === "AVAILABLE");
  check("the original >4000 character answer is truncated only in the AI request", request.assessment.questions[0].candidateAnswer.answer.length === 4000 && request.assessment.questions[0].candidateAnswer.truncated === true);
  const persistedAnswer = await prisma.jobAssessmentAttemptAnswer.findFirst({ where: { attemptId: analysis.attemptId } });
  check("the persisted candidate answer remains complete and unchanged", persistedAnswer.answer.text === fullAnswer && persistedAnswer.answer.text.length > 4000);
  check("the request contains factual assessment score but no reconstructed per-question correctness", request.assessment.score === 8 && request.assessment.questions[0].earnedPoints === null);
  check("no raw email, correct answer, integrity, token, or secret field enters the FastAPI body", !requestText.includes(email) && !/correctAnswer|answerKey|verificationToken|integrity|password|apiKey|subscription|quota/i.test(requestText));
  check("no filesystem/StoredFile identity enters the FastAPI body", !/resumeFileId|storagePath|storedFile/i.test(requestText));
  check("worker logs remain metadata-only and do not leak evidence", !workerChild.output.includes(email) && !workerChild.output.includes(fullAnswer) && !workerChild.output.includes("Resume evidence unique"));

  const accepted = await fetch(`${serviceUrl}/internal/v1/candidate-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_API_KEY}` },
    body: JSON.stringify(request),
  });
  const envelope = await accepted.json();
  check("the exact worker request is accepted by the real FastAPI endpoint", accepted.status === 200);
  check("the response has the required provider/model/analysis envelope", envelope.operation === "CANDIDATE_ANALYSIS" && envelope.provider === "gemini" && Boolean(envelope.model) && Boolean(envelope.analysis));
  check("the worker-side validator accepts the FastAPI response", (() => {
    try {
      aiJobValidation.validateResponse(envelope, request);
      return true;
    } catch {
      return false;
    }
  })());

  const createdB = await requestAnalysis(recruiter, jobB.jobId, refB.id);
  await waitForAiJob(createdB.aiJob.id, "COMPLETED");
  const rowB = await prisma.aiJob.findUnique({ where: { id: createdB.aiJob.id } });
  check("the same email in another job gets a different AiJob and reference scope", rowB.id !== pending.id && rowB.scopeKey === `${refB.id}:v1`);
  check("URL-only LinkedIn/GitHub evidence is explicitly UNAVAILABLE, not fetched", rowB.requestPayload.input.candidate.linkedinEvidenceStatus === "UNAVAILABLE" && rowB.requestPayload.input.candidate.githubEvidenceStatus === "UNAVAILABLE" && rowB.requestPayload.input.candidate.linkedinText === null);
  check("resume evidence is isolated to Job B", rowB.requestPayload.input.candidate.resumeText === "Resume evidence unique to Job B." && !JSON.stringify(rowB.requestPayload).includes("Resume evidence unique to Job A."));
  return { jobA, jobB, refA, refB, email, firstAiJobId: pending.id, firstAnalysisId: analysis.id };
};

const scenarioVersionsAndDuplicate = async (recruiter, context) => {
  section("B. One automatic analysis per terminal attempt, deterministic hash, duplicate delivery, and candidate isolation");
  const firstBefore = await prisma.jobCandidateAnalysis.findUnique({ where: { id: context.firstAnalysisId } });
  const firstRequest = await prisma.aiJob.findUnique({ where: { id: context.firstAiJobId } });
  const { analysisVersion: _transportVersion, ...snapshot } = firstRequest.requestPayload.input;
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  const changed = structuredClone(snapshot);
  changed.candidate.skillNotes = "Meaningfully changed recruiter evidence";
  check("the same logical snapshot has a stable SHA-256 hash", referenceService.hashCandidateAnalysisSnapshot(snapshot) === referenceService.hashCandidateAnalysisSnapshot(reordered));
  check("a meaningful snapshot change produces a different hash", referenceService.hashCandidateAnalysisSnapshot(snapshot) !== referenceService.hashCandidateAnalysisSnapshot(changed));
  check("the persisted hash matches the canonical frozen snapshot", firstBefore.snapshotHash === referenceService.hashCandidateAnalysisSnapshot(snapshot));

  // Version 2 is no longer reachable: an analysis belongs to a terminal attempt, and
  // an attempt is terminal exactly once. Changed recruiter evidence therefore cannot
  // produce a second version - the frozen snapshot simply stays authoritative.
  const frozenSkillNotes = firstRequest.requestPayload.input.candidate.skillNotes;
  await setReferenceEvidence(context.jobA.jobId, context.refA.id, {
    skillNotes: "Meaningfully changed recruiter evidence",
    resumeText: "Replacement resume evidence added after the attempt closed.",
  });
  const second = await replayAutomaticAnalysis(recruiter, context.jobA.jobId, context.refA.id);
  check("an already-analyzed terminal attempt is refused, so no version 2 can be allocated", second.triggered === false && second.reason === "ALREADY_ANALYZED", summarize(second));
  check("the refused re-run enqueues no second AiJob and writes no second analysis", (await prisma.aiJob.count({ where: { jobId: context.jobA.jobId, operation: "CANDIDATE_ANALYSIS" } })) === 1 && (await prisma.jobCandidateAnalysis.count({ where: { jobId: context.jobA.jobId } })) === 1, summarize({ aiJobs: await prisma.aiJob.count({ where: { jobId: context.jobA.jobId, operation: "CANDIDATE_ANALYSIS" } }) }));
  const firstAfter = await prisma.jobCandidateAnalysis.findUnique({ where: { id: context.firstAnalysisId } });
  check("version 1 snapshot hash and result remain unchanged after the refused re-run", firstAfter.snapshotHash === firstBefore.snapshotHash && jsonEqual(firstAfter.result, firstBefore.result), summarize({ before: firstBefore.snapshotHash, after: firstAfter.snapshotHash }));
  const firstRequestAfter = await prisma.aiJob.findUnique({ where: { id: context.firstAiJobId } });
  check("the frozen request is never rebuilt from evidence edited after the attempt closed", firstRequestAfter.requestPayload.input.candidate.skillNotes === frozenSkillNotes && firstRequestAfter.scopeKey === `${context.refA.id}:v1`, summarize({ skillNotes: firstRequestAfter.requestPayload.input.candidate.skillNotes, scopeKey: firstRequestAfter.scopeKey }));

  const beforeCount = await prisma.jobCandidateAnalysis.count({ where: { aiJobId: context.firstAiJobId } });
  const duplicate = await aiJobRepository.claimAiJobForProcessing({ aiJobId: context.firstAiJobId, workerId: "duplicate-probe" });
  check("a duplicate delivery cannot claim an already COMPLETED AiJob", duplicate === null);
  check("duplicate delivery creates no second JobCandidateAnalysis", beforeCount === 1 && (await prisma.jobCandidateAnalysis.count({ where: { aiJobId: context.firstAiJobId } })) === 1);

  const emailX = candidateEmail("x");
  const emailY = candidateEmail("y");
  const job = await createActiveJob(
    recruiter,
    [["Candidate X", emailX, "", "", "Backend", "Node.js", "X-only notes"], ["Candidate Y", emailY, "", "", "Frontend", "React", "Y-only notes"]],
    "Pipeline Two Candidates"
  );
  const refX = await getReference(job.jobId, emailX);
  const refY = await getReference(job.jobId, emailY);
  await setReferenceEvidence(job.jobId, refX.id, { resumeText: "Resume X only" });
  await setReferenceEvidence(job.jobId, refY.id, { resumeText: "Resume Y only" });
  const runX = await requestAnalysis(recruiter, job.jobId, refX.id);
  const runY = await requestAnalysis(recruiter, job.jobId, refY.id);
  await Promise.all([waitForAiJob(runX.aiJob.id, "COMPLETED"), waitForAiJob(runY.aiJob.id, "COMPLETED")]);
  const rowX = await prisma.aiJob.findUnique({ where: { id: runX.aiJob.id } });
  const rowY = await prisma.aiJob.findUnique({ where: { id: runY.aiJob.id } });
  check("two candidates in one job create two independent AiJobs", rowX.id !== rowY.id && rowX.scopeKey !== rowY.scopeKey);
  check("candidate X payload contains no candidate Y evidence", rowX.requestPayload.input.candidate.resumeText === "Resume X only" && !JSON.stringify(rowX.requestPayload).includes("Resume Y only"));
  check("candidate Y payload contains no candidate X evidence", rowY.requestPayload.input.candidate.resumeText === "Resume Y only" && !JSON.stringify(rowY.requestPayload).includes("Resume X only"));
  return { twoCandidateJobId: job.jobId };
};

const runFailure = async (recruiter, control, expectedCode, expectedAttempts) => {
  const email = candidateEmail(control.toLowerCase());
  const job = await createActiveJob(
    recruiter,
    [[control, email, "", "", "Backend", "Node.js", "Failure fixture"]],
    `Pipeline ${control}`
  );
  const reference = await getReference(job.jobId, email);
  const created = await requestAnalysis(recruiter, job.jobId, reference.id);
  const failed = await waitForAiJob(created.aiJob.id, "FAILED");
  const analysis = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: created.aiJob.id } });
  check(`${control} ends FAILED with ${expectedCode}`, failed.lastError === expectedCode, summarize(failed.lastError));
  check(`${control} consumes the configured retry budget`, failed.attempts === expectedAttempts, `attempts=${failed.attempts}`);
  check(`${control} never persists a partial/fabricated result`, failed.result === null && analysis.result === null && analysis.completedAt === null);
  return { aiJobId: created.aiJob.id, jobId: job.jobId };
};

const scenarioFailures = async (recruiter) => {
  section("C. FastAPI/provider failures use the existing retry taxonomy");
  const resultsByType = {};
  resultsByType.retry = await runFailure(recruiter, "CandidateRetry", "AI_PROVIDER_RATE_LIMITED", 2);
  resultsByType.unavailable = await runFailure(recruiter, "CandidateUnavailable", "AI_PROVIDER_UNAVAILABLE", 2);
  resultsByType.timeout = await runFailure(recruiter, "CandidateTimeout", "AI_PROVIDER_TIMEOUT", 2);
  resultsByType.malformed = await runFailure(recruiter, "CandidateMalformed", "AI_RESPONSE_VALIDATION_FAILED", 2);
  resultsByType.safety = await runFailure(recruiter, "CandidateSafety", "AI_PROVIDER_SAFETY_BLOCKED", 1);
  for (const [type, ids] of Object.entries(resultsByType)) {
    const terminalQueueJob = await waitForQueueFailure(ids.aiJobId);
    check(`${type} failure has one terminal BullMQ record and no success`, Boolean(terminalQueueJob));
  }
  return resultsByType;
};

const scenarioStaticAndLegacy = async () => {
  section("D. Static architecture guards and unchanged legacy operation dispatch");
  const routeSource = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "job", "job.routes.js"), "utf8");
  const workerSource = fs.readFileSync(path.join(BACKEND_ROOT, "src", "ai-worker.js"), "utf8");
  const clientSource = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "ai-job", "aiJob.client.js"), "utf8");
  const serviceSource = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "job", "jobCandidateReference.service.js"), "utf8");
  const repositorySource = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "ai-job", "aiJob.repository.js"), "utf8");
  const fastApiFiles = [
    "app/routes/candidate_analysis.py",
    "app/services/candidate_analysis.py",
    "app/prompts/candidate_analysis.py",
  ].map((relative) => fs.readFileSync(path.join(AI_SERVICE_ROOT, relative), "utf8"));
  const attemptServiceSource = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "job", "jobAssessmentAttempt.service.js"), "utf8");
  check(
    "no recruiter-triggered analysis route survives; the terminal assessment lifecycle is the only entry point",
    !routeSource.includes("/:jobId/candidate-references/:referenceId/analyze") &&
      !/requestCandidateAnalysis/.test(routeSource) &&
      /AUTOMATIC_ANALYSIS_STATUSES = new Set\(\["SUBMITTED", "TIMED_UP", "CHEATED"\]\)/.test(attemptServiceSource) &&
      attemptServiceSource.includes("jobCandidateReferenceService.runAutomaticCandidateAnalysis") &&
      !/fetch\(|@google\/genai|GEMINI_API_KEY|getAiServiceConfig/.test(attemptServiceSource)
  );
  check(
    "the candidate service owns the whole automatic path and still delegates to the Step 4 enqueue",
    serviceSource.includes("const runAutomaticCandidateAnalysis") &&
      !/requestCandidateAnalysis/.test(serviceSource) &&
      serviceSource.includes("createAndDeliverCandidateAnalysis") &&
      serviceSource.includes("enqueueAiJobDelivery")
  );
  check("the shared worker/client are the only Node FastAPI caller path", clientSource.includes("fetch(config.url") && workerSource.includes("analyze(claimed)"));
  check("candidate-analysis production code contains no Gemini SDK/key", !/GEMINI_API_KEY|@google\/genai|gemini_api_key/i.test(`${serviceSource}\n${workerSource}`));
  check("candidate snapshot code has no verification score/import", !/verificationReport|verificationEvidence|verifiedSkillScore|verificationRead/i.test(serviceSource));
  check("candidate snapshot code has no external URL fetch primitives", !/\bfetch\s*\(|axios|https?\.get|request\s*\(/.test(serviceSource));
  check("FastAPI candidate-analysis layer remains DB/Redis/queue free", fastApiFiles.every((source) => !/prisma|postgres|psycopg|asyncpg|redis|bullmq|sqlalchemy/i.test(source)));
  check("no browser storage is used by the Node candidate pipeline", !/localStorage|sessionStorage/.test(`${serviceSource}\n${repositorySource}\n${workerSource}`));
  const hook = fs.readFileSync(path.join(ROOT, "frontend", "src/hooks/useJobCandidateRealtime.js"), "utf8");
  const realtimeEvents = fs.readFileSync(path.join(BACKEND_ROOT, "src/module/job/jobAssessmentRealtime.events.js"), "utf8");
  check("candidate-analysis uses the existing shared recruiter SSE architecture after Step 6", /CANDIDATE_ANALYSIS_UPDATED/.test(realtimeEvents) && /CANDIDATE_ANALYSIS_UPDATED/.test(hook));
  check("no bulk candidate-analysis behavior exists and no recruiter handler creates an analysis", !/bulk.*candidate.*analysis/i.test(`${routeSource}\n${workerSource}\n${serviceSource}`) && !/requestCandidateAnalysis/.test(`${routeSource}\n${serviceSource}`));

  const legacyJobRow = {
    id: "legacy_job_1",
    operation: "JOB_ANALYSIS",
    requestPayload: {
      operation: "JOB_ANALYSIS",
      input: { title: "Legacy", yearsExperience: 3, description: "Legacy job analysis", skills: [{ name: "Node.js", weight: 100 }], tools: ["Docker"], questions: ["Why Node.js?"] },
    },
  };
  const legacyAssessmentRow = {
    id: "legacy_assessment_1",
    operation: "ASSESSMENT_GENERATION",
    requestPayload: {
      operation: "ASSESSMENT_GENERATION",
      input: {
        job: legacyJobRow.requestPayload.input,
        clarifications: [],
        requestedQuestionCount: 1,
        requestedDurationSeconds: 600,
      },
    },
  };
  check("JOB_ANALYSIS still builds its unchanged request shape", aiJobValidation.buildRequest(legacyJobRow).operation === "JOB_ANALYSIS");
  check("ASSESSMENT_GENERATION still builds its unchanged request shape", aiJobValidation.buildRequest(legacyAssessmentRow).operation === "ASSESSMENT_GENERATION");
  check("legacy operations still default to the empty scope key", await prisma.aiJob.count({ where: { operation: { in: ["JOB_ANALYSIS", "ASSESSMENT_GENERATION"] }, scopeKey: { not: "" } } }) === 0);
};

const scenarioPersistenceAndNetwork = async (recruiter, serviceChild) => {
  section("E. Persistence rollback and network error mapping");
  // Pause delivery so this scenario owns the exact claim and can inject a
  // transaction failure after a real FastAPI success. The same worker is
  // restarted below to prove the released AiJob retries through production.
  await stopProcess(workerChild);
  const email = candidateEmail("persistence");
  const job = await createActiveJob(
    recruiter,
    [["Persistence Candidate", email, "", "", "Backend", "Node.js", "Persistence fixture"]],
    "Pipeline Persistence"
  );
  const reference = await getReference(job.jobId, email);
  const created = await requestAnalysis(recruiter, job.jobId, reference.id);
  const row = await prisma.aiJob.findUnique({ where: { id: created.aiJob.id } });
  const original = structuredClone(row.result);
  const failingClient = {
    $transaction: async (callback) =>
      prisma.$transaction(async (tx) => {
        const analyses = Object.create(tx.jobCandidateAnalysis);
        Object.defineProperty(analyses, "updateMany", {
          value: async () => {
            throw new Error("INJECTED_CANDIDATE_ANALYSIS_PERSISTENCE_FAILURE");
          },
        });
        const wrapped = Object.create(tx);
        Object.defineProperty(wrapped, "jobCandidateAnalysis", { value: analyses });
        return callback(wrapped);
      }),
  };
  const claim = await aiJobRepository.claimAiJobForProcessing({ aiJobId: row.id, workerId: "persistence-probe" });
  const request = aiJobValidation.buildRequest(claim);
  const accepted = await fetch(`${serviceUrl}/internal/v1/candidate-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_API_KEY}` },
    body: JSON.stringify(request),
  });
  const response = await accepted.json();
  let persistenceError = null;
  try {
    await aiJobRepository.completeCandidateAnalysis({
      aiJobId: row.id,
      workerId: claim.workerId,
      attempts: claim.attempts,
      analysis: response.analysis,
      provider: response.provider,
      model: response.model,
      client: failingClient,
    });
  } catch (error) {
    persistenceError = error;
  }
  const afterFailure = await prisma.aiJob.findUnique({ where: { id: row.id } });
  const analysisAfterFailure = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: row.id } });
  check("FastAPI success is obtained before injected persistence failure", accepted.status === 200 && response.analysis);
  check("candidate-analysis persistence failure is surfaced", persistenceError?.message === "INJECTED_CANDIDATE_ANALYSIS_PERSISTENCE_FAILURE");
  check("persistence failure never falsely marks AiJob COMPLETED", afterFailure.status === "PROCESSING" && jsonEqual(afterFailure.result, original));
  check("persistence failure leaves JobCandidateAnalysis unmaterialized", analysisAfterFailure.result === null && analysisAfterFailure.completedAt === null);
  await aiJobRepository.releaseAiJobForRetry({ aiJobId: row.id, workerId: claim.workerId, attempts: claim.attempts, lastError: "INJECTED_RETRY" });
  startWorker();
  const retried = await waitForAiJob(row.id, "COMPLETED");
  const retriedAnalysis = await waitForAnalysis(row.id);
  check("the same AiJob safely retries after persistence failure", retried.attempts === 2 && retried.lastError === null);
  check("retry persists exactly one authoritative analysis", retriedAnalysis.completedAt instanceof Date && (await prisma.jobCandidateAnalysis.count({ where: { aiJobId: row.id } })) === 1);

  const originalUrl = process.env.AI_SERVICE_URL;
  const originalKey = process.env.AI_SERVICE_API_KEY;
  try {
    process.env.AI_SERVICE_URL = "http://127.0.0.1:1";
    process.env.AI_SERVICE_API_KEY = SERVICE_API_KEY;
    let networkError = null;
    try {
      await aiJobClient.analyzeAiJob(row);
    } catch (error) {
      networkError = error;
    }
    check("network failure maps to AI_PROVIDER_NETWORK_ERROR", networkError?.code === "AI_PROVIDER_NETWORK_ERROR", summarize(networkError?.code));
  } finally {
    process.env.AI_SERVICE_URL = originalUrl;
    process.env.AI_SERVICE_API_KEY = originalKey;
  }
  check("FastAPI and worker child logs contain no API key", !serviceChild.output.includes(SERVICE_API_KEY) && !workerChild.output.includes(SERVICE_API_KEY));
};

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobCandidateReference: await prisma.jobCandidateReference.count(),
  jobCandidateAnalysis: await prisma.jobCandidateAnalysis.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentAttempt: await prisma.jobAssessmentAttempt.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  storedFile: await prisma.storedFile.count(),
  jobCandidateList: await prisma.jobCandidateList.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  subscription: await prisma.subscription.count(),
  subscriptionPlan: await prisma.subscriptionPlan.count(),
});

const removeQueueJobs = async () => {
  const queue = aiJobQueue.getAiJobQueue();
  const states = ["completed", "failed", "delayed", "active", "waiting", "prioritized"];
  const jobs = await queue.getJobs(states, 0, -1);
  let removed = 0;
  for (const job of jobs) {
    await job.remove().catch(() => {});
    removed += 1;
  }
  return removed;
};

const cleanupDatabase = async () => {
  const removed = {};
  const jobIds = tracked.jobIds;
  if (jobIds.length) {
    removed.jobCandidateAnalysis = (
      await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobAssessmentAnswer = (
      await prisma.jobAssessmentAttemptAnswer.deleteMany({ where: { attempt: { jobId: { in: jobIds } } } })
    ).count;
    removed.jobAssessmentAttempt = (
      await prisma.jobAssessmentAttempt.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobAssessmentInvitation = (
      await prisma.jobAssessmentInvitation.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobAssessment = (
      await prisma.jobAssessment.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    Object.assign(removed, await cleanupJobCandidateLists(prisma, jobIds));
    removed.aiJob = (
      await prisma.aiJob.deleteMany({
        where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: jobIds } }] },
      })
    ).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: jobIds } } })).count;
  }
  if (tracked.subscriptionIds.length) {
    removed.subscription = (
      await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } })
    ).count;
  }
  if (tracked.planIds.length) {
    removed.subscriptionPlan = (
      await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } })
    ).count;
  }
  if (tracked.userIds.length) {
    removed.user = (await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } })).count;
  }
  return removed;
};

const countLeftovers = async () => {
  const jobIds = tracked.jobIds;
  const counts = await Promise.all([
    prisma.job.count({ where: { id: { in: jobIds } } }),
    prisma.aiJob.count({ where: { OR: [{ id: { in: tracked.aiJobIds } }, { jobId: { in: jobIds } }] } }),
    prisma.jobCandidateReference.count({ where: { jobId: { in: jobIds } } }),
    prisma.jobCandidateAnalysis.count({ where: { jobId: { in: jobIds } } }),
    prisma.jobAssessment.count({ where: { jobId: { in: jobIds } } }),
    prisma.jobAssessmentAttempt.count({ where: { jobId: { in: jobIds } } }),
    prisma.jobAssessmentInvitation.count({ where: { jobId: { in: jobIds } } }),
    prisma.jobQuotaConsumption.count({ where: { jobId: { in: jobIds } } }),
    prisma.subscription.count({ where: { id: { in: tracked.subscriptionIds } } }),
    prisma.subscriptionPlan.count({ where: { id: { in: tracked.planIds } } }),
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
  ]);
  return counts.reduce((sum, count) => sum + count, 0) + (await countCandidateListLeftovers(prisma, jobIds));
};

const finish = async (before) => {
  section("Cleanup — stopping processes and removing every harness fixture");
  for (const child of children) await stopProcess(child);
  check("all verifier child processes stopped", children.every((child) => child.exitCode !== null || child.signalCode !== null));

  try {
    console.log(`  removed queue records: ${await removeQueueJobs()}`);
  } catch (error) {
    console.error(`  queue cleanup failed: ${error.message}`);
  }
  await aiJobQueue.closeAiJobQueue();

  try {
    console.log(`  deleted rows: ${summarize(await cleanupDatabase())}`);
    check("no harness fixture rows/files remain", (await countLeftovers()) === 0);
  } catch (error) {
    check("no harness fixture rows/files remain", false, error.message);
  }

  const after = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);
  console.log(`platform totals at end:   ${summarize(after)}`);
  check("pre-existing database counts held or grew", Object.keys(before).every((table) => after[table] >= before[table]), summarize({ before, after }));

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED CHECKS:");
    failed.forEach((entry) => console.log(`  - ${entry.label}`));
    process.exitCode = 1;
    return;
  }
  console.log("Candidate-analysis pipeline verified: PostgreSQL → BullMQ → Node worker → FastAPI → PostgreSQL, with job/candidate/version isolation and atomic idempotent persistence.");
};

const run = async () => {
  console.log("Candidate-analysis pipeline verification harness (Phase 7 Step 4)");
  console.log(`run id: ${SUFFIX}`);
  const before = await snapshotTotals();
  let serviceChild = null;
  try {
    serviceChild = await startAiService();
    startWorker();
    const recruiter = await createRecruiter();
    const context = await scenarioHappyPath(recruiter);
    await scenarioVersionsAndDuplicate(recruiter, context);
    await scenarioFailures(recruiter);
    await scenarioStaticAndLegacy();
    await scenarioPersistenceAndNetwork(recruiter, serviceChild);
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
    await aiJobQueue.closeAiJobQueue().catch(() => {});
    await prisma.$disconnect();
  });
