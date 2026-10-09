/* eslint-disable no-console */
// Assessment attempt verification harness — Phase 3 lifecycle regression.
//
// Run with:  npm run verify:assessment-attempt
//
// Proves, against the REAL PostgreSQL, the REAL Express HTTP surface and the
// REAL service paths, the frozen Phase 3 contract:
//   A. Activation gate — a non-activated assessment exposes no content and no
//      attempt surface.
//   B. Candidate authorization — only a persisted EMAIL_VERIFIED invitation for
//      THIS assessment can touch the attempt lifecycle.
//   C. Start + server-authoritative timer — startedAt/deadlineAt are written
//      once from the server clock; client-supplied timer/status fields are
//      ignored; Start is idempotent (one attempt per assessment+email).
//   D. Answers — first answer moves STARTED → IN_PROGRESS; questions can never
//      cross assessment boundaries; payloads are validated per question type.
//   E. Refresh/resume — a re-read returns the SAME persisted attempt, timer and
//      answers; nothing is reset and no secret ever leaves the server.
//   F. Submit — terminal, idempotent, and never resurrectable by answer/start.
//   G. Timeout — the persisted deadline wins lazily: TIMED_UP persists and can
//      never become SUBMITTED.
//   H. Recruiter status projection — status only, ownership enforced, no
//      answers/tokens, CHEATED columns available but null for clean attempts.
//   I. One-attempt uniqueness — exactly one row per (assessment, email).
//   J. No side effects — no AiJob, no quota, no integrity events, no score
//      keys anywhere in the attempt flow.
//   K. Restart persistence — an Express restart changes nothing (PostgreSQL is
//      the only authority).
//   L. Cleanup — every fixture row/file removed; platform totals restored.
//
// Convention follows scripts/verifyRecruiterRealtime.js (CommonJS, the
// application's own Prisma client, throwaway fixtures tracked by id and
// deleted in FK-safe order, deterministic server-log email channel, isolated
// Redis channel + queue prefix).

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

