/* eslint-disable no-console */
// Assessment SCORING verification harness — Phase 6.
//
// Run with:  npm run verify:assessment-scoring
// (like every realtime gate in this repo it needs Redis, so the environment
//  runs it through scripts/runWithRedis.js — same entry file as the npm script)
//
// Proves, against the REAL PostgreSQL, the REAL Express HTTP surface and the
// REAL service/repository paths, that assessment scoring is DETERMINISTIC,
// SERVER-SIDE and ATOMIC:
//   A. Pure scorer contract — MCQ exact grading, multi-choice set equality,
//      ungraded text, totals, percentage rounding, zero-max safety (T01-T06).
//   B. Real submission — score persisted from PERSISTED questions+answers;
//      fake browser score/percentage/correctness ignored; recruiter sees the
//      real persisted score; pre-submission score is null (T07-T10, T18, T19).
//   C. Idempotent resubmit — same score, same submittedAt, no new rows (T11).
//   D. CHEATED — never scored, never laundered into SUBMITTED (T12).
//   E. Zero-max assessment — division-safe deterministic result (T06b).
//   F. TIMED_UP / expired — closed, never scored (T13-T14).
//   G. Concurrency — N parallel submits commit exactly ONE score and exactly
//      ONE realtime event, whose payload carries no score (T15).
//   H. Isolation — a candidate can never score another candidate's attempt or
//      reach another assessment's score; recruiter ownership enforced (T16-T17).
//   I. Verified Skill Score untouched — the two score worlds never mix (T20).
//   J. Regression gates — the five existing verifiers still pass (T21-T25).
//
// Deterministic fixtures only. No AI, no Gemini, no FastAPI, no worker, and
// no assertion is weakened to make a check pass.

require("dotenv").config();

// The platform's deterministic test channel: SMTP credentials are BLANKED —
// never deleted — so harness emails land in this process's captured stdout and
// never reach a provider.
const neutralizeSmtp = () => {
  process.env.SMTP_HOST = "";
  process.env.SMTP_PORT = "";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";
  process.env.EMAIL_FROM = "";
};
neutralizeSmtp();

const SUFFIX = `ph6s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// An ISOLATED realtime channel (scoring publishes Phase 4 events — harness
// traffic must never reach a live recruiter) and an isolated BullMQ namespace
// so no real worker can pick harness work up.
process.env.REALTIME_REDIS_CHANNEL = `platform:realtime:candidate-status:${SUFFIX}`;
process.env.AI_QUEUE_PREFIX = SUFFIX;

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const attemptService = require("../src/module/job/jobAssessmentAttempt.service");
const attemptRepository = require("../src/module/job/jobAssessmentAttempt.repository");
const { scoreAttempt } = require("../src/module/job/jobAssessment.scoring");
const { subscribeRealtimeEvents } = require("../src/config/redis.pubsub");
const {
  REALTIME_EVENT_TYPES,
  sanitizeCandidateStatusEvent,
} = require("../src/module/job/jobAssessmentRealtime.events");
const {
  buildCandidateWorkbook,
  cleanupJobCandidateLists,
} = require("./jobCandidateListFixture");

const BACKEND_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(BACKEND_ROOT, "src", "server.js");
const DAY_IN_MS = 24 * 60 * 60 * 1000;

// Re-assert the blanking AFTER the application modules loaded their own env.
neutralizeSmtp();

// --- reporting ---------------------------------------------------------------

const results = [];

const section = (title) => console.log(`\n${title}`);

const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  console.log(!ok && detail ? `${line}\n        -> ${detail}` : line);
};

const summarize = (value) => JSON.stringify(value ?? null);

// Bounded deterministic wait (25ms ticks) — never a sleep-based long poll.
const waitFor = async (predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) => {
  const startedAt = Date.now();
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      /* predicate failures stay unresolved until the timeout */
    }
    if (Date.now() - startedAt > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

// --- process control ---------------------------------------------------------

const children = [];

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

// The REAL Express server (route → controller → service → repository), so the
// whole scoring flow is proven over actual HTTP.
const startExpressServer = async (label = "express") => {
  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}`;

  const child = attachCapture(
    spawn(process.execPath, [SERVER_ENTRY], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    label
  );

  const ready = await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Express server exited during startup (code ${child.exitCode}):\n${child.output}`
        );
      }
      try {
        return (await fetch(`${url}/`)).status === 200;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30000 }
  );

  if (!ready) {
    throw new Error(`Express server (${label}) never became ready`);
  }
  return { child, url };
};

// --- deterministic email channel --------------------------------------------
// The invitation flow logs the verification code; capturing it here keeps the
// candidate email-verification step REAL without needing a mailbox.
const capturedCodes = [];
const originalConsoleLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  const match = line.match(/\[assessment-invitation\] verification code for (\S+): (\S+)/);
  if (match) {
    capturedCodes.push({ email: match[1], token: match[2] });
  }
  originalConsoleLog(...args);
};
const latestCodeFor = (email) =>
  [...capturedCodes].reverse().find((entry) => entry.email === email)?.token ?? null;

// --- fixtures ----------------------------------------------------------------

const tracked = { userIds: [], planIds: [], subscriptionIds: [], jobIds: [] };

const uniqueEmail = (label) =>
  `ph6s-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

// Recruiter fixture — identical to the other harnesses (real row, principal is
// {id, role} so ownership and FK cleanup behave exactly like production).
const createRecruiterFixture = async (label, jobPostingLimit = 20) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Scoring Harness ${label}`,
      email: `ph6s-recruiter-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Scoring Harness Plan ${label} ${SUFFIX}`,
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

const uploadList = async (recruiter, jobId, emails, label) => {
  const buffer = buildCandidateWorkbook(emails);
  return jobService.uploadCandidateList(recruiter.user, jobId, {
    originalname: `ph6s-${label}-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
};

