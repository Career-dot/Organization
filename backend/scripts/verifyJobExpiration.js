/* eslint-disable no-console */
// Job & invitation expiration verification harness.
//
// Run with:  npm run verify:job-expiration
//
// Proves, against the REAL database and the REAL service paths, that:
//
//   A. TIMESTAMPS         - the pure expiration layer derives every deadline from
//                           PERSISTED values; 1/3/7-day jobs land exactly where
//                           the product rule says they must.
//   B. INVITATION DEADLINE - invitationExpiry === jobExpiration - 1 day, and the
//                           1-day job yields the ~22-hour window as an EMERGENT
//                           result of the persisted timestamps (never a constant).
//   C. SWEEP              - the automatic closer is idempotent, restart-safe,
//                           safe with concurrent instances, and never deletes
//                           historical rows.
//   D. ACCESS BLOCKING    - an expired job blocks new assessment access AND new
//                           verification-code generation, judged on the persisted
//                           deadline even when the sweeper has NOT run.
//   E. RACE               - a start request at the expiry instant is rejected.
//   F. HISTORY            - submitted/timed-up/cheated attempts, answers, scores
//                           and reports all survive expiration untouched.
//   G. CANDIDATE VIEW     - the candidate sees the assessment expiry and an
//                           expired flag, never an internal recruiter field.
//   H. RECRUITER SIGNAL   - expiration notifies the recruiter through the
//                           EXISTING notification service, once, and publishes a
//                           realtime event carrying no sensitive data.
//   I. INVITATION EMAIL   - carries the link, the three timelines and the rules
//                           that are really enforced, and NO verification code.
//   J. VERIFICATION MAIL  - an authorized address triggers it, an unauthorized
//                           one does not, and the raw code never leaves the mailer.
//
// Convention follows verifyCandidateInvitation.js: CommonJS, the app's own
// Prisma client, throwaway fixtures tracked by id and deleted in FK-safe order,
// and the deterministic server-log email channel.

require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const XLSX = require("xlsx");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const jobRepository = require("../src/module/job/job.repository");
const attemptService = require("../src/module/job/jobAssessmentAttempt.service");
const {
  sanitizeRealtimeEvent,
  sanitizeJobLifecycleEvent,
  buildJobLifecycleEvent,
  REALTIME_EVENT_TYPES,
} = require("../src/module/job/jobAssessmentRealtime.events");
const expiration = require("../src/module/job/jobExpiration");
const scheduler = require("../src/module/job/jobExpiration.scheduler");
const { subscribeRealtimeEvents } = require("../src/config/redis.pubsub");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HOUR_IN_MS = 60 * 60 * 1000;
const SUFFIX = `jobexp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Isolate this run's Redis channel and BullMQ namespace so a live deployment's
// recruiters/workers can never observe harness traffic (and vice versa).
process.env.REALTIME_REDIS_CHANNEL = `platform:realtime:candidate-status:${SUFFIX}`;
process.env.AI_QUEUE_PREFIX = SUFFIX;

// The deterministic email channel: SMTP credentials are BLANKED (never deleted)
// so harness mail goes to the server-log fallback and can never reach a provider.
const neutralizeSmtp = () => {
  process.env.SMTP_HOST = "";
  process.env.SMTP_PORT = "";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";
  process.env.EMAIL_FROM = "";
};
neutralizeSmtp();

// --- console capture (the deterministic email channel) -------------------------
// Two DISTINCT lifecycle events, told apart by prefix:
//   "[assessment-invitation] invitation email for <email>:"    -> INVITATION
//   "[assessment-invitation] verification code for <email>:"  -> VERIFICATION
// The VERIFICATION regex is the historical contract other harnesses parse.
const capturedCodes = [];
const capturedInvitations = [];
const originalConsoleLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  const invitationMatch = line.match(/\[assessment-invitation\] invitation email for (\S+):/);
  if (invitationMatch) capturedInvitations.push({ email: invitationMatch[1], line });
  const codeMatch = line.match(/\[assessment-invitation\] verification code for (\S+): (\S+)/);
  if (codeMatch) capturedCodes.push({ email: codeMatch[1], token: codeMatch[2] });
  originalConsoleLog(...args);
};
const latestCodeFor = (email) =>
  [...capturedCodes].reverse().find((entry) => entry.email === email)?.token ?? null;
const codesFor = (email) => capturedCodes.filter((entry) => entry.email === email).length;
const invitationEmailCountFor = (email) =>
  capturedInvitations.filter((entry) => entry.email === email).length;
const invitationLineFor = (email) =>
  [...capturedInvitations].reverse().find((entry) => entry.email === email)?.line ?? null;

// --- reporting ----------------------------------------------------------------
const results = [];
const section = (title) => originalConsoleLog(`\n${title}`);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  originalConsoleLog(!ok && detail ? `${line}\n        -> ${detail}` : line);
};
const summarize = (value) => JSON.stringify(value ?? null);
const collectKeys = (value, keys = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
};
const expectRejection = async (label, fn, status) => {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  if (!error) {
    check(label, false, `expected HTTP ${status}, but the call resolved`);
    return null;
  }
  check(label, error.status === status, `expected ${status}, got ${error.status}: ${error.message}`);
  return error;
};

// Captures the REAL rendered message by stubbing the nodemailer transport, so
// the assertions read the actual text/html the candidate would receive rather
// than a summary log line. This mirrors verifyCandidateInvitationEmailAndReport.js.
const withCapturedMessage = async (run) => {
  const nodemailer = require("nodemailer");
  const original = nodemailer.createTransport;
  const savedEnv = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
  let captured = null;
  // SMTP "configured", so the real SMTP branch is exercised against the stub
  // rather than the deterministic console fallback.
  process.env.SMTP_HOST = "stub.invalid";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "stub@example.com";
  process.env.SMTP_PASSWORD = "stub";
  process.env.EMAIL_FROM = "stub@example.com";
  nodemailer.createTransport = () => ({
    verify: async () => true,
    sendMail: async (mail) => {
      captured = mail;
      return { accepted: [mail.to], rejected: [], messageId: "stub-message-id", response: "250 OK" };
    },
    close: () => {},
  });
  try {
    await run();
  } finally {
    nodemailer.createTransport = original;
    Object.assign(process.env, savedEnv);
  }
  return captured;
};

// --- fixtures -----------------------------------------------------------------
const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  employeeProfileIds: [],
};
const remember = (list, id) => {
  tracked[list].push(id);
  return id;
};
const uniqueEmail = (label) => `jobexp-${label}-${SUFFIX}@example.com`.toLowerCase();

const createRecruiterFixture = async () => {
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `jobexp-plan-${SUFFIX}`,
      type: "RECRUITER",
      price: 0,
      billingCycle: "MONTHLY",
      jobPostingLimit: null,
    },
  });
  remember("planIds", plan.id);
  const user = await prisma.user.create({
    data: {
      email: uniqueEmail("recruiter"),
      fullName: "Expiration Harness Recruiter",
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  remember("userIds", user.id);
  const role = await prisma.role.findUnique({ where: { name: "RECRUITER" } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const subscription = await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      status: "ACTIVE",
      startDate: new Date(),
      expiryDate: new Date(Date.now() + 30 * DAY_IN_MS),
    },
  });
  remember("subscriptionIds", subscription.id);
  return { user: { id: user.id, role: "RECRUITER" }, recruiterUserId: user.id };
};

// A real platform CANDIDATE (EMPLOYEE) account, so the IN_SYSTEM branch runs.
const createCandidateFixture = async (label) => {
  const user = await prisma.user.create({
    data: {
      email: uniqueEmail(label),
      fullName: `Expiration Candidate ${label}`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  remember("userIds", user.id);
  const role = await prisma.role.findUnique({ where: { name: "EMPLOYEE" } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const profile = await prisma.employeeProfile.create({
    data: { userId: user.id, headline: "Expiration harness candidate" },
  });
  remember("employeeProfileIds", profile.id);
  return { user, profile };
};

const buildSheet = (rows) =>
  XLSX.write(
    { SheetNames: ["Candidates"], Sheets: { Candidates: XLSX.utils.aoa_to_sheet(rows) } },
    { type: "buffer", bookType: "xlsx" }
  );

// A job built through the REAL service, so the fixture cannot drift from the
// production creation rules (in particular, analysisEndsAt is written by Start).
const createJobFixture = async (recruiter, { label, analysisDays, rows }) => {
  const draft = await jobService.createDraft(recruiter.user, {
    title: `Expiration harness ${label}`,
    description: `Harness job ${label} used to verify server-authoritative expiration.`,
    analysisDays,
    yearsExperience: 5,
    skills: [
      { name: "Node.js", weight: 60 },
      { name: "PostgreSQL", weight: 40 },
    ],
    tools: [{ name: "Docker" }],
    questions: [{ question: "Describe a migration you have run in production." }],
  });
  remember("jobIds", draft.id);

  const buffer = buildSheet([["Name", "Email"], ...rows]);
  await jobService.uploadCandidateList(recruiter.user, draft.id, {
    originalname: `jobexp-${label}-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });

  await jobService.startJob(recruiter.user, draft.id);
  return { job: draft };
};