const SUFFIX = `ph3a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// An ISOLATED realtime channel (attempt transitions publish Phase 4 events —
// harness traffic must never reach a live recruiter) and an isolated BullMQ
// namespace so no real worker can pick harness work up.
process.env.REALTIME_REDIS_CHANNEL = `platform:realtime:candidate-status:${SUFFIX}`;
process.env.AI_QUEUE_PREFIX = SUFFIX;

const assert = require("node:assert/strict");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const attemptService = require("../src/module/job/jobAssessmentAttempt.service");
const {
  buildCandidateWorkbook,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
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

// Collects every object key in a JSON structure so a response can be scanned
// for data that must NEVER leave the server.
const collectKeys = (value, keys = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
};

const FORBIDDEN_SUBSTRINGS = [
  "verificationTokenHash",
  "tokenHash",
  "verificationToken",
  "passwordHash",
  "accessToken",
  "REDIS_URL",
  "AI_SERVICE_API_KEY",
  "GEMINI_API_KEY",
];

const leaksOf = (serialized) =>
  FORBIDDEN_SUBSTRINGS.filter((needle) => String(serialized ?? "").includes(needle));


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
// whole attempt lifecycle is proven over actual HTTP.
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

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
};

const createRecruiterFixture = async (label, jobPostingLimit = 20) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Attempt Harness ${label}`,
      email: `ph3a-harness-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Attempt Harness Plan ${label} ${SUFFIX}`,
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
    originalname: `ph3a-${label}-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
};

// FINALIZED with a public link; ACTIVATED only when the caller asks for it.
// The AI generation pipeline is out of scope for this harness.
const createAssessmentFixture = (jobId, label, { durationSeconds = 900, activated = true } = {}) =>
  prisma.jobAssessment.create({
    data: {
      jobId,
      title: `Attempt harness assessment ${label}`,
      status: "FINALIZED",
      publicId: `${SUFFIX}-${label}`,
      finalizedAt: new Date(),
      activatedAt: activated ? new Date() : null,
      durationSeconds,
    },
  });

const createQuestionFixture = (assessmentId, sortOrder, data) =>
  prisma.jobAssessmentQuestion.create({
    data: {
      assessmentId,
      sortOrder,
      prompt: data.prompt,
      questionType: data.questionType,
      section: data.section,
      points: 5,
      options: data.options ?? undefined,
    },
  });

const READY_PAYLOAD = {
  title: "Attempt harness job",
  yearsExperience: 5,
  description: "Harness job used to verify the persistent assessment attempt lifecycle.",
  analysisDays: 3,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe a database migration you have run in production." }],
};

// Draft → Excel list → assessment → START, through the production service path.
const createJobFixture = async (
  recruiter,
  { label, emails, activated = true, durationSeconds = 900, questionCount = 1 } = {}
) => {
  const draft = await jobService.createDraft(recruiter.user, {
    ...READY_PAYLOAD,
    title: `Attempt harness job ${label}`,
    description: `Harness job ${label} for the attempt lifecycle verification.`,
  });
  tracked.jobIds.push(draft.id);

  await uploadList(recruiter, draft.id, emails, label);

  const assessment = await createAssessmentFixture(draft.id, label, { durationSeconds, activated });
  const questions = await Promise.all(
    Array.from({ length: questionCount }, (_, index) =>
      createQuestionFixture(assessment.id, index, {
        prompt: `Harness question ${index + 1} for ${label}?`,
        questionType: "SHORT_ANSWER",
        section: "REQUIRED_SKILLS",
      })
    )
  );

  await jobService.startJob(recruiter.user, draft.id);
  return { job: draft, assessment, questions };
};

const invitationRowFor = (assessmentId, email) =>
  prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

const attemptRowFor = (assessmentId, email) =>
  prisma.jobAssessmentAttempt.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

// Runs ONE real candidate email-verification round trip so the attempt flow can
// run through the REAL public path (no direct row writes).
const verifyCandidateEmail = async (publicId, email) => {
  await jobService.requestAssessmentEmailVerification(publicId, email);
  const code = await waitFor(() => latestCodeFor(email), { timeoutMs: 5000 });
  if (!code) {
    throw new Error(`No verification code was logged for ${email}`);
  }
  await jobService.confirmAssessmentEmailVerification(publicId, email, code);
  return code;
};


// --- HTTP (the REAL public candidate surface) --------------------------------

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

const getContent = async (serverUrl, publicId) => {
  const response = await fetch(contentUrl(serverUrl, publicId));
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload, serialized: JSON.stringify(payload ?? null) };
};

const contentUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}`;
const startUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}/attempt/start`;
const readUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}/attempt`;
const answerUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}/attempt/answer`;
const submitUrl = (serverUrl, publicId) => `${serverUrl}/api/assessment/${publicId}/attempt/submit`;

// --- cleanup & report --------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  jobAssessmentAttempt: await prisma.jobAssessmentAttempt.count(),
  jobAssessmentAttemptAnswer: await prisma.jobAssessmentAttemptAnswer.count(),
  integrityEvent: await prisma.jobAssessmentAttemptIntegrityEvent.count(),
});

// Deletes exactly what this harness created, in FK-safe order, scoped strictly
// to tracked ids.
const cleanup = async () => {
  const removed = {};
  const jobIds = tracked.jobIds;
  const userIds = tracked.userIds;

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
    removed.jobAssessment = (await prisma.jobAssessment.deleteMany({ where: { jobId: { in: jobIds } } }))
      .count;
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
  if (userIds.length > 0) {
    removed.user = (await prisma.user.deleteMany({ where: { id: { in: userIds } } })).count;
  }

  return removed;
};


// --- section A: activation gate ----------------------------------------------

const sectionActivationGate = async ({ serverUrl, jobPre }) => {
  section("A. Activation gate — a non-activated assessment exposes nothing");

  const content = await getContent(serverUrl, jobPre.assessment.publicId);
  check(
    "the public link 404s before activation",
    content.status === 404,
    summarize({ status: content.status })
  );
  check(
    "the pre-activation response carries no question content",
    !content.serialized.includes("Harness question") && !content.serialized.includes("questions"),
    summarize(content.body)
  );

  const start = await postJson(startUrl(serverUrl, jobPre.assessment.publicId), {
    email: `ph3a-pre-${SUFFIX}@example.test`,
  });
  check(
    "attempt start before activation is denied with the generic 403",
    start.status === 403,
    summarize({ status: start.status })
  );

  const read = await postJson(readUrl(serverUrl, jobPre.assessment.publicId), {
    email: `ph3a-pre-${SUFFIX}@example.test`,
  });
  check("attempt resume before activation is denied with 403", read.status === 403);

  let verifyStatus = null;
  try {
    await jobService.requestAssessmentEmailVerification(
      jobPre.assessment.publicId,
      `ph3a-pre-${SUFFIX}@example.test`
    );
    verifyStatus = 200;
  } catch (error) {
    verifyStatus = error.status ?? 500;
  }
  check(
    "email verification before activation is denied with 403",
    verifyStatus === 403,
    summarize({ verifyStatus })
  );

  const attempts = await prisma.jobAssessmentAttempt.count({
    where: { assessmentId: jobPre.assessment.id },
  });
  check("no attempt row can exist for a non-activated assessment", attempts === 0);
};

// --- section B: candidate authorization --------------------------------------

const sectionAuthorization = async ({ serverUrl, jobA, jobB, recruiterA, emails }) => {
  section("B. Candidate authorization — only this assessment's verified email");

  for (let index = 0; index < emails.jobA.length; index += 1) {
    await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, index);
  }
  const invitedRow = await invitationRowFor(jobA.assessment.id, emails.jobA[0]);
  check(
    "the invitation persists as INVITED before any candidate action",
    invitedRow?.status === "INVITED",
    summarize({ status: invitedRow?.status })
  );

  const unverified = await postJson(startUrl(serverUrl, jobA.assessment.publicId), {
    email: emails.jobA[0],
  });
  check(
    "start with an invited but UNVERIFIED email is denied with 403",
    unverified.status === 403,
    summarize({ status: unverified.status })
  );
  const unverifiedAttempt = await attemptRowFor(jobA.assessment.id, emails.jobA[0]);
  check("the denied start created no attempt row", unverifiedAttempt === null);

  const stranger = await postJson(startUrl(serverUrl, jobA.assessment.publicId), {
    email: `ph3a-stranger-${SUFFIX}@example.test`,
  });
  check(
    "start with a never-invited email is denied with 403",
    stranger.status === 403,
    summarize({ status: stranger.status })
  );

  await verifyCandidateEmail(jobA.assessment.publicId, emails.jobA[0]);
  const verifiedRow = await invitationRowFor(jobA.assessment.id, emails.jobA[0]);
  check(
    "the real verification round trip flips the invitation to EMAIL_VERIFIED",
    verifiedRow?.status === "EMAIL_VERIFIED",
    summarize({ status: verifiedRow?.status })
  );

  const unverifiedC = await postJson(startUrl(serverUrl, jobA.assessment.publicId), {
    email: emails.jobA[2],
  });
  check(
    "a DIFFERENT invited candidate on the same assessment is still denied unverified",
    unverifiedC.status === 403,
    summarize({ status: unverifiedC.status })
  );

  // Cross-assessment: verified for jobB, address jobA's link → denied.
  await jobService.inviteJobCandidate(recruiterA.user, jobB.job.id, 0);
  await verifyCandidateEmail(jobB.assessment.publicId, emails.jobB);
  const crossAssessment = await postJson(startUrl(serverUrl, jobA.assessment.publicId), {
    email: emails.jobB,
  });
  check(
    "an email verified for ANOTHER assessment cannot start this one (403)",
    crossAssessment.status === 403,
    summarize({ status: crossAssessment.status })
  );
  const crossRow = await attemptRowFor(jobA.assessment.id, emails.jobB);
  check("the cross-assessment start created no attempt row", crossRow === null);
};