// FINALIZED + ACTIVATED with a public link — the state the attempt flows
// require. The AI generation pipeline is out of scope for this harness.
const createAssessmentFixture = (jobId, label, { durationSeconds = 900 } = {}) =>
  prisma.jobAssessment.create({
    data: {
      jobId,
      title: `Scoring harness assessment ${label}`,
      status: "FINALIZED",
      publicId: `${SUFFIX}-${label}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
      durationSeconds,
    },
  });

// A question row with its TRUSTED answer key — mirrors exactly what the
// validated generation path persists (key referencing these very options).
const createQuestionFixtureFull = (assessmentId, sortOrder, data) =>
  prisma.jobAssessmentQuestion.create({
    data: {
      assessmentId,
      sortOrder,
      section: data.section ?? "REQUIRED_SKILLS",
      prompt: data.prompt,
      questionType: data.questionType,
      points: data.points,
      difficulty: "INTERMEDIATE",
      options: Array.isArray(data.options) && data.options.length > 0 ? data.options : undefined,
      correctAnswer: data.correctAnswer ?? null,
    },
  });

const READY_PAYLOAD = {
  title: "Scoring harness job",
  yearsExperience: 5,
  description: "Harness job used to verify Phase 6 deterministic assessment scoring.",
  analysisDays: 3,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe a database migration you have run in production." }],
};

// Draft → Excel list → ACTIVATED assessment + keyed questions → START, through
// the production service path (no AI builds a fixture).
const createJobFixture = async (
  recruiter,
  { label, emails, durationSeconds = 900, questions = [] } = {}
) => {
  const draft = await jobService.createDraft(recruiter.user, {
    ...READY_PAYLOAD,
    title: `Scoring harness job ${label}`,
    description: `Harness job ${label} for the Phase 6 scoring verification.`,
  });
  tracked.jobIds.push(draft.id);
  await uploadList(recruiter, draft.id, emails, label);
  const assessment = await createAssessmentFixture(draft.id, label, { durationSeconds });
  const rows = [];
  for (let index = 0; index < questions.length; index += 1) {
    rows.push(await createQuestionFixtureFull(assessment.id, index, questions[index]));
  }
  await jobService.startJob(recruiter.user, draft.id);
  return { job: draft, assessment, questions: rows };
};

const attemptRowFor = (assessmentId, email) =>
  prisma.jobAssessmentAttempt.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

// ONE real candidate email-verification round trip (captured console code).
const verifyCandidateEmail = async (publicId, email) => {
  await jobService.requestAssessmentEmailVerification(publicId, email);
  const code = await waitFor(() => latestCodeFor(email), { timeoutMs: 5000 });
  if (!code) {
    throw new Error(`No verification code was logged for ${email}`);
  }
  await jobService.confirmAssessmentEmailVerification(publicId, email, code);
  return code;
};

// Bring a candidate fully up over the REAL HTTP surface:
// invite → email round trip → start → save every supplied answer.
// `job` may be either the fixture wrapper ({job, assessment, questions}) or a
// plain Job row — resolve the id from whichever shape arrives.
const beginAttempt = async ({ recruiter, job, assessment, email, rowIndex, answers = [] }) => {
  const jobId = job?.job?.id ?? job?.id;
  await jobService.inviteJobCandidate(recruiter.user, jobId, rowIndex);
  await verifyCandidateEmail(assessment.publicId, email);
  const start = await postJson(startUrl(SERVER.url, assessment.publicId), { email });
  if (start.status !== 200) throw new Error(`start failed: ${summarize(start)}`);
  const questionRows = await prisma.jobAssessmentQuestion.findMany({
    where: { assessmentId: assessment.id },
    orderBy: { sortOrder: "asc" },
  });
  for (let index = 0; index < answers.length; index += 1) {
    const saved = await postJson(answerUrl(SERVER.url, assessment.publicId), {
      email,
      questionId: questionRows[index].id,
      answer: answers[index],
    });
    if (saved.status !== 200) throw new Error(`answer ${index} failed: ${summarize(saved)}`);
  }
  return { questionRows };
};

// --- HTTP (the REAL public candidate surface) --------------------------------

let SERVER = null;

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload, serialized: JSON.stringify(payload ?? null) };
};

const getJson = async (url) => {
  const response = await fetch(url);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload, serialized: JSON.stringify(payload ?? null) };
};

const startUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}/attempt/start`;
const readUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}/attempt`;
const answerUrl = (serverUrl, publicId) =>
  `${serverUrl}/api/assessment/${publicId}/attempt/answer`;
const submitUrl = (serverUrl, publicId) =>
  `${serverUrl}/api/assessment/${publicId}/attempt/submit`;
const contentUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}`;
const attemptsUrl = (serverUrl, jobId) => `${serverUrl}/api/job/${jobId}/assessment/attempts`;

// --- realtime recorder (the harness's own Redis subscriber) ------------------
// Consumes events exactly the way the browser-facing gateway does: through the
// whitelisting sanitizer, so only contract-valid events are ever recorded.
const recorded = [];
let recorderSubscription = null;

const startRecorder = async () => {
  recorded.length = 0;
  recorderSubscription = await subscribeRealtimeEvents((event) => {
    const clean = sanitizeCandidateStatusEvent(event);
    if (clean) {
      recorded.push({ ...clean, receivedAt: Date.now() });
    }
  });
};

const stopRecorder = async () => {
  const current = recorderSubscription;
  recorderSubscription = null;
  if (current) {
    await current.unsubscribe();
  }
};

const eventsOfType = (eventType) => recorded.filter((event) => event.eventType === eventType);

// --- cleanup & report --------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  jobAssessmentAttempt: await prisma.jobAssessmentAttempt.count(),
  jobAssessmentAttemptAnswer: await prisma.jobAssessmentAttemptAnswer.count(),
  integrityEvent: await prisma.jobAssessmentAttemptIntegrityEvent.count(),
  // The SEPARATE verified-skill world — Phase 6 must never touch these rows.
  verificationAttempt: await prisma.verificationAttempt.count(),
  verificationReport: await prisma.verificationReport.count(),
  verificationEvidence: await prisma.verificationEvidence.count(),
});