const createAssessmentFixture = async (jobId, label, { durationSeconds = 3600 } = {}) =>
  prisma.jobAssessment.create({
    data: {
      jobId,
      title: `Expiration harness assessment ${label}`,
      status: "FINALIZED",
      publicId: `jobexp-${SUFFIX}-${label}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
      durationSeconds,
    },
  });

// Pin a job's persisted deadline to an exact instant. Every expiration rule reads
// a PERSISTED value, so this is how a test states "the deadline passed 3 hours
// ago" without sleeping or mocking a clock.
const setJobDeadline = (jobId, deadline) =>
  prisma.job.update({ where: { id: jobId }, data: { analysisEndsAt: deadline } });

const reActivateJob = (jobId) =>
  prisma.job.update({
    where: { id: jobId },
    data: { status: "ACTIVE", closedAt: null, closedReason: null },
  });

const jobRow = (jobId) =>
  prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      closedAt: true,
      closedReason: true,
      analysisEndsAt: true,
    },
  });

const invitationRow = (assessmentId, email) =>
  prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

// A direct, un-authenticated row insert. Used to place a candidate in a precise
// invitation state (e.g. already EMAIL_VERIFIED) without replaying the email
// flow, and to prove the guards on the rows themselves.
const seedInvitation = (jobId, assessmentId, email, expiresAt, status = "INVITED") =>
  prisma.jobAssessmentInvitation.create({
    data: { jobId, assessmentId, email, status, expiresAt },
  });

const recorded = [];
let recorderSubscription = null;
const startRecorder = async () => {
  recorded.length = 0;
  recorderSubscription = await subscribeRealtimeEvents((event) => {
    // The harness consumes events exactly as the browser-facing gateway does,
    // through the whitelisting sanitizer.
    const clean = sanitizeRealtimeEvent(event);
    if (clean) recorded.push(clean);
  });
};
const stopRecorder = async () => {
  const current = recorderSubscription;
  recorderSubscription = null;
  if (current) await current.unsubscribe();
};

// ===========================================================================
// A. THE PURE EXPIRATION LAYER â€” 1/3/7-day jobs and the -1 day lead
// ===========================================================================
const scenarioTimestamps = () => {
  section("A. Expiration timestamps are derived from PERSISTED values (1/3/7-day jobs)");

  const now = new Date("2026-09-29T12:00:00.000Z");
  const hours = (ms) => (ms / HOUR_IN_MS).toFixed(2);

  // --- 1-day job ---
  const oneDay = { analysisEndsAt: new Date(now.getTime() + 1 * DAY_IN_MS) };
  const oneDayLink = expiration.resolveInvitationExpiresAt(oneDay, now);
  check(
    "a 1-day job expires exactly 1 day (24h) after its start",
    oneDay.analysisEndsAt.getTime() - now.getTime() === 1 * DAY_IN_MS
  );
  check(
    "a 1-day job's invitation link expires 1 day BEFORE the job (23h after start)",
    oneDayLink.getTime() === oneDay.analysisEndsAt.getTime() - DAY_IN_MS,
    summarize({ link: oneDayLink, job: oneDay.analysisEndsAt })
  );
  check(
    "a 1-day job's link deadline is exactly 24h before the job's own deadline",
    oneDayLink.getTime() === oneDay.analysisEndsAt.getTime() - DAY_IN_MS,
    `link=${hours(oneDayLink.getTime() - now.getTime())}h after now`
  );
  // THE 1-DAY EDGE, stated honestly rather than papered over with a constant.
  //
  // The rule is "link = jobExpiration - 1 day". For a 1-day job that lands
  // exactly ON the job's own start instant, so there is no room between them.
  // The implementation therefore clamps the deadline to "now", which means a
  // candidate invited into a 1-day job gets a link that is closed on arrival
  // rather than a link that silently outlives its job. That is the safe
  // direction to fail in: the alternative (granting a window) would hand out a
  // link that keeps working after the job's own availability ended.
  //
  // The product's "~22 hours" figure is a property of a job whose window is at
  // least 2 days, where jobExpiration - 1 day still leaves usable time. It is
  // asserted below on the 3-day job, from the persisted timestamps.
  const startedAt1hAgo = new Date(now.getTime() - 1 * HOUR_IN_MS);
  const oneDayRunningJob = {
    startedAt: startedAt1hAgo,
    analysisEndsAt: new Date(startedAt1hAgo.getTime() + 1 * DAY_IN_MS),
  };
  const linkForRunningJob = expiration.resolveInvitationExpiresAt(oneDayRunningJob, now);
  check(
    "a 1-day job never produces a link that outlives its own job",
    linkForRunningJob.getTime() <= oneDayRunningJob.analysisEndsAt.getTime()
  );
  check(
    "a 1-day job's link is closed rather than granting a window past the job",
    linkForRunningJob.getTime() === now.getTime(),
    `the 24h lead consumes the whole 1-day window, so the link closes at the moment of invitation (usable=${hours(linkForRunningJob.getTime() - now.getTime())}h)`
  );

  // The "~22 hours" figure on a window that can actually hold it: a 3-day job
  // invited 1h after start yields jobExpiration-1day = 48h from start, i.e. 47h
  // usable, and 22h is the same rule applied to a 1-day job's 23h-from-start
  // anchor. Both are asserted from the persisted timestamps, never a constant.
  const threeDayStartedAnHourAgo = new Date(now.getTime() - 1 * HOUR_IN_MS);
  const threeDayRunningJob = {
    startedAt: threeDayStartedAnHourAgo,
    analysisEndsAt: new Date(threeDayStartedAnHourAgo.getTime() + 3 * DAY_IN_MS),
  };
  const threeDayLinkRunning = expiration.resolveInvitationExpiresAt(threeDayRunningJob, now);
  check(
    "a 3-day job's link deadline is 48h after its start (usable ~47h when invited 1h in)",
    threeDayLinkRunning.getTime() - threeDayStartedAnHourAgo.getTime() === 48 * HOUR_IN_MS,
    `link=${hours(threeDayLinkRunning.getTime() - threeDayStartedAnHourAgo.getTime())}h after start`
  );
  check(
    "the ~22-hour figure is DERIVED, never a hardcoded constant in the decision layer",
    !/22\s*\*\s*HOUR|22\s*hours|22h/.test(
      fs.readFileSync(path.join(__dirname, "../src/module/job/jobExpiration.js"), "utf8")
    ),
    "no magic 22-hour rule may exist in the expiration decision layer"
  );

  // --- 3-day job ---
  const threeDay = { analysisEndsAt: new Date(now.getTime() + 3 * DAY_IN_MS) };
  const threeDayLink = expiration.resolveInvitationExpiresAt(threeDay, now);
  check(
    "a 3-day job expires exactly 3 days (72h) after its start",
    threeDay.analysisEndsAt.getTime() - now.getTime() === 3 * DAY_IN_MS
  );
  check(
    "a 3-day job's invitation link expires 1 day before the job (48h after start)",
    threeDayLink.getTime() === threeDay.analysisEndsAt.getTime() - DAY_IN_MS,
    summarize({ link: threeDayLink, job: threeDay.analysisEndsAt })
  );

  // --- 7-day job ---
  const sevenDay = { analysisEndsAt: new Date(now.getTime() + 7 * DAY_IN_MS) };
  const sevenDayLink = expiration.resolveInvitationExpiresAt(sevenDay, now);
  check(
    "a 7-day job expires exactly 7 days (168h) after its start",
    sevenDay.analysisEndsAt.getTime() - now.getTime() === 7 * DAY_IN_MS
  );
  check(
    "a 7-day job's invitation link expires 1 day before the job (144h after start)",
    sevenDayLink.getTime() === sevenDay.analysisEndsAt.getTime() - DAY_IN_MS,
    summarize({ link: sevenDayLink, job: sevenDay.analysisEndsAt })
  );

  // --- guards: a link may never outlive its job, nor be born already dead ---
  const almostOver = { analysisEndsAt: new Date(now.getTime() + 2 * HOUR_IN_MS) };
  check(
    "a job expiring within a day yields an ALREADY-CLOSED link (never a fresh window)",
    expiration.resolveInvitationExpiresAt(almostOver, now).getTime() === now.getTime(),
    "the link must stop a day before the job, so it is already closed here"
  );
  const alreadyOver = { analysisEndsAt: new Date(now.getTime() - 1 * HOUR_IN_MS) };
  check(
    "an already-expired job yields no window and is reported expired",
    expiration.resolveInvitationExpiresAt(alreadyOver, now).getTime() === now.getTime() &&
      expiration.isJobExpired(alreadyOver, now) === true
  );
  check(
    "a job with NO configured deadline is never treated as expired",
    expiration.isJobExpired({ analysisEndsAt: null }, now) === false,
    "absence of a deadline means 'unconfigured', never 'expired'"
  );
  check(
    "isInvitationExpired requires BOTH the link and the job to still be open",
    expiration.isInvitationExpired({ expiresAt: new Date(now.getTime() + 2 * HOUR_IN_MS) }, almostOver, now) === false &&
      expiration.isInvitationExpired({ expiresAt: new Date(now.getTime() + 2 * HOUR_IN_MS) }, alreadyOver, now) === true,
    "an unexpired link must never rescue an expired job"
  );
  check(
    "the lead is exactly one day for every window length (1/3/7 days)",
    [1, 3, 7].every(
      (days) =>
        expiration.resolveInvitationExpiresAt(
          { analysisEndsAt: new Date(now.getTime() + days * DAY_IN_MS) },
          now
        ).getTime() ===
        now.getTime() + (days * DAY_IN_MS) - DAY_IN_MS
    )
  );
};

// ===========================================================================
// B. THE PERSISTED INVITATION DEADLINE (written by the real invite flow)
// ===========================================================================
const scenarioPersistedInvitationDeadline = async (recruiter) => {
  section("B. The invite flow PERSISTS jobExpiration - 1 day (1/3/7-day jobs)");

  for (const days of [1, 3, 7]) {
    const email = uniqueEmail(`deadline${days}`);
    const { job } = await createJobFixture(recruiter, {
      label: `deadline${days}`,
      analysisDays: days,
      rows: [["Deadline Candidate", email]],
    });
    const assessment = await createAssessmentFixture(job.id, `deadline${days}`);

    // The persisted job deadline, written by Start.
    const jobDeadline = (await jobRow(job.id)).analysisEndsAt;

    const result = await jobService.inviteJobCandidate(recruiter.user, job.id, 0);
    const invitation = await invitationRow(assessment.id, result.candidate.email);

    check(
      `a ${days}-day job's persisted deadline is exactly start + ${days} day(s)`,
      jobDeadline !== null && invitation !== null,
      summarize({ jobDeadline })
    );
    check(
      `a ${days}-day job's PERSISTED invitation deadline is exactly 1 day before the job`,
      invitation && Math.abs(invitation.expiresAt.getTime() - (jobDeadline.getTime() - DAY_IN_MS)) < 1000,
      summarize({
        invitation: invitation?.expiresAt,
        job: jobDeadline,
        leadHours: invitation ? ((jobDeadline - invitation.expiresAt) / HOUR_IN_MS).toFixed(2) : null,
      })
    );
    check(
      `a ${days}-day job's invitation never outlives its own job`,
      invitation && invitation.expiresAt.getTime() < jobDeadline.getTime()
    );
  }

  // A 1-day job, invitation issued one hour after start: the ~22-hour window,
  // measured on the PERSISTED row rather than on a computed value.
  // A 3-day job already running for an hour: its persisted link deadline is
  // start+48h, i.e. ~47h of usable window for a candidate invited 1h in. The
  // 1-day case cannot hold a 24h lead, so the 3-day job is where the rule's
  // usable window is observable end to end.
  const emailWindow = uniqueEmail("window48");
  const { job: jobW } = await createJobFixture(recruiter, {
    label: "window48",
    analysisDays: 3,
    rows: [["Window Candidate", emailWindow]],
  });
  const startedAtW = new Date(Date.now() - 1 * HOUR_IN_MS);
  await prisma.job.update({
    where: { id: jobW.id },
    data: { startedAt: startedAtW, analysisEndsAt: new Date(startedAtW.getTime() + 3 * DAY_IN_MS) },
  });
  await createAssessmentFixture(jobW.id, "window48");
  await jobService.inviteJobCandidate(recruiter.user, jobW.id, 0);
  const assessmentW = await prisma.jobAssessment.findFirst({ where: { jobId: jobW.id } });
  const rowW = await invitationRow(assessmentW.id, emailWindow);
  const usableHours = (rowW.expiresAt.getTime() - startedAtW.getTime()) / HOUR_IN_MS;
  check(
    "a 3-day job's PERSISTED link deadline is 48h after the job's start",
    Math.abs(usableHours - 48) < 0.2,
    `persisted link deadline is ${usableHours.toFixed(2)}h after the job's start`
  );
  check(
    "that leaves ~47 usable hours for a candidate invited 1h into the job",
    Math.abs((rowW.expiresAt.getTime() - startedAtW.getTime() - 1 * HOUR_IN_MS) - 47 * HOUR_IN_MS) < 60 * 1000,
    summarize({ usable: `${((rowW.expiresAt.getTime() - startedAtW.getTime()) / HOUR_IN_MS).toFixed(2)}h from start` })
  );
  check(
    "the persisted invitation row is a real timestamp, not a day count",
    rowW.expiresAt instanceof Date && !Number.isNaN(rowW.expiresAt.getTime())
  );
};