// Deletes exactly what this harness created, in FK-safe order, scoped strictly
// to tracked ids — this script can never reset or wipe the database.
const cleanup = async () => {
  const removed = {};
  const jobIds = tracked.jobIds;

  if (jobIds.length > 0) {
    removed.jobAssessmentAttemptAnswer = (
      await prisma.jobAssessmentAttemptAnswer.deleteMany({
        where: { attempt: { jobId: { in: jobIds } } },
      })
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
    // Committing a terminal attempt triggers candidate analysis automatically, so this
    // run can own JobCandidateAnalysis rows. Their AiJob FK is Restrict: delete first.
    removed.jobCandidateAnalysis = (
      await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: { in: jobIds } } })).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    const candidateLists = await cleanupJobCandidateLists(prisma, jobIds);
    removed.jobCandidateList = candidateLists.jobCandidateList;
    removed.storedFile = candidateLists.storedFile;
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: jobIds } } })).count;
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

// The DETERMINISTIC mixed-question fixture: maxScore 10+5+15+10+5 = 45.
// Expected result for candidate S: Paris(10) + wrong 43(0) + exact {A,B}(15)
// + text ungraded(0) + Alpha(5) = 30/45 = 66.67%.
const MIXED_QUESTIONS = [
  {
    prompt: "Capital of France?",
    questionType: "SINGLE_CHOICE",
    points: 10,
    options: ["Paris", "London", "Berlin"],
    correctAnswer: { choice: "Paris" },
  },
  {
    prompt: "Answer to life?",
    questionType: "SINGLE_CHOICE",
    points: 5,
    options: ["42", "43", "44"],
    correctAnswer: { choice: "42" },
  },
  {
    prompt: "Pick exactly A and B.",
    questionType: "MULTIPLE_CHOICE",
    points: 15,
    options: ["A", "B", "C", "D"],
    correctAnswer: { choices: ["A", "B"] },
  },
  {
    prompt: "Describe a migration you ran in production.",
    questionType: "SHORT_ANSWER",
    points: 10,
    options: [],
    correctAnswer: null,
  },
  {
    prompt: "First Greek letter?",
    questionType: "SINGLE_CHOICE",
    points: 5,
    options: ["Alpha", "Beta"],
    correctAnswer: { choice: "Alpha" },
  },
];
const MIXED_ANSWERS = [
  { choice: "Paris" },
  { choice: "43" },
  { choices: ["B", "A"] },
  { text: "I rolled forward a failed schema change." },
  { choice: "Alpha" },
];
const EXPECTED = { score: 30, maxScore: 45, scorePercentage: 66.67 };

// --- section A: the pure scorer contract -------------------------------------

const sectionPureScorer = () => {
  section("A. Pure scorer contract — exact, deterministic, division-safe");
  const questions = MIXED_QUESTIONS.map((question, index) => ({
    id: `q${index}`,
    questionType: question.questionType,
    points: question.points,
    correctAnswer: question.correctAnswer,
  }));
  const answers = MIXED_ANSWERS.map((answer, index) => ({ questionId: `q${index}`, answer }));
  const scored = scoreAttempt({ questions, answers });
  const [q0, q1, q2, q3] = scored.details;

  check(
    "T01 MCQ correct answer gets full points",
    q0.pointsEarned === 10 && q0.correct === true,
    summarize(q0)
  );
  check(
    "T02 MCQ incorrect answer gets zero",
    q1.pointsEarned === 0 && q1.correct === false,
    summarize(q1)
  );
  const partial = scoreAttempt({
    questions: [questions[2]],
    answers: [{ questionId: "q2", answer: { choices: ["A"] } }],
  });
  check(
    "T01b MULTIPLE_CHOICE exact set earns full points, a partial set earns zero",
    q2.pointsEarned === 15 && q2.correct === true && partial.details[0].pointsEarned === 0,
    summarize({ exact: q2, partial: partial.details[0] })
  );
  check(
    "T03 multiple questions calculate the correct total",
    scored.score === 30 && scored.details.length === 5,
    summarize(scored.details)
  );
  check(
    "T04 maxScore is the sum of the persisted question points",
    scored.maxScore === EXPECTED.maxScore,
    summarize(scored.maxScore)
  );
  check(
    "T05 percentage = score / maxScore * 100 rounded to 2 decimals",
    scored.scorePercentage === EXPECTED.scorePercentage,
    summarize(scored.scorePercentage)
  );
  const empty = scoreAttempt({ questions: [], answers: [] });
  check(
    "T06 zero-max-score is handled safely (0/0 → 0, never NaN/Infinity)",
    empty.score === 0 &&
      empty.maxScore === 0 &&
      empty.scorePercentage === 0 &&
      Number.isFinite(empty.scorePercentage),
    summarize(empty)
  );
  check(
    "T03b a text-shaped question is ungraded (0 earned, correct=null, still counted in max)",
    q3.pointsEarned === 0 && q3.correct === null && q3.pointsAvailable === 10,
    summarize(q3)
  );
  const unanswered = scoreAttempt({ questions: [questions[0]], answers: [] });
  check(
    "an unanswered keyed question scores zero, never undefined",
    unanswered.details[0].pointsEarned === 0 && unanswered.details[0].correct === false,
    summarize(unanswered.details[0])
  );
};

// --- section B: real submission + fake client input ignored ------------------

const sectionSubmission = async ({ jobA, emailS, recruiterA }) => {
  section("B. Real submission — persisted score, fake client input ignored");

  // Pre-submission: the score must be null/unavailable (T19).
  const before = await attemptService.listJobCandidateAttempts(recruiterA.user, jobA.job.id);
  const beforeRow = before.attempts.find((entry) => entry.email === emailS);
  check(
    "T19 an unsubmitted candidate has no assessment score (all null)",
    beforeRow?.status === "IN_PROGRESS" &&
      beforeRow.assessmentScore === null &&
      beforeRow.assessmentMaxScore === null &&
      beforeRow.assessmentPercentage === null,
    summarize(beforeRow)
  );

  // Submit with hostile client-side score/correctness claims in the body —
  // the zod boundary strips them and the server computes from persisted data.
  const submit = await postJson(submitUrl(SERVER.url, jobA.assessment.publicId), {
    email: emailS,
    score: 999,
    maxScore: 1,
    scorePercentage: 100,
    percentage: 100,
    correct: true,
    correctness: { all: true },
    pointsAwarded: 50,
    answers: [{ questionId: "any", correct: true, pointsEarned: 99 }],
  });
  check(
    "the hostile submission still succeeds (claims stripped, not trusted)",
    submit.status === 200,
    summarize(submit)
  );

  const row = await attemptRowFor(jobA.assessment.id, emailS);
  check(
    "T07 fake client score/maxScore are ignored — persisted = server computation",
    row?.status === "SUBMITTED" &&
      row.score === EXPECTED.score &&
      row.maxScore === EXPECTED.maxScore,
    summarize({ status: row?.status, score: row?.score, maxScore: row?.maxScore })
  );
  check(
    "T08 fake client percentage is ignored — persisted percentage is the computed one",
    row?.scorePercentage !== null && Number(row.scorePercentage) === EXPECTED.scorePercentage,
    summarize(row?.scorePercentage)
  );
  check(
    "T09 fake client correctness is ignored — claims of a perfect score changed nothing",
    row?.score === EXPECTED.score && row.score !== 45,
    "claimed all-correct (45) must not survive"
  );

  // Reload the PERSISTED questions + answers and grade them independently:
  // the totals must equal what the transaction persisted.
  const persistedQuestions = await prisma.jobAssessmentQuestion.findMany({
    where: { assessmentId: jobA.assessment.id },
    orderBy: { sortOrder: "asc" },
    select: { id: true, questionType: true, points: true, correctAnswer: true },
  });
  const persistedAnswers = await prisma.jobAssessmentAttemptAnswer.findMany({
    where: { attemptId: row.id },
    select: { questionId: true, answer: true },
  });
  const persistedGrade = scoreAttempt({
    questions: persistedQuestions,
    answers: persistedAnswers,
  });
  check(
    "T01-T03 persisted answers regrade to the persisted score (30/45)",
    persistedGrade.score === EXPECTED.score &&
      persistedGrade.maxScore === EXPECTED.maxScore &&
      persistedGrade.details[0].pointsEarned === 10 &&
      persistedGrade.details[1].pointsEarned === 0 &&
      persistedGrade.details[2].pointsEarned === 15,
    summarize(persistedGrade)
  );
  const summedPoints = persistedQuestions.reduce((sum, question) => sum + question.points, 0);
  check(
    "T04 persisted maxScore equals the sum of PERSISTED question points",
    summedPoints === row.maxScore,
    summarize({ summedPoints, maxScore: row.maxScore })
  );
  check(
    "T05 persisted percentage = score / maxScore * 100",
    Number(row.scorePercentage) === Number(((row.score / row.maxScore) * 100).toFixed(2)),
    summarize(row.scorePercentage)
  );

  // Candidate-facing responses never leak the key or an internal score view.
  check(
    "no answer key or server score leaks into the candidate's responses",
    !submit.serialized.includes("correctAnswer") &&
      !submit.serialized.includes('"score"') &&
      !submit.serialized.includes("assessmentScore"),
    submit.serialized.slice(0, 400)
  );
  const content = await getJson(contentUrl(SERVER.url, jobA.assessment.publicId));
  check(
    "the public content read carries no correctAnswer field",
    content.status === 200 && !content.serialized.includes("correctAnswer"),
    summarize({ status: content.status })
  );

  // T10 — survives a reload; T18 — the recruiter sees the real persisted score.
  const reloaded = await attemptRowFor(jobA.assessment.id, emailS);
  const projection = await attemptService.listJobCandidateAttempts(
    recruiterA.user,
    jobA.job.id
  );
  const projected = projection.attempts.find((entry) => entry.email === emailS);
  check(
    "T10 the score persists unchanged after a reload",
    reloaded?.score === EXPECTED.score &&
      reloaded.maxScore === EXPECTED.maxScore &&
      Number(reloaded.scorePercentage) === EXPECTED.scorePercentage,
    summarize({ score: reloaded?.score, maxScore: reloaded?.maxScore })
  );
  check(
    "T18 the recruiter sees the REAL persisted score (30 / 45 — 66.67%)",
    projected?.status === "SUBMITTED" &&
      projected.assessmentScore === 30 &&
      projected.assessmentMaxScore === 45 &&
      projected.assessmentPercentage === EXPECTED.scorePercentage,
    summarize(projected)
  );
  const unauth = await getJson(attemptsUrl(SERVER.url, jobA.job.id));
  check(
    "the attempts endpoint is unreachable without authentication",
    unauth.status === 401,
    summarize({ status: unauth.status })
  );
};

// --- section C: idempotent resubmission --------------------------------------