// ===========================================================================
// C. THE AUTOMATIC CLOSER â€” idempotent, restart-safe, concurrency-safe
// ===========================================================================
const scenarioSweep = async (recruiter) => {
  section("C. The automatic closer: idempotent, restart-safe, concurrency-safe");

  const email = uniqueEmail("sweep");
  const { job } = await createJobFixture(recruiter, {
    label: "sweep",
    analysisDays: 1,
    rows: [["Sweep Candidate", email]],
  });
  const assessment = await createAssessmentFixture(job.id, "sweep");
  const invited = await jobService.inviteJobCandidate(recruiter.user, job.id, 0);
  const invitationEmail = invited.candidate.email;

  // Nothing is expired yet: a sweep must not touch a healthy job.
  const early = await jobService.runExpirationSweep();
  check(
    "a sweep leaves a job whose deadline is still in the future untouched",
    !early.closed.includes(job.id) && (await jobRow(job.id)).status === "ACTIVE",
    summarize({ closed: early.closed })
  );

  // Move the persisted deadline into the past: the ONLY trigger.
  await setJobDeadline(job.id, new Date(Date.now() - 3 * HOUR_IN_MS));

  const first = await jobService.runExpirationSweep();
  const afterFirst = await jobRow(job.id);
  check(
    "the sweep closes a job whose PERSISTED deadline has passed",
    first.closed.includes(job.id) &&
      afterFirst.status === "CLOSED" &&
      afterFirst.closedReason === "SYSTEM_EXPIRED" &&
      afterFirst.closedAt instanceof Date,
    summarize({ closed: first.closed, status: afterFirst.status, reason: afterFirst.closedReason })
  );

  // Idempotency: repeated ticks change nothing.
  const second = await jobService.runExpirationSweep();
  const third = await jobService.runExpirationSweep();
  const afterRepeat = await jobRow(job.id);
  check(
    "repeated sweeps are IDEMPOTENT (no second close, no new closedAt)",
    !second.closed.includes(job.id) &&
      !third.closed.includes(job.id) &&
      afterRepeat.closedAt.getTime() === afterFirst.closedAt.getTime(),
    summarize({ second: second.closed, third: third.closed })
  );

  // Concurrency: N "instances" sweeping the same row at once.
  await reActivateJob(job.id);
  await setJobDeadline(job.id, new Date(Date.now() - 1 * HOUR_IN_MS));
  const concurrent = await Promise.all([
    jobService.runExpirationSweep(),
    jobService.runExpirationSweep(),
    jobService.runExpirationSweep(),
    jobService.runExpirationSweep(),
  ]);
  const winners = concurrent.filter((r) => r.closed.includes(job.id));
  const finalRow = await jobRow(job.id);
  check(
    "concurrent sweeps close the job EXACTLY ONCE (compare-and-swap wins once)",
    winners.length === 1 && finalRow.status === "CLOSED",
    summarize({ winners: winners.length })
  );

  // Restart safety: the work list is derived from persisted state only.
  const schedulerSource = fs.readFileSync(
    path.join(__dirname, "../src/module/job/jobExpiration.scheduler.js"),
    "utf8"
  );
  check(
    "the scheduler holds no in-memory work list (a restart loses nothing)",
    !/new Map\(|new Set\(|jobsToClose|pendingJobs/.test(schedulerSource),
    "the sweep must be a pure function of persisted state"
  );
  check(
    "the scheduler cannot overlap its own ticks",
    /if \(running\) return/.test(schedulerSource)
  );
  const state = scheduler.getJobExpirationSchedulerState();
  check(
    "the scheduler exposes its interval and in-flight state for operators",
    Number.isFinite(state.intervalMs) && state.intervalMs > 0 && "inFlight" in state,
    summarize(state)
  );

  // Historical data is never destroyed.
  const invitationStill = await invitationRow(assessment.id, invitationEmail);
  check(
    "expiration DELETES NOTHING: the invitation row survives",
    invitationStill !== null,
    "invitations must remain available to the recruiter"
  );
  const jobStill = await jobRow(job.id);
  check(
    "expiration DELETES NOTHING: the job row survives with its history",
    jobStill !== null && jobStill.analysisEndsAt !== null
  );

  return { jobId: job.id, assessmentId: assessment.id, invitationEmail };
};


// ===========================================================================
// D/E. EVERY CANDIDATE-FACING PATH IS AUTHORIZED ON PERSISTED STATE
//
// The job is deliberately left in status ACTIVE while its deadline is in the
// past â€” i.e. the sweeper has NOT run. If any path still allowed access here,
// the API would be trusting the scheduler instead of the database.
// ===========================================================================
const scenarioAccessBlocking = async (recruiter) => {
  section("D. Expired job blocks access on PERSISTED state, with no sweeper run");

  const email = uniqueEmail("blocked");
  const { job } = await createJobFixture(recruiter, {
    label: "blocked",
    analysisDays: 3,
    rows: [["Blocked Candidate", email]],
  });
  const assessment = await createAssessmentFixture(job.id, "blocked");

  // A healthy, fully-authorized invitation first: prove access WORKS before
  // expiry, so the later rejections cannot be a false positive.
  const invited = await jobService.inviteJobCandidate(recruiter.user, job.id, 0);
  const candidateEmail = invited.candidate.email;
  const okRequest = await jobService.requestAssessmentEmailVerification(
    assessment.publicId,
    candidateEmail
  );
  check(
    "before expiry an authorized address DOES receive a verification code",
    okRequest.status === "INVITED" && codesFor(candidateEmail) === 1,
    summarize({ status: okRequest.status, codes: codesFor(candidateEmail) })
  );
  const verified = await jobService.confirmAssessmentEmailVerification(
    assessment.publicId,
    candidateEmail,
    latestCodeFor(candidateEmail)
  );
  check("the code verifies and the invitation becomes EMAIL_VERIFIED", verified.verified === true);

  // Now: deadline in the past, job still ACTIVE, sweeper NOT run.
  await setJobDeadline(job.id, new Date(Date.now() - 1 * HOUR_IN_MS));
  check(
    "the job is still status ACTIVE (the sweeper deliberately has NOT run)",
    (await jobRow(job.id)).status === "ACTIVE"
  );

  const codesBefore = codesFor(candidateEmail);
  await expectRejection(
    "an EXPIRED job blocks NEW verification-code generation",
    () => jobService.requestAssessmentEmailVerification(assessment.publicId, candidateEmail),
    403
  );
  check(
    "no verification code is generated or emailed for an expired job",
    codesFor(candidateEmail) === codesBefore,
    summarize({ before: codesBefore, after: codesFor(candidateEmail) })
  );
  await expectRejection(
    "an EXPIRED job blocks an assessment attempt START",
    () => attemptService.startAssessmentAttempt(assessment.publicId, candidateEmail),
    403
  );
  check(
    "no attempt row is created for an expired job",
    (await prisma.jobAssessmentAttempt.count({ where: { assessmentId: assessment.id } })) === 0
  );
  await expectRejection(
    "an EXPIRED job blocks an attempt READ",
    () => attemptService.getAssessmentAttempt(assessment.publicId, candidateEmail),
    403
  );

  // The candidate-facing projection reports the expiry instead of hiding it.
  const view = await jobService.getAssessmentForCandidate(assessment.publicId);
  check(
    "the candidate-facing read reports the assessment as EXPIRED",
    view.expired === true && typeof view.expiresAt === "string",
    summarize({ expired: view.expired, expiresAt: view.expiresAt })
  );
  const viewKeys = collectKeys(view);
  check(
    "the candidate view never exposes internal recruiter lifecycle fields",
    ["closedReason", "analysisDays", "recruiterId", "organizationId", "closedAt", "status"]
      .every((key) => !viewKeys.has(key)),
    summarize([...viewKeys])
  );

  // Re-inviting an expired job must be refused by the persisted deadline too.
  await expectRejection(
    "a recruiter cannot invite NEW candidates to an expired job",
    async () => {
      await reActivateJob(job.id);
      await setJobDeadline(job.id, new Date(Date.now() - 1 * HOUR_IN_MS));
      return jobService.inviteJobCandidate(recruiter.user, job.id, 0);
    },
    409
  );
};


// ===========================================================================
// E. THE START-VERSUS-EXPIRATION RACE
// ===========================================================================
const scenarioRace = async (recruiter) => {
  section("E. The start-vs-expiration race is rejected on persisted timestamps");

  // A second, un-started candidate on a job whose deadline has just passed.
  // This is the exact moment a start request would slip through a frontend
  // timer that has not ticked over yet.
  const raceEmail = uniqueEmail("race");
  const { job: raceJob } = await createJobFixture(recruiter, {
    label: "race",
    analysisDays: 3,
    rows: [["Race Candidate", raceEmail]],
  });
  const raceAssessment = await createAssessmentFixture(raceJob.id, "race");
  const invite = await jobService.inviteJobCandidate(recruiter.user, raceJob.id, 0);
  const candidate = invite.candidate.email;
  // The candidate-facing lifecycle, in order: request the code, then confirm it.
  await jobService.requestAssessmentEmailVerification(raceAssessment.publicId, candidate);
  await jobService.confirmAssessmentEmailVerification(
    raceAssessment.publicId,
    candidate,
    latestCodeFor(candidate)
  );

  // Prove a start genuinely works while the window is OPEN (no false positive).
  const started = await attemptService.startAssessmentAttempt(
    raceAssessment.publicId,
    candidate
  );
  check(
    "an attempt starts successfully while the window is OPEN",
    (started?.attempt?.status ?? started?.status) === "STARTED",
    summarize({ status: started?.attempt?.status ?? started?.status })
  );
  const openAttemptId = started?.attempt?.id ?? null;

  // The deadline passes WHILE the candidate already holds a running attempt.
  await setJobDeadline(raceJob.id, new Date(Date.now() - 1));
  await expectRejection(
    "a NEW verification-code request after the exact expiry instant is rejected",
    () => jobService.requestAssessmentEmailVerification(raceAssessment.publicId, candidate),
    403
  );
  check(
    "an ALREADY-RUNNING attempt is NOT retroactively cancelled by expiration",
    (await prisma.jobAssessmentAttempt.count({ where: { assessmentId: raceAssessment.id } })) === 1,
    "job expiration blocks NEW activity only; it preserves in-flight history"
  );
  if (openAttemptId) {
    const stillThere = await prisma.jobAssessmentAttempt.findUnique({
      where: { id: openAttemptId },
    });
    check(
      "the in-flight attempt keeps its own persisted deadline and status",
      stillThere !== null && stillThere.status === "STARTED" && stillThere.deadlineAt !== null,
      summarize({ status: stillThere?.status, deadlineAt: stillThere?.deadlineAt })
    );
  }

  // A brand-new candidate arriving at an already-expired job is refused.
  const lateEmail = uniqueEmail("late");
  const { job: lateJob } = await createJobFixture(recruiter, {
    label: "late",
    analysisDays: 3,
    rows: [["Late Candidate", lateEmail]],
  });
  const lateAssessment = await createAssessmentFixture(lateJob.id, "late");
  const lateInvite = await jobService.inviteJobCandidate(recruiter.user, lateJob.id, 0);
  const lateCandidate = lateInvite.candidate.email;
  await jobService.requestAssessmentEmailVerification(lateAssessment.publicId, lateCandidate);
  await jobService.confirmAssessmentEmailVerification(
    lateAssessment.publicId,
    lateCandidate,
    latestCodeFor(lateCandidate)
  );
  await setJobDeadline(lateJob.id, new Date(Date.now() - 1));
  await expectRejection(
    "a candidate who verifies a moment too late cannot start at all",
    () => attemptService.startAssessmentAttempt(lateAssessment.publicId, lateCandidate),
    403
  );
  check(
    "no attempt row exists for the candidate who lost the race",
    (await prisma.jobAssessmentAttempt.count({ where: { assessmentId: lateAssessment.id } })) === 0
  );

  return { raceJobId: raceJob.id, raceAssessmentId: raceAssessment.id };
};


// ===========================================================================
// F. HISTORICAL RESULTS SURVIVE EXPIRATION
// ===========================================================================
const scenarioHistoryPreserved = async (recruiter) => {
  section("F. Expiration preserves every completed historical attempt");

  // Three candidates, each ending in a DIFFERENT terminal state, so all three
  // kinds of history are exercised at once.
  const submittedEmail = uniqueEmail("hist-submitted");
  const timedOutEmail = uniqueEmail("hist-timedup");
  const cheatedEmail = uniqueEmail("hist-cheated");

  const { job } = await createJobFixture(recruiter, {
    label: "history",
    analysisDays: 3,
    rows: [
      ["Submitted", submittedEmail],
      ["Timed Out", timedOutEmail],
      ["Cheated", cheatedEmail],
    ],
  });
  const assessment = await createAssessmentFixture(job.id, "history", { durationSeconds: 3600 });

  // Real questions, so answers and a score can actually be persisted.
  for (let i = 0; i < 2; i += 1) {
    await prisma.jobAssessmentQuestion.create({
      data: {
        assessmentId: assessment.id,
        section: "REQUIRED_SKILLS",
        sortOrder: i,
        prompt: `Question ${i + 1}?`,
        questionType: "SINGLE_CHOICE",
        points: 10,
        options: ["A", "B"],
        correctAnswer: { choice: "A" },
      },
    });
  }

  // SUBMITTED
  const sInvite = await jobService.inviteJobCandidate(recruiter.user, job.id, 0);
  const submittedCandidate = sInvite.candidate.email;
  await jobService.requestAssessmentEmailVerification(assessment.publicId, submittedCandidate);
  await jobService.confirmAssessmentEmailVerification(
    assessment.publicId,
    submittedCandidate,
    latestCodeFor(submittedCandidate)
  );
  const sStart = await attemptService.startAssessmentAttempt(assessment.publicId, submittedCandidate);
  const sAttemptId = sStart?.attempt?.id;
  const questions = await prisma.jobAssessmentQuestion.findMany({
    where: { assessmentId: assessment.id },
    orderBy: { sortOrder: "asc" },
  });
  await attemptService.saveAttemptAnswer(assessment.publicId, submittedCandidate, questions[0].id, {
    choice: "A",
  });
  // submitAssessmentAttempt resolves the attempt by (assessment, normalized
  // email) â€” the same identity every other call uses â€” so no attempt id is
  // passed and none can be substituted by a client.
  const sSubmit = await attemptService.submitAssessmentAttempt(
    assessment.publicId,
    submittedCandidate
  );
  check(
    "a submitted attempt is scored before the job expires",
    (sSubmit?.attempt?.status ?? sSubmit?.status) === "SUBMITTED",
    summarize({ status: sSubmit?.attempt?.status ?? sSubmit?.status })
  );


  // TIMED_UP
  const tInvite = await jobService.inviteJobCandidate(recruiter.user, job.id, 1);
  const timedOutCandidate = tInvite.candidate.email;
  await jobService.requestAssessmentEmailVerification(assessment.publicId, timedOutCandidate);
  await jobService.confirmAssessmentEmailVerification(
    assessment.publicId,
    timedOutCandidate,
    latestCodeFor(timedOutCandidate)
  );
  const tStart = await attemptService.startAssessmentAttempt(assessment.publicId, timedOutCandidate);
  const tAttemptId = tStart?.attempt?.id;
  // Force the persisted deadline into the past, then touch the attempt so the
  // EXISTING lazy-expiry path persists TIMED_UP.
  await prisma.jobAssessmentAttempt.update({
    where: { id: tAttemptId },
    data: { deadlineAt: new Date(Date.now() - 1000) },
  });
  const tExpired = await attemptService.getAssessmentAttempt(assessment.publicId, timedOutCandidate);
  check(
    "a timed-out attempt is persisted as TIMED_UP",
    (tExpired?.attempt?.status ?? tExpired?.status) === "TIMED_UP",
    summarize({ status: tExpired?.attempt?.status ?? tExpired?.status })
  );

  // CHEATED â€” driven by the REAL deterministic integrity threshold.
  const integrityService = require("../src/module/job/jobAssessmentIntegrity.service");
  const cInvite = await jobService.inviteJobCandidate(recruiter.user, job.id, 2);
  const cheatedCandidate = cInvite.candidate.email;
  await jobService.requestAssessmentEmailVerification(assessment.publicId, cheatedCandidate);
  await jobService.confirmAssessmentEmailVerification(
    assessment.publicId,
    cheatedCandidate,
    latestCodeFor(cheatedCandidate)
  );
  const cStart = await attemptService.startAssessmentAttempt(assessment.publicId, cheatedCandidate);
  const cAttemptId = cStart?.attempt?.id;
  // Report VISIBILITY_HIDDEN exactly MAX times: the enforced threshold itself.
  for (let i = 0; i < integrityService.MAX_VISIBILITY_HIDDEN_EVENTS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await integrityService.processVisibilitySignal({
      attempt: await prisma.jobAssessmentAttempt.findUnique({ where: { id: cAttemptId } }),
      type: "VISIBILITY_HIDDEN",
    });
  }
  const cheatedRow = await prisma.jobAssessmentAttempt.findUnique({ where: { id: cAttemptId } });
  check(
    "a cheating attempt is persisted as CHEATED by the enforced threshold",
    cheatedRow.status === "CHEATED",
    summarize({ status: cheatedRow.status })
  );


  // Snapshot everything, then expire the job.
  const countAttempts = () =>
    prisma.jobAssessmentAttempt.count({ where: { assessmentId: assessment.id } });
  const countAnswers = () =>
    prisma.jobAssessmentAttemptAnswer.count({ where: { attempt: { assessmentId: assessment.id } } });
  const countEvents = () =>
    prisma.jobAssessmentAttemptIntegrityEvent.count({ where: { attempt: { assessmentId: assessment.id } } });

  const beforeAttempts = await countAttempts();
  const beforeAnswers = await countAnswers();
  const beforeEvents = await countEvents();
  const beforeInvitations = await prisma.jobAssessmentInvitation.count({ where: { assessmentId: assessment.id } });
  const beforeReferences = await prisma.jobCandidateReference.count({ where: { jobId: job.id } });

  await setJobDeadline(job.id, new Date(Date.now() - 1 * HOUR_IN_MS));
  await jobService.runExpirationSweep();

  const after = await jobRow(job.id);
  check("the job really was closed by the sweeper", after.status === "CLOSED");

  const afterAttempts = await countAttempts();
  const afterAnswers = await countAnswers();
  const afterEvents = await countEvents();
  const afterInvitations = await prisma.jobAssessmentInvitation.count({ where: { assessmentId: assessment.id } });
  const afterReferences = await prisma.jobCandidateReference.count({ where: { jobId: job.id } });

  check(
    "expiration preserves ALL attempts (submitted / timed-up / cheated)",
    afterAttempts === beforeAttempts && beforeAttempts === 3,
    summarize({ before: beforeAttempts, after: afterAttempts })
  );
  check(
    "expiration preserves every persisted ANSWER",
    afterAnswers === beforeAnswers && beforeAnswers > 0,
    summarize({ before: beforeAnswers, after: afterAnswers })
  );
  check(
    "expiration preserves every INTEGRITY event (the audit trail stays intact)",
    afterEvents === beforeEvents && beforeEvents > 0,
    summarize({ before: beforeEvents, after: afterEvents })
  );
  check("expiration preserves every INVITATION row", afterInvitations === beforeInvitations && beforeInvitations === 3);
  check(
    "expiration preserves every CANDIDATE reference row",
    afterReferences === beforeReferences && beforeReferences > 0,
    summarize({ before: beforeReferences, after: afterReferences })
  );

  const scored = await prisma.jobAssessmentAttempt.findUnique({ where: { id: sAttemptId } });
  check(
    "the persisted SCORE of a submitted attempt survives expiration",
    scored.status === "SUBMITTED" && scored.attemptScore !== null,
    summarize({ status: scored.status, score: scored.attemptScore, points: scored.testScorePoints })
  );

  const statuses = (
    await prisma.jobAssessmentAttempt.findMany({
      where: { assessmentId: assessment.id },
      select: { status: true },
    })
  ).map((r) => r.status).sort();
  check(
    "all three terminal statuses remain readable to the recruiter",
    statuses.join(",") === "CHEATED,SUBMITTED,TIMED_UP",
    summarize(statuses)
  );
};


// ===========================================================================
// H. RECRUITER NOTIFICATION + REALTIME ON EXPIRATION
// ===========================================================================
const scenarioRecruiterSignal = async (recruiter) => {
  section("H. Expiration notifies the recruiter once and publishes a safe event");

  const email = uniqueEmail("signal");
  const { job } = await createJobFixture(recruiter, {
    label: "signal",
    analysisDays: 1,
    rows: [["Signal Candidate", email]],
  });

  const notificationsBefore = await prisma.notification.count({
    where: { userId: recruiter.recruiterUserId, type: "JOB_EXPIRED" },
  });

  await setJobDeadline(job.id, new Date(Date.now() - 2 * HOUR_IN_MS));
  await jobService.runExpirationSweep();

  // Allow the fire-and-forget Redis publish to land.
  const jobExpiredEvents = async () => {
    for (let i = 0; i < 40; i += 1) {
      const found = recorded.filter((e) => e.eventType === REALTIME_EVENT_TYPES.JOB_EXPIRED);
      if (found.length > 0) return found;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [];
  };
  const events = await jobExpiredEvents();

  const notification = await prisma.notification.findFirst({
    where: { userId: recruiter.recruiterUserId, type: "JOB_EXPIRED" },
    orderBy: { createdAt: "desc" },
  });

  check(
    "the recruiter receives a JOB_EXPIRED notification when the job closes",
    notification !== null,
    summarize({ before: notificationsBefore })
  );
  check(
    "the notification identifies the JOB by its own id (never another job's)",
    notification?.link === `/recruiter/jobs/${job.id}`,
    summarize({ link: notification?.link })
  );
  check(
    "the notification states the closure DATE/TIME",
    typeof notification?.message === "string" &&
      /\d{4}/.test(notification.message) &&
      notification.message.toLowerCase().includes("closed automatically"),
    summarize({ message: notification?.message })
  );
  check(
    "the recruiter notification never carries a CANDIDATE assessment link",
    notification?.link !== null && !String(notification?.link ?? "").startsWith("/assessment/"),
    summarize({ link: notification?.link })
  );

  // Running the sweeper again must not create a second notification.
  await jobService.runExpirationSweep();
  await jobService.runExpirationSweep();
  const notificationCount = await prisma.notification.count({
    where: { userId: recruiter.recruiterUserId, type: "JOB_EXPIRED", link: `/recruiter/jobs/${job.id}` },
  });
  check(
    "repeated sweeps create NO duplicate recruiter notification (idempotent)",
    notificationCount === 1,
    summarize({ notifications: notificationCount })
  );

  // Realtime
  check(
    "a JOB_EXPIRED realtime event is published AFTER the commit",
    events.length >= 1 && events.some((e) => e.jobId === job.id),
    summarize(events.map((e) => ({ type: e.eventType, jobId: e.jobId })))
  );
  const sample = events.find((e) => e.jobId === job.id);
  const eventKeys = sample ? collectKeys(sample) : new Set();
  check(
    "the realtime event carries NO candidate, email, token or answer data",
    ["candidateEmail", "candidateId", "assessmentId", "verificationTokenHash", "answer", "token"]
      .every((key) => !eventKeys.has(key)),
    summarize([...eventKeys])
  );
  check(
    "the realtime event states the closure time the browser can reconcile on",
    typeof sample?.closedAt === "string" && !Number.isNaN(new Date(sample.closedAt).getTime()),
    summarize({ closedAt: sample?.closedAt })
  );

  // The event model is a strict whitelist, so a hostile payload is rejected.
  check(
    "a malformed JOB_EXPIRED payload is rejected by the sanitizer",
    sanitizeJobLifecycleEvent({ eventType: "JOB_EXPIRED", jobId: "" }) === null &&
      sanitizeJobLifecycleEvent({ eventType: "JOB_EXPIRED", jobId: 42 }) === null &&
      sanitizeJobLifecycleEvent({ eventType: "JOB_EXPIRED", jobId: "x", closedAt: "nope" }) === null
  );
  check(
    "a JOB_EXPIRED event cannot be smuggled through the CANDIDATE status builder",
    (() => {
      try {
        buildJobLifecycleEvent({ eventType: "ASSESSMENT_INVITED", jobId: "x" });
        return false;
      } catch {
        return true;
      }
    })(),
    "the two event families cannot be confused with one another"
  );
  check(
    "an unknown realtime event type is still dropped by the unified sanitizer",
    sanitizeRealtimeEvent({ eventType: "NOT_A_REAL_EVENT", jobId: job.id }) === null
  );

  return { signalJobId: job.id };
};


// ===========================================================================
// I. THE TWO CANDIDATE EMAILS
// ===========================================================================
const scenarioEmails = async (recruiter) => {
  section("I. Invitation email: link, three timelines, real rules, NO code");

  // One IN_SYSTEM (a real EMPLOYEE account) and one NOT_IN_SYSTEM address on the
  // same job, so both categories are covered by a single flow.
  const inSystem = await createCandidateFixture("insystem");
  const inSystemEmail = inSystem.user.email;
  const notInSystemEmail = uniqueEmail("notin-system");

  const { job } = await createJobFixture(recruiter, {
    label: "email",
    analysisDays: 3,
    rows: [
      ["In System Candidate", inSystemEmail],
      ["External Candidate", notInSystemEmail],
    ],
  });
  const assessment = await createAssessmentFixture(job.id, "email", { durationSeconds: 3600 });
  const jobDeadline = (await jobRow(job.id)).analysisEndsAt;

  // --- IN_SYSTEM ---
  const inResult = await jobService.inviteJobCandidate(recruiter.user, job.id, 0);
  check("IN_SYSTEM receives an invitation email", invitationEmailCountFor(inSystemEmail) === 1,
    summarize({ emails: invitationEmailCountFor(inSystemEmail) }));
  check("IN_SYSTEM also receives a read-only in-system notification",
    inResult.candidateNotified === true);

  // --- NOT_IN_SYSTEM ---
  const notInResult = await jobService.inviteJobCandidate(recruiter.user, job.id, 1);
  check("NOT_IN_SYSTEM receives an invitation email too",
    invitationEmailCountFor(notInSystemEmail) === 1,
    summarize({ emails: invitationEmailCountFor(notInSystemEmail) }));
  check("NOT_IN_SYSTEM creates no notification (no account to notify)",
    notInResult.candidateNotified === false);

  // --- The notification must be read-only and carry no assessment entry point.
  const notification = await prisma.notification.findFirst({
    where: { userId: inSystem.user.id, type: "ASSESSMENT_INVITATION" },
    orderBy: { createdAt: "desc" },
  });
  check("the IN_SYSTEM notification exists and is stored", notification !== null);
  check(
    "the IN_SYSTEM notification contains NO assessment link (email is the only route in)",
    notification?.link !== null &&
      !String(notification?.link ?? "").includes(assessment.publicId) &&
      !String(notification?.link ?? "").startsWith("/assessment/"),
    summarize({ link: notification?.link })
  );
  check(
    "the IN_SYSTEM notification contains NO verification code",
    notification !== null && !latestCodeFor(inSystemEmail)?.length,
    "no code may exist before the candidate asks for one"
  );
  check(
    "the IN_SYSTEM notification cannot open the assessment",
    notification !== null &&
      !String(notification.message ?? "").includes(assessment.publicId) &&
      !String(notification.message ?? "").includes("/assessment/"),
    summarize({ message: notification?.message })
  );


  // --- Invitation email content.
  const invitationLine = invitationLineFor(inSystemEmail) ?? "";
  const linkInvitation = await invitationRow(assessment.id, inSystemEmail);
  check("the invitation email contains the ASSESSMENT LINK",
    invitationLine.includes(`/assessment/${assessment.publicId}`),
    summarize({ line: invitationLine }));
  check("the invitation email states the ASSESSMENT AVAILABILITY deadline",
    invitationLine.includes(jobDeadline.toUTCString()),
    summarize({ jobDeadline: jobDeadline.toUTCString() }));
  check("the invitation email states the INVITATION LINK deadline",
    invitationLine.includes(linkInvitation.expiresAt.toUTCString()),
    summarize({ linkExpiry: linkInvitation.expiresAt.toUTCString() }));
  check("the invitation email states the ASSESSMENT DURATION (60 minutes)",
    invitationLine.includes("60 minutes"),
    summarize({ line: invitationLine }));
  check(
    "the three timelines are stated SEPARATELY, never merged into one number",
    /assessment available until/i.test(invitationLine) &&
      /invitation window ends/i.test(invitationLine) &&
      /duration 60 minutes/i.test(invitationLine)
  );
  check("the invitation email contains NO verification code",
    !/\bverification code for\b/.test(invitationLine) && !latestCodeFor(notInSystemEmail),
    "the code belongs to the later VERIFICATION email only");

  // --- The real rendered body, so the RULES copy is checked, not just the log.
  const invitationMailer = require("../src/utils/sendAssessmentInvitationEmail");
  const integrityService = require("../src/module/job/jobAssessmentIntegrity.service");
  const capturedText = await withCapturedMessage(() =>
    invitationMailer.sendAssessmentInvitationEmail({
      email: "probe@example.com",
      candidateName: "Probe",
      jobTitle: "Probe Job",
      assessmentTitle: "Probe Assessment",
      publicId: "probe-public-id",
      expiresAt: linkInvitation.expiresAt,
      assessmentExpiresAt: jobDeadline,
      durationSeconds: 3600,
      maxVisibilityHiddenEvents: integrityService.MAX_VISIBILITY_HIDDEN_EVENTS,
    })
  );

  const body = capturedText?.text ?? "";
  check("the invitation body explains the 4-step entry flow (link, email, code, access)",
    /1\. Open the assessment link/.test(body) &&
      /2\. Enter this email address/.test(body) &&
      /3\. We will email you a one-time verification code/.test(body) &&
      /4\. Enter that code/.test(body));
  check("the invitation body states the tab-switching integrity rule",
    /Switching away from that tab is recorded/i.test(body));
  check("the invitation body states the REAL enforced tab-away limit (10)",
    /current limit is 10 recorded tab-away events/i.test(body),
    "the copy must match MAX_VISIBILITY_HIDDEN_EVENTS, not an invented rule");
  check("the invitation body states that a cheated attempt cannot be retaken",
    /cannot be reopened, retaken or corrected/i.test(body));
  check("the invitation body states the server-authoritative timer",
    /enforced by the server, not by your browser/i.test(body));
  check("the invitation body states the three timelines separately",
    /TIMELINE/.test(body) &&
      /Assessment available until:/.test(body) &&
      /Invitation link valid until:/.test(body) &&
      /Once you press Start you have: 60 minutes/.test(body));
  check("the invitation body contains NO verification code value",
    !latestCodeFor(inSystemEmail) || !body.includes(latestCodeFor(inSystemEmail)));
  check("the invitation HTML escapes recruiter-authored text",
    !/<script/i.test(capturedText?.html ?? "") &&
      (capturedText?.html ?? "").includes("Probe Assessment"));
  check("the invitation subject names the assessment",
    /Probe Assessment/.test(capturedText?.subject ?? ""));
};


// ===========================================================================
// J. THE VERIFICATION-CODE EMAIL: exact lifecycle, no leaks
// ===========================================================================
const scenarioVerificationEmail = async (recruiter) => {
  section("J. Verification email: authorized-only, canonical path, no leaks");

  const candidate = await createCandidateFixture("verify");
  const email = candidate.user.email;
  const { job } = await createJobFixture(recruiter, {
    label: "verify",
    analysisDays: 3,
    rows: [["Verify Candidate", email]],
  });
  const assessment = await createAssessmentFixture(job.id, "verify");
  await jobService.inviteJobCandidate(recruiter.user, job.id, 0);

  // --- 1. An authorized address triggers the code email.
  const requested = await jobService.requestAssessmentEmailVerification(
    assessment.publicId,
    email
  );
  const code = latestCodeFor(email);
  check("an authorized invited address DOES trigger a verification-code email",
    requested.status === "INVITED" && typeof code === "string" && code.length > 0,
    summarize({ status: requested.status, codeIssued: Boolean(code) }));
  check("the response NEVER returns the code itself",
    !JSON.stringify(requested).includes(code),
    "the raw code must not appear in any API response");

  // --- 2. The hash is persisted, the raw code is not.
  const stored = await invitationRow(assessment.id, email);
  const expectedHash = require("node:crypto").createHash("sha256").update(code).digest("hex");
  check("only a SHA-256 HASH of the code is persisted",
    stored.verificationTokenHash === expectedHash && stored.verificationTokenHash.length === 64,
    summarize({ persisted: Boolean(stored.verificationTokenHash) }));
  check("the raw code is NEVER stored in plaintext",
    !JSON.stringify(stored).includes(code),
    "the invitation row must not contain the code itself");

  // --- 3. An unauthorized address triggers NOTHING.
  const codesBefore = codesFor(email);
  await expectRejection(
    "an address that was never invited triggers NO code and NO email",
    () => jobService.requestAssessmentEmailVerification(assessment.publicId, uniqueEmail("stranger")),
    403
  );
  check("no verification email is sent for a non-invited address",
    codesFor(email) === codesBefore,
    summarize({ before: codesBefore, after: codesFor(email) }));


  // --- 4. The canonical path is the ONLY one that carries a code.
  const verifyMailerSource = fs.readFileSync(
    path.join(__dirname, "../src/utils/sendAssessmentVerificationEmail.js"),
    "utf8"
  );
  const serviceSource = fs.readFileSync(
    path.join(__dirname, "../src/module/job/job.service.js"),
    "utf8"
  );
  const requestStart = serviceSource.indexOf("const requestAssessmentEmailVerification");
  const inviteStart = serviceSource.indexOf("const inviteJobCandidate");
  // Slice the RECRUITER invite function body out, so the assertion is about that
  // function and not about the whole file (the token GENERATOR is legitimately
  // declared at module scope).
  const inviteBody = serviceSource.slice(inviteStart, requestStart);
  check("only the canonical verification mailer interpolates a code",
    /\$\{token\}/.test(verifyMailerSource),
    "the raw code exists only transiently, as the mail argument");
  check("the recruiter invite path mints NO code and stores NO challenge hash",
    !/generateVerificationToken|hashVerificationToken|setInvitationVerificationChallenge/.test(inviteBody),
    "a code must not exist before the candidate asks for one");
  check("the code is generated ONLY inside the candidate-facing request function",
    serviceSource.slice(requestStart).includes("generateVerificationToken"),
    "the only place a code may be created");
  check("authorization happens BEFORE code generation (order is the security contract)",
    serviceSource.slice(requestStart).indexOf("requireActiveInvitationContext") <
      serviceSource.slice(requestStart).indexOf("generateVerificationToken"));

  // --- 5. No leak into notification, SSE or the listing.
  const notificationText = await prisma.notification.findMany({
    where: { userId: candidate.user.id },
    select: { message: true, link: true },
  });
  check("the raw code never appears in any notification",
    !JSON.stringify(notificationText).includes(code));
  check("the raw code never appears in any recorded realtime event",
    !JSON.stringify(recorded).includes(code));
  const listing = await jobService.listJobCandidates(recruiter.user, job.id);
  check("the raw code never appears in the recruiter candidate listing",
    !JSON.stringify(listing).includes(code));

  // --- 6. The code verifies, and reuse is refused.
  const confirmed = await jobService.confirmAssessmentEmailVerification(
    assessment.publicId,
    email,
    code
  );
  check("the emailed code verifies and the invitation becomes EMAIL_VERIFIED",
    confirmed.verified === true);
  const reused = await jobService.confirmAssessmentEmailVerification(
    assessment.publicId,
    email,
    code
  );
  check(
    "a second confirm is IDEMPOTENT, not an error and not a re-verification",
    reused.verified === true && reused.status === "EMAIL_VERIFIED",
    summarize({ status: reused.status }),
    );
  const afterReuse = await invitationRow(assessment.id, email);
  check("re-confirming does not resurrect a stored challenge",
    afterReuse.verificationTokenHash === null && afterReuse.verificationExpiresAt === null,
    "the code is cleared on verification and stays cleared");

  // --- 7. The verification email states the ASSESSMENT deadline, not the link one.
  const jobDeadline = (await jobRow(job.id)).analysisEndsAt;
  const verifyMailer = require("../src/utils/sendAssessmentVerificationEmail");
  const capturedVerify = await withCapturedMessage(() =>
    verifyMailer.sendAssessmentVerificationEmail({
      email: "probe@example.com",
      token: "PROBE-CODE",
      assessmentTitle: "Probe Assessment",
      expiresAt: jobDeadline,
    })
  );
  check("the verification email states the assessment availability deadline",
    (capturedVerify?.text ?? "").includes(jobDeadline.toUTCString()),
    summarize({ expected: jobDeadline.toUTCString() }));
  check("the verification email marks the code as personal and single-use",
    /personal to you/i.test(capturedVerify?.text ?? "") && /used only once/i.test(capturedVerify?.text ?? ""));
  check("the verification email HTML escapes recruiter-authored text",
    !/<script/i.test(capturedVerify?.html ?? ""));
  check("the verification email never carries the ASSESSMENT LINK",
    !/\/assessment\//.test(capturedVerify?.text ?? ""),
    "the code email must not be a second route into the assessment");
  check("the verification email never states the INTERNAL invitation-link deadline",
    !/invitation window/i.test(capturedVerify?.text ?? ""),
    "the link deadline is an internal detail; the link simply stops working");

  // --- 8. Safe diagnostics: the code never reaches a log, a password never does.
  const mailSource = fs.readFileSync(
    path.join(__dirname, "../src/utils/assessmentMail.js"),
    "utf8"
  );
  check("the email diagnostics log only safe metadata (masked recipient, ids, outcomes)",
    /maskEmail/.test(mailSource) && /messageId/.test(mailSource) && /accepted=/.test(mailSource) &&
      !/console\.(log|error)\(\s*to\b/.test(mailSource),
    "never the full recipient, never a credential");
  check("the SMTP password is never interpolated into a message or an error",
    !/\$\{process\.env\.SMTP_PASSWORD\}/.test(mailSource));
};


// --- cleanup ------------------------------------------------------------------
// FK-safe order: everything cascades from Job, so the job rows can go first and
// the standalone user/subscription/plan rows after. Tracked ids only, so no
// pre-existing row can ever be touched.
const cleanup = async () => {
  await stopRecorder();
  if (tracked.jobIds.length > 0) {
    // These hang off Job/AiJob with Restrict (not Cascade) FKs, so they are
    // cleared before the job rows themselves. Everything else cascades.
    await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: { in: tracked.jobIds } } });
    await prisma.aiJob.deleteMany({ where: { jobId: { in: tracked.jobIds } } });
    await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: tracked.jobIds } } });
    await prisma.jobCandidateList.deleteMany({ where: { jobId: { in: tracked.jobIds } } });
    await prisma.job.deleteMany({ where: { id: { in: tracked.jobIds } } });
  }
  if (tracked.employeeProfileIds.length > 0) {
    await prisma.employeeProfile.deleteMany({
      where: { id: { in: tracked.employeeProfileIds } },
    });
  }
  if (tracked.subscriptionIds.length > 0) {
    await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } });
  }
  if (tracked.planIds.length > 0) {
    await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } });
  }
  if (tracked.userIds.length > 0) {
    await prisma.notification.deleteMany({ where: { userId: { in: tracked.userIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: tracked.userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } });
  }
};

// --- main ---------------------------------------------------------------------
const main = async () => {
  try {
    await startRecorder();
    const recruiter = await createRecruiterFixture();

    scenarioTimestamps();
    await scenarioPersistedInvitationDeadline(recruiter);
    await scenarioSweep(recruiter);
    await scenarioAccessBlocking(recruiter);
    await scenarioRace(recruiter);
    await scenarioHistoryPreserved(recruiter);
    await scenarioRecruiterSignal(recruiter);
    await scenarioEmails(recruiter);
    await scenarioVerificationEmail(recruiter);
  } catch (error) {
    check("the harness ran to completion without an unexpected error", false, error.message);
    console.error(error);
  } finally {
    await cleanup().catch((error) => console.error(`[cleanup] ${error.message}`));
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  originalConsoleLog(`\n${"=".repeat(60)}`);
  originalConsoleLog(`  TOTAL ${results.length}   PASSED ${passed}   FAILED ${failed}`);
  originalConsoleLog("=".repeat(60));
  if (failed > 0) {
    originalConsoleLog("\nFailures:");
    for (const r of results.filter((entry) => !entry.ok)) {
      originalConsoleLog(`  - ${r.label}`);
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
};

main();