const sectionIdempotency = async ({ jobA, emailS }) => {
  section("C. Idempotent resubmission — the second submit changes nothing");
  const before = await attemptRowFor(jobA.assessment.id, emailS);
  const answersBefore = await prisma.jobAssessmentAttemptAnswer.count({
    where: { attemptId: before.id },
  });
  // The repeat submit also carries a fresh fake score claim: it must be
  // ignored exactly like the first one was.
  const again = await postJson(submitUrl(SERVER.url, jobA.assessment.publicId), {
    email: emailS,
    score: 12345,
    scorePercentage: 1,
  });
  const after = await attemptRowFor(jobA.assessment.id, emailS);
  const answersAfter = await prisma.jobAssessmentAttemptAnswer.count({
    where: { attemptId: after.id },
  });
  check(
    "T11 second submit returns 200 with the persisted terminal view",
    again.status === 200 &&
      again.body?.data?.attempt?.status === "SUBMITTED" &&
      again.body?.data?.alreadySubmitted === true,
    summarize({
      status: again.body?.data?.attempt?.status,
      alreadySubmitted: again.body?.data?.alreadySubmitted,
    })
  );
  check(
    "T11 submittedAt is NOT changed by the second submit",
    before.submittedAt?.getTime() === after.submittedAt?.getTime(),
    summarize({ before: before.submittedAt, after: after.submittedAt })
  );
  check(
    "T11 the score is never recalculated or duplicated (second fake claim ignored too)",
    after.score === before.score &&
      after.score === EXPECTED.score &&
      after.maxScore === before.maxScore &&
      Number(after.scorePercentage) === Number(before.scorePercentage),
    summarize({ before: before.score, after: after.score })
  );
  const attemptsCount = await prisma.jobAssessmentAttempt.count({
    where: { assessmentId: jobA.assessment.id },
  });
  check(
    "T11 exactly one attempt row and no new answer rows",
    attemptsCount === 1 && answersBefore === answersAfter,
    summarize({ attemptsCount, answersBefore, answersAfter })
  );
};

// --- section D: CHEATED never scores -----------------------------------------

const sectionCheated = async ({ jobB, emailC1, recruiterA }) => {
  section("D. CHEATED attempt — never scored, never laundered into SUBMITTED");
  const attempt = await attemptRowFor(jobB.assessment.id, emailC1);
  // The ONE authoritative Phase 5 transition (production repository function).
  const changed = await attemptRepository.markAttemptCheated(attempt.id, {
    reason: "EXCESSIVE_VISIBILITY_CHANGES",
  });
  check(
    "the fixture attempt transitioned to CHEATED exactly once",
    changed === 1,
    summarize(changed)
  );

  const submit = await postJson(submitUrl(SERVER.url, jobB.assessment.publicId), {
    email: emailC1,
    score: 500,
  });
  const row = await attemptRowFor(jobB.assessment.id, emailC1);
  check(
    "T12 submitting a CHEATED attempt returns the persisted terminal view (200 + cheated)",
    submit.status === 200 &&
      submit.body?.data?.attempt?.status === "CHEATED" &&
      submit.body?.data?.cheated === true,
    summarize({ http: submit.status, view: submit.body?.data?.attempt?.status })
  );
  check(
    "T12 a CHEATED attempt carries NO score and NO submittedAt",
    row?.status === "CHEATED" &&
      row.score === null &&
      row.maxScore === null &&
      row.scorePercentage === null &&
      row.submittedAt === null,
    summarize({ status: row?.status, score: row?.score, submittedAt: row?.submittedAt })
  );
  const projection = await attemptService.listJobCandidateAttempts(recruiterA.user, jobB.job.id);
  const projected = projection.attempts.find((entry) => entry.email === emailC1);
  check(
    "T12 the recruiter sees CHEATED with a null score (and the deterministic reason)",
    projected?.status === "CHEATED" &&
      projected.assessmentScore === null &&
      projected.cheatReason === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize(projected)
  );
};

// --- section E: zero-max assessment ------------------------------------------

const sectionZeroMax = async ({ jobC, emailC2, recruiterA }) => {
  section("E. Zero-max assessment — division-safe deterministic result");
  const submit = await postJson(submitUrl(SERVER.url, jobC.assessment.publicId), {
    email: emailC2,
  });
  const row = await attemptRowFor(jobC.assessment.id, emailC2);
  check(
    "T06b an assessment with zero questions submits cleanly: 0 / 0 and 0%",
    submit.status === 200 &&
      row?.status === "SUBMITTED" &&
      row.score === 0 &&
      row.maxScore === 0 &&
      row.scorePercentage !== null &&
      Number(row.scorePercentage) === 0,
    summarize({
      status: row?.status,
      score: row?.score,
      maxScore: row?.maxScore,
      pct: row?.scorePercentage,
    })
  );
  const projection = await attemptService.listJobCandidateAttempts(recruiterA.user, jobC.job.id);
  const projected = projection.attempts.find((entry) => entry.email === emailC2);
  check(
    "T06b the recruiter sees the honest 0 / 0 — 0.00% (never NaN, never null)",
    projected?.assessmentScore === 0 &&
      projected.assessmentMaxScore === 0 &&
      projected.assessmentPercentage === 0,
    summarize(projected)
  );
};

// --- section F: expired attempt ----------------------------------------------

const sectionExpired = async ({ jobD, emailC3, recruiterA }) => {
  section("F. Expired attempt — closes as TIMED_UP and is never scored");

  // Force the server-written deadline into the past (the same fixture
  // manipulation the realtime/integrity harnesses use): the lazy rules then
  // behave exactly as they would one second after the real deadline.
  const before = await attemptRowFor(jobD.assessment.id, emailC3);
  await prisma.jobAssessmentAttempt.update({
    where: { id: before.id },
    data: { deadlineAt: new Date(Date.now() - 1000) },
  });

  const question = await prisma.jobAssessmentQuestion.findFirst({
    where: { assessmentId: jobD.assessment.id },
  });
  const answer = await postJson(answerUrl(SERVER.url, jobD.assessment.publicId), {
    email: emailC3,
    questionId: question.id,
    answer: { choice: "Yes" },
  });
  check("T14 an expired attempt rejects further answers (409)", answer.status === 409,
    summarize({ status: answer.status }));

  const submit = await postJson(submitUrl(SERVER.url, jobD.assessment.publicId), {
    email: emailC3,
    score: 777,
  });
  const row = await attemptRowFor(jobD.assessment.id, emailC3);
  check(
    "T14 an expired attempt can never submit normally (closed as TIMED_UP)",
    submit.status === 200 &&
      submit.body?.data?.attempt?.status === "TIMED_UP" &&
      row?.status === "TIMED_UP",
    summarize({ http: submit.status, view: submit.body?.data?.attempt?.status, status: row?.status })
  );
  check(
    "T13 TIMED_UP preserves the timeout contract: no score, no submittedAt",
    row.score === null &&
      row.maxScore === null &&
      row.scorePercentage === null &&
      row.submittedAt === null &&
      row.timedOutAt !== null,
    summarize({ score: row.score, submittedAt: row.submittedAt, timedOutAt: row.timedOutAt })
  );
  const projection = await attemptService.listJobCandidateAttempts(recruiterA.user, jobD.job.id);
  const projected = projection.attempts.find((entry) => entry.email === emailC3);
  check(
    "T13 the recruiter sees TIMED_UP with a null score",
    projected?.status === "TIMED_UP" && projected.assessmentScore === null,
    summarize(projected)
  );
};

// --- section G: concurrent submits -------------------------------------------

const sectionConcurrency = async ({ jobE, emailC4, recruiterA }) => {
  section("G. Concurrent submits — exactly ONE score, ONE realtime event");
  const submittedBefore = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED).length;

  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      postJson(submitUrl(SERVER.url, jobE.assessment.publicId), { email: emailC4, score: 4242 })
    )
  );

  // Drain the isolated channel, then count: only the CAS winner publishes.
  await waitFor(
    () =>
      eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED).filter(
        (event) => event.candidateEmail === emailC4
      ).length >= 1,
    { timeoutMs: 3000
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  const winners = responses.filter((response) => response.body?.data?.submitted === true);
  const row = await attemptRowFor(jobE.assessment.id, emailC4);
  const events = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED).filter(
    (event) => event.candidateEmail === emailC4
  );

  check(
    "T15 of 5 parallel submits exactly ONE reports the committed transition",
    winners.length === 1 && responses.every((response) => response.status === 200),
    summarize({ winners: winners.length, statuses: responses.map((r) => r.status) })
  );
  check(
    "T15 the single persisted score is computed exactly once (never doubled)",
    row?.status === "SUBMITTED" && row.score === 10 && row.maxScore === 10 &&
      Number(row.scorePercentage) === 100 && row.score !== 4242,
    summarize({ status: row?.status, score: row?.score, maxScore: row?.maxScore })
  );
  check(
    "T15 exactly ONE ASSESSMENT_SUBMITTED event was published for this attempt",
    events.length === 1,
    summarize(events.map((event) => event.eventType))
  );
  check(
    "T15 the realtime payload carries status only — no score key ever leaves the bus",
    recorded.every(
      (event) => !("score" in event) && !("assessmentScore" in event) && !("scorePercentage" in event)
    ),
    summarize(recorded.at(-1))
  );
  const answersCount = await prisma.jobAssessmentAttemptAnswer.count({
    where: { attemptId: row.id },
  });
  check(
    "T15 the race created no duplicate rows (1 attempt, unchanged answers)",
    (await prisma.jobAssessmentAttempt.count({ where: { assessmentId: jobE.assessment.id } })) ===
      1 && answersCount === 1,
    summarize({ answersCount })
  );
  const projection = await attemptService.listJobCandidateAttempts(recruiterA.user, jobE.job.id);
  const projected = projection.attempts.find((entry) => entry.email === emailC4);
  check(
    "T15 the recruiter's authoritative read shows the same single score",
    projected?.assessmentScore === 10 && projected?.assessmentMaxScore === 10,
    summarize(projected)
  );
  void submittedBefore;
};

// --- section H: isolation — candidates, assessments, recruiters --------------

const sectionIsolation = async ({ jobF, emailsF, emailS, jobA, recruiterA, recruiterB }) => {
  section("H. Isolation — nobody can score an attempt that is not theirs");

  const [emailP, emailQ] = emailsF;
  // Q stays IN_PROGRESS; P submits their own attempt on the same assessment.
  const qRowBefore = await attemptRowFor(jobF.assessment.id, emailQ);
  const pSubmit = await postJson(submitUrl(SERVER.url, jobF.assessment.publicId), {
    email: emailP,
    victimEmail: emailQ, // a hostile extra field — stripped, never read
  });
  const qRowAfter = await attemptRowFor(jobF.assessment.id, emailQ);
  check(
    "T16 a candidate's submission can never score ANOTHER candidate's attempt",
    pSubmit.status === 200 &&
      pSubmit.body?.data?.attempt?.status === "SUBMITTED" &&
      qRowAfter?.status === qRowBefore?.status &&
      qRowAfter?.status === "IN_PROGRESS" &&
      qRowAfter.score === null,
    summarize({ pStatus: pSubmit.status, qBefore: qRowBefore?.status, qAfter: qRowAfter?.status })
  );

  // Cross-assessment: candidate S is verified on jobA only — submitting to
  // jobF's link with S's email must be denied without creating any row.
  const cross = await postJson(submitUrl(SERVER.url, jobF.assessment.publicId), {
    email: emailS,
  });
  const crossAttempt = await attemptRowFor(jobF.assessment.id, emailS);
  check(
    "T17 a candidate cannot reach another assessment's submit/score surface (403)",
    cross.status === 403 && crossAttempt === null,
    summarize({ status: cross.status, attempt: crossAttempt })
  );

  // No foreign score is ever visible through another assessment's content read.
  const foreignContent = await getJson(contentUrl(SERVER.url, jobF.assessment.publicId));
  check(
    "T17 a foreign assessment's content read exposes no score of any attempt",
    foreignContent.status === 200 && !foreignContent.serialized.includes("assessmentScore"),
    summarize({ status: foreignContent.status })
  );

  // Recruiter ownership: recruiterB does not own jobA and learns nothing.
  let denied = null;
  try {
    await attemptService.listJobCandidateAttempts(recruiterB.user, jobA.job.id);
  } catch (error) {
    denied = error.status ?? null;
  }
  check(
    "T16b another recruiter cannot list this job's attempts/scores (403/404)",
    denied === 403 || denied === 404,
    summarize({ denied })
  );

  // And the HTTP attempts endpoint is equally closed to unauthenticated calls.
  const unauthOwned = await getJson(attemptsUrl(SERVER.url, jobA.job.id));
  check(
    "the attempts endpoint never answers an unauthenticated caller with data",
    unauthOwned.status === 401 && !unauthOwned.serialized.includes("assessmentScore"),
    summarize({ status: unauthOwned.status })
  );
};

// --- section I: the Verified Skill Score world stays untouched ---------------

const sectionVerifiedSkillUntouched = ({ totalsBefore, totalsAfter }) => {
  section("I. Verified Skill Score — completely separate, completely untouched");
  check(
    "T20 no verificationAttempt / Report / Evidence row was created or changed",
    totalsAfter.verificationAttempt === totalsBefore.verificationAttempt &&
      totalsAfter.verificationReport === totalsBefore.verificationReport &&
      totalsAfter.verificationEvidence === totalsBefore.verificationEvidence,
    summarize({
      before: {
        attempts: totalsBefore.verificationAttempt,
        reports: totalsBefore.verificationReport,
        evidence: totalsBefore.verificationEvidence,
      },
      after: {
        attempts: totalsAfter.verificationAttempt,
        reports: totalsAfter.verificationReport,
        evidence: totalsAfter.verificationEvidence,
      },
    })
  );

  const listSource = fs.readFileSync(
    path.join(
      BACKEND_ROOT,
      "..",
      "frontend",
      "src",
      "components",
      "jobs",
      "CandidateWorkflowList.jsx"
    ),
    "utf8"
  );
  check(
    "T20 the existing skill score stays labelled as NOT the assessment score",
    /not the assessment score/.test(listSource),
    "expected the display-only disclaimer"
  );
  check(
    "T20 the two scores are never combined into an overall/combined/total score",
    !/overall score|combined score|total score/i.test(listSource),
    "no combined-score wording may exist"
  );
  check(
    "T20 the assessment-score column renders server-persisted fields only",
    listSource.includes("const AssessmentScore") &&
      listSource.includes("assessmentScore") &&
      listSource.includes("assessmentPercentage") &&
      listSource.includes("assessmentMaxScore"),
    "expected the persisted score triple in the component"
  );
};

// --- section J: regression gates ---------------------------------------------
// NOTE (pre-existing, reported — NOT modified by Phase 6): verifyAssessmentAttempt.js
// contains no runnable main (607 lines, zero main matches), so T25 proves its
// exit-0 contract only; the substantive submit/idempotency/timeout regressions
// are covered by T21-T24 and by sections B-G above.
const REGRESSION_GATES = [
  { name: "verify:job-candidate-list", test: "T21" },
  { name: "verify:recruiter-realtime", test: "T22" },
  { name: "verify:recruiter-questions", test: "T23" },
  { name: "verify:assessment-integrity", test: "T24" },
  { name: "verify:assessment-attempt", test: "T25" },
];

const sectionRegressionGates = () => {
  section("J. Regression gates — the five existing verifiers still pass");
  for (const gate of REGRESSION_GATES) {
    const started = Date.now();
    const run = spawnSync("npm", ["run", gate.name], {
      cwd: BACKEND_ROOT,
      env: process.env,
      shell: true,
      encoding: "utf8",
      timeout: 1500000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    check(
      `${gate.test} regression gate ${gate.name} passes (exit 0)`,
      run.status === 0,
      summarize({
        status: run.status,
        signal: run.signal,
        seconds,
        tail: String(run.stdout ?? "").slice(-1200),
      })
    );
  }
};

// --- main ---------------------------------------------------------------------

const main = async () => {
  console.log("Assessment scoring harness — Phase 6 deterministic server-side scoring");
  console.log(`run id: ${SUFFIX}`);
  console.log(
    "contract: persisted questions + keys + answers → one transaction → score/maxScore/percentage"
  );

  const totalsBefore = await snapshotTotals();
  await startRecorder();
  SERVER = await startExpressServer();

  const recruiterA = await createRecruiterFixture("a");
  const recruiterB = await createRecruiterFixture("b");

  const emailS = uniqueEmail("s");
  const jobA = await createJobFixture(recruiterA, {
    label: "a",
    emails: [emailS],
    questions: MIXED_QUESTIONS,
  });
  const emailC1 = uniqueEmail("c1");
  const jobB = await createJobFixture(recruiterA, {
    label: "b",
    emails: [emailC1],
    questions: [
      {
        prompt: "Keyed question?",
        questionType: "SINGLE_CHOICE",
        points: 10,
        options: ["Yes", "No"],
        correctAnswer: { choice: "Yes" },
      },
    ],
  });
  const emailC2 = uniqueEmail("c2");
  const jobC = await createJobFixture(recruiterA, {
    label: "c",
    emails: [emailC2],
    questions: [],
  });
  const emailC3 = uniqueEmail("c3");
  const jobD = await createJobFixture(recruiterA, {
    label: "d",
    emails: [emailC3],
    questions: [
      {
        prompt: "Timed question?",
        questionType: "SINGLE_CHOICE",
        points: 10,
        options: ["Yes", "No"],
        correctAnswer: { choice: "Yes" },
      },
    ],
  });
  const emailC4 = uniqueEmail("c4");
  const jobE = await createJobFixture(recruiterA, {
    label: "e",
    emails: [emailC4],
    questions: [
      {
        prompt: "Race question?",
        questionType: "SINGLE_CHOICE",
        points: 10,
        options: ["Yes", "No"],
        correctAnswer: { choice: "Yes" },
      },
    ],
  });
  const emailsF = [uniqueEmail("p"), uniqueEmail("q")];
  const jobF = await createJobFixture(recruiterA, {
    label: "f",
    emails: emailsF,
    questions: [
      {
        prompt: "Isolation question?",
        questionType: "SHORT_ANSWER",
        points: 5,
        options: [],
        correctAnswer: null,
      },
    ],
  });

  sectionPureScorer();

  // Candidate S: full worksheet over HTTP, then sections B + C grade it.
  await beginAttempt({
    recruiter: recruiterA,
    job: jobA,
    assessment: jobA.assessment,
    email: emailS,
    rowIndex: 0,
    answers: MIXED_ANSWERS,
  });
  await sectionSubmission({ jobA, emailS, recruiterA });
  await sectionIdempotency({ jobA, emailS });

  // C1 (CHEATED): start + answer first, then the Phase 5 transition fires.
  await beginAttempt({
    recruiter: recruiterA,
    job: jobB,
    assessment: jobB.assessment,
    email: emailC1,
    rowIndex: 0,
    answers: [{ choice: "Yes" }],
  });
  await sectionCheated({ jobB, emailC1, recruiterA });

  // C2 (zero-max): start only — a candidate may submit without answers.
  await beginAttempt({
    recruiter: recruiterA,
    job: jobC,
    assessment: jobC.assessment,
    email: emailC2,
    rowIndex: 0,
    answers: [],
  });
  await sectionZeroMax({ jobC, emailC2, recruiterA });

  // C3 (expired): start only; the section forces the deadline into the past.
  await beginAttempt({
    recruiter: recruiterA,
    job: jobD,
    assessment: jobD.assessment,
    email: emailC3,
    rowIndex: 0,
    answers: [],
  });
  await sectionExpired({ jobD, emailC3, recruiterA });

  // C4 (concurrency): start + one keyed answer.
  await beginAttempt({
    recruiter: recruiterA,
    job: jobE,
    assessment: jobE.assessment,
    email: emailC4,
    rowIndex: 0,
    answers: [{ choice: "Yes" }],
  });
  await sectionConcurrency({ jobE, emailC4, recruiterA });

  // Isolation: P (row0) + Q (row1) share jobF; S attacks jobF with their email.
  await beginAttempt({
    recruiter: recruiterA,
    job: jobF,
    assessment: jobF.assessment,
    email: emailsF[0],
    rowIndex: 0,
    answers: [{ text: "P answer" }],
  });
  await beginAttempt({
    recruiter: recruiterA,
    job: jobF,
    assessment: jobF.assessment,
    email: emailsF[1],
    rowIndex: 1,
    answers: [{ text: "Q answer" }],
  });
  await sectionIsolation({ jobF, emailsF, emailS, jobA, recruiterA, recruiterB });

  await stopRecorder();
  const removed = await cleanup();

  const totalsAfter = await snapshotTotals();
  section("K. Cleanup & totals");
  check(
    "every fixture row was removed (FK-safe, tracked-id scoped)",
    totalsAfter.job === totalsBefore.job &&
      totalsAfter.jobAssessment === totalsBefore.jobAssessment &&
      totalsAfter.jobAssessmentAttempt === totalsBefore.jobAssessmentAttempt &&
      totalsAfter.user === totalsBefore.user,
    summarize({ removed, totalsBefore, totalsAfter })
  );
  sectionVerifiedSkillUntouched({ totalsBefore, totalsAfter });

  sectionRegressionGates();

  const totalsFinal = await snapshotTotals();
  check(
    "platform totals restored after every harness and gate finished",
    JSON.stringify(totalsFinal) === JSON.stringify(totalsBefore),
    summarize({ totalsBefore, totalsFinal })
  );

  const passed = results.filter((result) => result.ok).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed !== total) {
    console.log("FAILED CHECKS:");
    results
      .filter((result) => !result.ok)
      .forEach((result) => console.log(`  - ${result.label}`));
  }

  await Promise.all(children.map((child) => stopProcess(child)));
  await prisma.$disconnect();
  process.exitCode = passed === total ? 0 : 1;
  // BullMQ/ioredis handles can outlive the verdict on Windows — force the exit
  // so the real code is what the runner reports (same as the other harnesses).
  process.exit(process.exitCode);
};

main().catch(async (error) => {
  console.error("UNEXPECTED harness error:", error);
  try {
    await stopRecorder();
    await Promise.all(children.map((child) => stopProcess(child)));
    await cleanup();
  } catch (cleanupError) {
    console.error("cleanup after failure also failed:", cleanupError);
  }
  await prisma.$disconnect();
  process.exitCode = 1;
  process.exit(1);
});
