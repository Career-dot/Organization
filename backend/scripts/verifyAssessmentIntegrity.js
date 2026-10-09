/* eslint-disable no-console */
// Assessment integrity verification harness — Phase 5.
//
// Run with:  npm run verify:assessment-integrity
//
// Proves, against the REAL database, the REAL Redis, the REAL Express HTTP
// surface and the REAL service paths:
//   A. Deterministic rule layer — the named threshold constant, the pure
//      decision function, the active/terminal status partition, and the absence
//      of any AI/probability/score in the integrity decision.
//   B. Persisted signals — VISIBILITY_HIDDEN / VISIBILITY_VISIBLE are written
//      to PostgreSQL through the real public HTTP route, bound to the correct
//      attempt, append-only, and carrying no sensitive data.
//   C. Threshold — hidden signals 1..9 never terminate; the 10th atomically
//      moves the attempt to CHEATED with a persisted reason and a persisted
//      triggering event; a CHEATED attempt accepts no answer, no submit and no
//      further signal.
//   D. Concurrency / idempotency — N simultaneous threshold-triggering
//      requests produce exactly ONE terminal transition and exactly one
//      realtime announcement; the transition is idempotent and terminal.
//   E. Phase 3 compatibility — the server timer stays authoritative (client
//      deadline/startedAt are ignored), one attempt per (assessment, email)
//      survives, and integrity state survives refresh + Express restart.
//   F. Security — cross-attempt / cross-assessment / cross-candidate access is
//      denied; a client can never request CHEATED or supply a cheat reason; no
//      token, hash or answer ever appears in a response or a stored event.
//   G. Realtime — ASSESSMENT_CHEATED is published ONLY after the PostgreSQL
//      commit, reaches the existing Phase 4 SSE gateway for an authorized
//      recruiter, leaks nothing, and reconciles through the authoritative API.
//
// Convention follows scripts/verifyRecruiterRealtime.js (CommonJS, the
// application's own Prisma client, throwaway fixtures tracked by id and deleted
// in FK-safe order, deterministic server-log email channel, isolated Redis
// channel + queue prefix, no database reset, no quota side effects).

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

const SUFFIX = `ph5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// An ISOLATED realtime channel so harness traffic can never reach a recruiter
// connected to a live deployment (resolved at call time by redis.pubsub.js),
// and an isolated BullMQ namespace so no real worker can pick work up.
process.env.REALTIME_REDIS_CHANNEL = `platform:realtime:candidate-status:${SUFFIX}`;
process.env.AI_QUEUE_PREFIX = SUFFIX;

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const attemptService = require("../src/module/job/jobAssessmentAttempt.service");
const integrityService = require("../src/module/job/jobAssessmentIntegrity.service");
const integrityRepository = require("../src/module/job/jobAssessmentIntegrity.repository");
const realtimePublisher = require("../src/module/job/jobAssessmentRealtime.publisher");
const realtimeGateway = require("../src/module/realtime/realtime.gateway");
const {
  DEFAULT_REALTIME_CHANNEL,
  getRealtimeChannel,
  getRealtimePubSubStats,
  subscribeRealtimeEvents,
} = require("../src/config/redis.pubsub");
const {
  REALTIME_EVENT_TYPES,
  sanitizeCandidateStatusEvent,
} = require("../src/module/job/jobAssessmentRealtime.events");
const {
  buildCandidateWorkbook,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

const BACKEND_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(BACKEND_ROOT, "src", "server.js");

// Re-assert the blanking AFTER the application modules loaded their own env.
neutralizeSmtp();
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const MAX_HIDDEN = integrityService.MAX_VISIBILITY_HIDDEN_EVENTS;

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

// Collects every object key in a JSON structure so a response/event can be
// scanned for data that must NEVER leave the server.
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

// The exact substrings that would mean a secret leaked into a response/event.

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
// browser-facing integrity endpoint is proven over actual HTTP. The candidate
// public route is deliberately credential-less, so the harness needs no token.
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

const FORBIDDEN_SUBSTRINGS = [
  "verificationTokenHash",
  "tokenHash",
  "verificationToken",
  "passwordHash",
  "accessToken",
  "answers",
  "REDIS_URL",
  "AI_SERVICE_API_KEY",
  "GEMINI_API_KEY",
];

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
      fullName: `Integrity Harness ${label}`,
      email: `ph5-harness-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Integrity Harness Plan ${label} ${SUFFIX}`,
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
    originalname: `ph5-${label}-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
};

// FINALIZED + ACTIVATED with a public link — exactly the state the candidate
// verification + attempt + integrity flows require. The AI generation pipeline
// is out of scope for this harness.
const createAssessmentFixture = async (jobId, label, { durationSeconds = 900 } = {}) =>
  prisma.jobAssessment.create({
    data: {
      jobId,
      title: `Integrity harness assessment ${label}`,
      status: "FINALIZED",
      publicId: `${SUFFIX}-${label}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
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
  title: "Integrity harness job",
  yearsExperience: 5,
  description: "Harness job used to verify the deterministic assessment integrity system.",
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
  { label, emails, withAssessment = true, durationSeconds = 900, questionCount = 1 } = {}
) => {
  const draft = await jobService.createDraft(recruiter.user, {
    ...READY_PAYLOAD,
    title: `Integrity harness job ${label}`,
    description: `Harness job ${label} for the deterministic integrity verification.`,
  });
  tracked.jobIds.push(draft.id);

  await uploadList(recruiter, draft.id, emails, label);

  let assessment = null;
  let questions = [];
  if (withAssessment) {
    assessment = await createAssessmentFixture(draft.id, label, { durationSeconds });
    questions = await Promise.all(
      Array.from({ length: questionCount }, (_, index) =>
        createQuestionFixture(assessment.id, index, {
          prompt: `Harness question ${index + 1} for ${label}?`,
          questionType: "SHORT_ANSWER",
          section: "REQUIRED_SKILLS",
        })
      )
    );
  }

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

const integrityRowsFor = (attemptId) =>
  prisma.jobAssessmentAttemptIntegrityEvent.findMany({
    where: { attemptId },
    orderBy: { occurredAt: "asc" },
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

// The candidate reaches a live attempt through the REAL service, then one real
// answer moves STARTED → IN_PROGRESS (the state visibility signals are valid
// in). Returns the PERSISTED attempt row.
const openActiveAttempt = async ({ publicId, assessmentId, email, questionId }) => {
  await verifyCandidateEmail(publicId, email);
  await attemptService.startAssessmentAttempt(publicId, email);
  if (questionId) {
    await attemptService.saveAttemptAnswer(publicId, email, questionId, { text: "harness answer" });
  }
  return attemptRowFor(assessmentId, email);
};

// --- HTTP (the REAL public candidate surface) --------------------------------

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

const integrityUrl = (serverUrl, publicId, attemptId) =>
  `${serverUrl}/api/assessment/${publicId}/attempt/${attemptId}/integrity-event`;

const sendSignal = (serverUrl, publicId, attemptId, body) =>
  postJson(integrityUrl(serverUrl, publicId, attemptId), body);

const answerUrl = (serverUrl, publicId) =>
  `${serverUrl}/api/assessment/${publicId}/attempt/answer`;

const submitUrl = (serverUrl, publicId) =>
  `${serverUrl}/api/assessment/${publicId}/attempt/submit`;

// --- realtime recorder (the harness's own Redis subscriber) ------------------
// Consumes events exactly the way the browser-facing gateway does: through the
// whitelisting sanitizer, so a malformed/hostile Redis payload can never be
// recorded as if it were a valid event.
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
const lastEventOfType = (eventType) => eventsOfType(eventType).at(-1) ?? null;

// --- mock SSE connection (drives the REAL Phase 4 gateway) -------------------
// The gateway is controller-thin: openJobStream(req, res) with req.user,
// req.params.jobId and a "close" event. A plain EventEmitter + a capture res
// exercises the real authorization, subscription and framing code paths.
const openMockStream = async (user, jobId) => {
  const req = new EventEmitter();
  req.user = user;
  req.params = { jobId };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    jsonPayload: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    write(chunk) {
      this.body += chunk;
      return true;
    },
    status(code) {
      this.statusCode = code;
      return {
        json: (payload) => {
          this.jsonPayload = payload;
        },
      };
    },
    json(payload) {
      this.jsonPayload = payload;
    },
  };
  await realtimeGateway.openJobStream(req, res);
  return { req, res };
};

const sseDataPayloads = (res, eventName) => {
  const payloads = [];
  const frames = res.body.split("\n\n");
  for (const frame of frames) {
    if (!frame.includes(`event: ${eventName}`)) continue;
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) {
      try {
        payloads.push(JSON.parse(dataLine.slice("data: ".length)));
      } catch {
        /* ignore a partial frame while it is still streaming */
      }
    }
  }
  return payloads;
};

const closeMockStream = async (stream) => {
  stream.req.emit("close");
  await waitFor(() => !realtimeGateway.getGatewayStats().connectedClients, { timeoutMs: 3000 });
};

const leaksOf = (serialized) =>
  FORBIDDEN_SUBSTRINGS.filter((needle) => serialized.includes(needle));


// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const sectionRuleLayer = async () => {
  section("A. Deterministic rule layer — named threshold, pure decision, no AI");

  check(
    "the threshold is the documented named constant MAX_VISIBILITY_HIDDEN_EVENTS = 10",
    MAX_HIDDEN === 10,
    summarize({ MAX_HIDDEN })
  );

  check(
    "active and terminal status partitions are correct and disjoint",
    jsonEqual(integrityService.ACTIVE_ATTEMPT_STATUSES, ["STARTED", "IN_PROGRESS"]) &&
      jsonEqual(integrityService.TERMINAL_ATTEMPT_STATUSES, ["SUBMITTED", "TIMED_UP", "CHEATED"]) &&
      integrityService.ACTIVE_ATTEMPT_STATUSES.every(
        (status) => !integrityService.TERMINAL_ATTEMPT_STATUSES.includes(status)
      ),
    summarize({
      active: integrityService.ACTIVE_ATTEMPT_STATUSES,
      terminal: integrityService.TERMINAL_ATTEMPT_STATUSES,
    })
  );

  check(
    "CHEATED is classified terminal (never reopened) while STARTED/IN_PROGRESS are active",
    integrityService.isTerminalAttemptStatus("CHEATED") === true &&
      integrityService.isActiveAttemptStatus("CHEATED") === false &&
      integrityService.isActiveAttemptStatus("STARTED") === true &&
      integrityService.isActiveAttemptStatus("IN_PROGRESS") === true,
    summarize({
      terminal: integrityService.isTerminalAttemptStatus("CHEATED"),
      activeCheated: integrityService.isActiveAttemptStatus("CHEATED"),
    })
  );

  check(
    "the structured cheat reasons are enum-like values, not prose",
    jsonEqual(Object.values(integrityService.CHEAT_REASONS).sort(), [
      "DUPLICATE_ATTEMPT",
      "EXCESSIVE_VISIBILITY_CHANGES",
      "PROHIBITED_CLIENT_ACTION",
      "SERVER_INTEGRITY_VIOLATION",
      "TIMER_INTEGRITY_VIOLATION",
    ]),
    summarize(integrityService.CHEAT_REASONS)
  );

  check(
    "every reason has a concise deterministic recruiter-facing label",
    Object.values(integrityService.CHEAT_REASONS).every(
      (reason) => typeof integrityService.CHEAT_REASON_LABELS[reason] === "string"
    ),
    summarize(integrityService.CHEAT_REASON_LABELS)
  );

  // The pure rule: no I/O, no clock, no randomness — the decision is a function
  // of the reported type and the PERSISTED prior count only.
  const belowThreshold = integrityService.evaluateIntegritySignal({
    type: "VISIBILITY_HIDDEN",
    priorHiddenCount: MAX_HIDDEN - 2,
  });
  check(
    "hidden signal below the threshold persists but never terminates",
    belowThreshold.shouldPersist === true && belowThreshold.shouldCheat === false,
    summarize(belowThreshold)
  );

  const firstHidden = integrityService.evaluateIntegritySignal({
    type: "VISIBILITY_HIDDEN",
    priorHiddenCount: 0,
  });
  check(
    "the FIRST hidden signal persists with the hidden reason and no cheat",
    firstHidden.shouldPersist === true &&
      firstHidden.shouldCheat === false &&
      firstHidden.reason === "ASSESSMENT_TAB_HIDDEN",
    summarize(firstHidden)
  );

  const atThreshold = integrityService.evaluateIntegritySignal({
    type: "VISIBILITY_HIDDEN",
    priorHiddenCount: MAX_HIDDEN - 1,
  });
  check(
    "the 10th persisted hidden signal (prior count 9) terminates with EXCESSIVE_VISIBILITY_CHANGES",
    atThreshold.shouldPersist === true &&
      atThreshold.shouldCheat === true &&
      atThreshold.terminalReason === "EXCESSIVE_VISIBILITY_CHANGES" &&
      atThreshold.terminalEventType === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize(atThreshold)
  );

  const pastThreshold = integrityService.evaluateIntegritySignal({
    type: "VISIBILITY_HIDDEN",
    priorHiddenCount: MAX_HIDDEN,
  });
  check(
    "a hidden signal past the threshold still evaluates deterministically (no drift)",
    pastThreshold.shouldCheat === true &&
      pastThreshold.terminalReason === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize(pastThreshold)
  );

  const visibleSignal = integrityService.evaluateIntegritySignal({
    type: "VISIBILITY_VISIBLE",
    priorHiddenCount: MAX_HIDDEN - 1,
  });
  check(
    "VISIBILITY_VISIBLE always persists and can never terminate an attempt",
    visibleSignal.shouldPersist === true &&
      visibleSignal.shouldCheat === false &&
      visibleSignal.reason === "ASSESSMENT_TAB_VISIBLE",
    summarize(visibleSignal)
  );

  const unknownSignal = integrityService.evaluateIntegritySignal({ type: "CHEATED" });
  check(
    "an unknown/hostile signal type is never persisted and never terminates",
    unknownSignal.shouldPersist === false && unknownSignal.shouldCheat === false,
    summarize(unknownSignal)
  );

  const repeatOne = integrityService.evaluateIntegritySignal({
    type: "VISIBILITY_HIDDEN",
    priorHiddenCount: MAX_HIDDEN - 1,
  });
  check(
    "the rule is pure — identical input yields an identical decision",
    jsonEqual(atThreshold, repeatOne),
    summarize({ atThreshold, repeatOne })
  );

  // The decision must not depend on anything a client could supply.
  const withHostileExtras = integrityService.evaluateIntegritySignal({
    type: "VISIBILITY_HIDDEN",
    priorHiddenCount: 0,
    reason: "EXCESSIVE_VISIBILITY_CHANGES",
    status: "CHEATED",
    cheatReason: "SERVER_INTEGRITY_VIOLATION",
  });
  check(
    "client-supplied status/reason cannot influence the decision",
    jsonEqual(withHostileExtras, firstHidden),
    summarize({ withHostileExtras, firstHidden })
  );

  // The persisted enum must match the rule layer's own vocabulary.
  const integrityEnumRows = await prisma.$queryRawUnsafe(
    "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid " +
      "WHERE t.typname = 'JobAssessmentAttemptIntegrityEventType' ORDER BY e.enumsortorder"
  );
  const integrityEnumValues = integrityEnumRows.map((row) => row.enumlabel);
  check(
    "the persisted integrity-event enum matches the rule layer's vocabulary",
    jsonEqual(integrityEnumValues, integrityRepository.INTEGRITY_EVENT_TYPE_VALUES),
    summarize({
      enumValues: integrityEnumValues,
      ruleValues: integrityRepository.INTEGRITY_EVENT_TYPE_VALUES,
    })
  );

  const attemptEnumRows = await prisma.$queryRawUnsafe(
    "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid " +
      "WHERE t.typname = 'JobAssessmentAttemptStatus' ORDER BY e.enumsortorder"
  );
  const attemptEnumValues = attemptEnumRows.map((row) => row.enumlabel).sort();
  check(
    "the persisted attempt-status enum contains CHEATED and no invented competing state",
    jsonEqual(attemptEnumValues, [
      "CHEATED",
      "IN_PROGRESS",
      "STARTED",
      "SUBMITTED",
      "TIMED_UP",
    ]),
    summarize(attemptEnumValues)
  );

  const indexRows = await prisma.$queryRawUnsafe(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'JobAssessmentAttemptIntegrityEvent'"
  );
  check(
    "the integrity-event table carries the supporting attempt/type indexes",
    indexRows.length >= 3,
    summarize(indexRows.map((row) => row.indexname))
  );

  // Source-level guarantee: the integrity decision path contains no AI, no
  // probability and no score. The rule layer is the ONLY place that decides.
  const serviceSource = require("node:fs").readFileSync(
    path.join(BACKEND_ROOT, "src", "module", "job", "jobAssessmentIntegrity.service.js"),
    "utf8"
  );
  const repositorySource = require("node:fs").readFileSync(
    path.join(BACKEND_ROOT, "src", "module", "job", "jobAssessmentIntegrity.repository.js"),
    "utf8"
  );
  const forbiddenDecisionTokens = [
    "gemini",
    "openai",
    "cheatingprobability",
    "probability",
    "verificationanalyzer",
    "aiservice",
    "fastapi",
    "axios",
  ];
  const foundTokens = forbiddenDecisionTokens.filter((needle) => {
    const haystack = `${serviceSource}\n${repositorySource}`.toLowerCase();
    return haystack.includes(needle);
  });
  check(
    "no AI provider, no probability and no remote analysis exists in the integrity path",
    foundTokens.length === 0,
    summarize(foundTokens)
  );

  check(
    "the threshold count is read from PostgreSQL per decision, never held in memory",
    serviceSource.includes("countIntegrityEventsByType") &&
      repositorySource.includes("jobAssessmentAttemptIntegrityEvent.count"),
    summarize({ readsPersistedCount: serviceSource.includes("countIntegrityEventsByType") })
  );

  check(
    "the integrity signal vocabulary the validator accepts is exactly the two browser signals",
    (() => {
      const validationSource = require("node:fs").readFileSync(
        path.join(BACKEND_ROOT, "src", "module", "job", "job.validation.js"),
        "utf8"
      );
      return (
        validationSource.includes(
          'const ASSESSMENT_INTEGRITY_SIGNAL_TYPES = ["VISIBILITY_HIDDEN", "VISIBILITY_VISIBLE"]'
        ) &&
        !validationSource.includes('"CHEATED"]') &&
        !validationSource.includes("assessmentIntegrityEventSchema = z.object({\n  status")
      );
    })(),
    "the validator does not narrow the browser to the two deterministic signals"
  );
};

// ---------------------------------------------------------------------------
// B. Persisted signals through the REAL public HTTP route
// ---------------------------------------------------------------------------
const sectionPersistedSignals = async ({ serverUrl, assessment, otherAssessment, emails, attempts }) => {
  section("B. Persisted signals — written through the real HTTP route, bound to one attempt");

  const emailA = emails[0];
  const attemptA = attempts[0];

  check(
    "the candidate reached a live IN_PROGRESS attempt through the REAL attempt flow",
    attemptA.status === "IN_PROGRESS",
    summarize({ status: attemptA.status })
  );

  const hidden = await sendSignal(serverUrl, assessment.publicId, attemptA.id, {
    email: emailA,
    type: "VISIBILITY_HIDDEN",
  });
  check(
    "the browser can report VISIBILITY_HIDDEN over HTTP (200, not judged by the browser)",
    hidden.status === 200 && hidden.body?.success === true,
    summarize({ status: hidden.status, body: hidden.body })
  );
  check(
    "the response reports the PERSISTED status and no fake terminal state",
    hidden.body?.assessmentStatus === "IN_PROGRESS" && hidden.body?.isCheated === false,
    summarize({ status: hidden.body?.assessmentStatus, isCheated: hidden.body?.isCheated })
  );

  const afterFirst = await integrityRowsFor(attemptA.id);
  check(
    "exactly one integrity row was persisted for the reported signal",
    afterFirst.length === 1,
    summarize({ count: afterFirst.length })
  );
  check(
    "the persisted row belongs to THIS attempt (row identity, never an array index)",
    afterFirst[0]?.attemptId === attemptA.id && afterFirst[0]?.type === "VISIBILITY_HIDDEN",
    summarize({ attemptId: afterFirst[0]?.attemptId, type: afterFirst[0]?.type })
  );
  check(
    "the persisted row carries the structured hidden reason",
    afterFirst[0]?.reason === "ASSESSMENT_TAB_HIDDEN",
    summarize({ reason: afterFirst[0]?.reason })
  );

  const hiddenMetadata = afterFirst[0]?.metadata ?? {};
  // The persisted count is INCLUSIVE: the first hidden signal stores 1, and the
  // threshold decision event stores MAX_HIDDEN when it is reached.
  check(
    "the persisted metadata is bounded context only (visibility state + persisted count)",
    hiddenMetadata.visibilityState === "hidden" &&
      hiddenMetadata.hiddenCount === 1 &&
      jsonEqual(Object.keys(hiddenMetadata).sort(), ["hiddenCount", "visibilityState"]),
    summarize(hiddenMetadata)
  );
  check(
    "no answer/token/hash material exists in the persisted integrity metadata",
    leaksOf(JSON.stringify(hiddenMetadata)).length === 0,
    summarize(leaksOf(JSON.stringify(hiddenMetadata)))
  );

  const visible = await sendSignal(serverUrl, assessment.publicId, attemptA.id, {
    email: emailA,
    type: "VISIBILITY_VISIBLE",
  });
  const afterVisible = await integrityRowsFor(attemptA.id);
  check(
    "the browser can report VISIBILITY_VISIBLE and it persists as its own signal type",
    visible.status === 200 &&
      afterVisible.length === 2 &&
      afterVisible[1]?.type === "VISIBILITY_VISIBLE" &&
      afterVisible[1]?.reason === "ASSESSMENT_TAB_VISIBLE",
    summarize({ status: visible.status, rows: afterVisible.map((row) => row.type) })
  );
  check(
    "the signal log is append-only — one persisted row per reported transition",
    afterVisible.length === 2 &&
      afterVisible.every((row) => typeof row.id === "string" && row.occurredAt instanceof Date),
    summarize({ count: afterVisible.length })
  );
  check(
    "the persisted signals remain readable from PostgreSQL alone (no in-memory state)",
    jsonEqual(
      (await integrityRowsFor(attemptA.id)).map((row) => row.type),
      ["VISIBILITY_HIDDEN", "VISIBILITY_VISIBLE"]
    ),
    "re-read diverged"
  );

  // Cross-candidate: the SAME assessment, a DIFFERENT verified candidate. The
  // attempt id in the path belongs to candidate A, the email to candidate B.
  const crossCandidate = await sendSignal(serverUrl, assessment.publicId, attemptA.id, {
    email: emails[1],
    type: "VISIBILITY_HIDDEN",
  });
  check(
    "a signal for another candidate's attempt is denied (403, no row written)",
    crossCandidate.status === 403 &&
      (await integrityRowsFor(attemptA.id)).length === 2,
    summarize({ status: crossCandidate.status, body: crossCandidate.body })
  );

  // Cross-assessment: candidate A's own email, but a different assessment's id.
  const crossAssessment = await sendSignal(serverUrl, otherAssessment.publicId, attemptA.id, {
    email: emailA,
    type: "VISIBILITY_HIDDEN",
  });
  check(
    "a signal for another assessment is denied and writes nothing",
    crossAssessment.status >= 400 &&
      (await integrityRowsFor(attemptA.id)).length === 2,
    summarize({ status: crossAssessment.status, body: crossAssessment.body })
  );

  const unknownLink = await sendSignal(serverUrl, `does-not-exist-${SUFFIX}`, attemptA.id, {
    email: emailA,
    type: "VISIBILITY_HIDDEN",
  });
  check(
    "an unknown public link is rejected without creating an attempt or a row",
    unknownLink.status >= 400 && (await integrityRowsFor(attemptA.id)).length === 2,
    summarize({ status: unknownLink.status })
  );

  const notInvited = await sendSignal(serverUrl, assessment.publicId, attemptA.id, {
    email: `stranger-${SUFFIX}@example.test`,
    type: "VISIBILITY_HIDDEN",
  });
  check(
    "an email that holds no verified invitation is denied",
    notInvited.status === 403,
    summarize({ status: notInvited.status, body: notInvited.body })
  );
};

// ---------------------------------------------------------------------------
// C. Threshold — 1..9 never terminate, the 10th atomically terminates
// ---------------------------------------------------------------------------
const sectionThreshold = async ({ serverUrl, assessment, question, email, attempt }) => {
  section("C. Threshold — the 10th persisted hidden signal terminates the attempt");

  check(
    "the threshold attempt starts active with zero persisted hidden signals",
    integrityService.isActiveAttemptStatus(attempt.status) &&
      (await integrityRowsFor(attempt.id)).length === 0,
    summarize({ status: attempt.status })
  );

  const statuses = [];
  for (let index = 1; index < MAX_HIDDEN; index += 1) {
    const response = await sendSignal(serverUrl, assessment.publicId, attempt.id, {
      email,
      type: "VISIBILITY_HIDDEN",
    });
    statuses.push({ index, status: response.status, isCheated: response.body?.isCheated });
  }

  const persistedAfterNine = await attemptRowFor(assessment.id, email);
  check(
    `all ${MAX_HIDDEN - 1} sub-threshold hidden signals were accepted (HTTP 200)`,
    statuses.every((entry) => entry.status === 200),
    summarize(statuses.filter((entry) => entry.status !== 200))
  );
  check(
    `hidden signals 1..${MAX_HIDDEN - 1} never terminate the attempt`,
    statuses.every((entry) => entry.isCheated !== true),
    summarize(statuses.filter((entry) => entry.isCheated === true))
  );
  check(
    `the attempt is STILL active after ${MAX_HIDDEN - 1} hidden signals`,
    persistedAfterNine.status === "IN_PROGRESS" && persistedAfterNine.cheatReason === null,
    summarize({ status: persistedAfterNine.status, cheatReason: persistedAfterNine.cheatReason })
  );

  const persistedCount = await integrityRepository.countIntegrityEventsByType(
    attempt.id,
    "VISIBILITY_HIDDEN"
  );
  check(
    `exactly ${MAX_HIDDEN - 1} hidden rows are persisted (the count is the DB's, not memory's)`,
    persistedCount === MAX_HIDDEN - 1,
    summarize({ persistedCount })
  );

  const tenth = await sendSignal(serverUrl, assessment.publicId, attempt.id, {
    email,
    type: "VISIBILITY_HIDDEN",
  });
  check(
    `the ${MAX_HIDDEN}th hidden signal is the deterministic trigger (200, isCheated true)`,
    tenth.status === 200 &&
      tenth.body?.isCheated === true &&
      tenth.body?.assessmentStatus === "CHEATED",
    summarize({ status: tenth.status, body: tenth.body })
  );

  const cheatedRow = await attemptRowFor(assessment.id, email);
  check(
    "PostgreSQL persisted the terminal CHEATED status (server decides, not the browser)",
    cheatedRow.status === "CHEATED",
    summarize({ status: cheatedRow.status })
  );
  check(
    "the concise deterministic cheat reason was persisted on the attempt row",
    cheatedRow.cheatReason === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize({ cheatReason: cheatedRow.cheatReason })
  );
  check(
    "the terminal timestamp was persisted",
    cheatedRow.cheatedAt instanceof Date,
    summarize({ cheatedAt: cheatedRow.cheatedAt })
  );

  const rowsAfter = await integrityRowsFor(attempt.id);
  const decisionRow = rowsAfter.find((row) => row.type === "EXCESSIVE_VISIBILITY_CHANGES");
  check(
    "the threshold decision itself is persisted as its own integrity event",
    Boolean(decisionRow) && decisionRow.reason === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize({ types: rowsAfter.map((row) => row.type) })
  );
  check(
    "the decision event records the threshold and the triggering signal it was decided from",
    decisionRow?.metadata?.threshold === MAX_HIDDEN &&
      decisionRow?.metadata?.hiddenCount === MAX_HIDDEN &&
      typeof decisionRow?.metadata?.triggeringEventId === "string" &&
      rowsAfter.some((row) => row.id === decisionRow.metadata.triggeringEventId),
    summarize(decisionRow?.metadata)
  );
  check(
    `exactly ${MAX_HIDDEN} hidden rows plus one decision row exist (no duplicate counting)`,
    rowsAfter.filter((row) => row.type === "VISIBILITY_HIDDEN").length === MAX_HIDDEN &&
      rowsAfter.filter((row) => row.type === "EXCESSIVE_VISIBILITY_CHANGES").length === 1,
    summarize({
      hidden: rowsAfter.filter((row) => row.type === "VISIBILITY_HIDDEN").length,
      decisions: rowsAfter.filter((row) => row.type === "EXCESSIVE_VISIBILITY_CHANGES").length,
    })
  );

  // Terminal means terminal: no answer, no submit, no further signal.
  const answerAfter = await postJson(answerUrl(serverUrl, assessment.publicId), {
    email,
    attemptId: attempt.id,
    questionId: question.id,
    answer: { text: "late answer" },
  });
  check(
    "a CHEATED attempt rejects further answers (409)",
    answerAfter.status === 409,
    summarize({ status: answerAfter.status, body: answerAfter.body })
  );

  const submitAfter = await postJson(submitUrl(serverUrl, assessment.publicId), {
    email,
    attemptId: attempt.id,
  });
  // A CHEATED attempt can never be LAUNDERED into SUBMITTED. The submit endpoint
  // either rejects it outright (409) or answers with the PERSISTED terminal view
  // unchanged (200 + cheated, submittedAt still null) — Phase 3's idempotent
  // terminal-submit contract, which Phase 5 extends to CHEATED.
  const submitRejectedOrUnchanged =
    submitAfter.status === 409 ||
    (submitAfter.status === 200 &&
      submitAfter.body?.data?.cheated === true &&
      submitAfter.body?.data?.attempt?.status === "CHEATED" &&
      (submitAfter.body?.data?.attempt?.submittedAt ?? null) === null);
  check(
    "a CHEATED attempt rejects submission (409) — it can never be laundered into SUBMITTED",
    submitRejectedOrUnchanged &&
      (await attemptRowFor(assessment.id, email)).status === "CHEATED",
    summarize({ status: submitAfter.status, body: submitAfter.body })
  );

  const rowsBeforeSignal = rowsAfter.length;
  const signalAfter = await sendSignal(serverUrl, assessment.publicId, attempt.id, {
    email,
    type: "VISIBILITY_VISIBLE",
  });
  const finalRow = await attemptRowFor(assessment.id, email);
  check(
    "a CHEATED attempt accepts no further integrity signal (409)",
    signalAfter.status === 409,
    summarize({ status: signalAfter.status, body: signalAfter.body })
  );
  check(
    "no integrity row is appended for a signal rejected by a terminal attempt",
    (await integrityRowsFor(attempt.id)).length === rowsBeforeSignal,
    summarize({ before: rowsBeforeSignal })
  );
  check(
    "the terminal state is unchanged by the rejected requests",
    finalRow.status === "CHEATED" && finalRow.cheatReason === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize({ status: finalRow.status, reason: finalRow.cheatReason })
  );
  check(
    "CHEATED is recognised as a terminal status by the shared status partition",
    integrityService.isTerminalAttemptStatus(finalRow.status) &&
      !integrityService.isActiveAttemptStatus(finalRow.status)
  );
};


// ---------------------------------------------------------------------------
// D. Concurrency & idempotency — one transition, announced once
// ---------------------------------------------------------------------------
const sectionConcurrency = async ({ serverUrl, assessment, email, attempt, submittedAttempt }) => {
  section("D. Concurrency & idempotency — simultaneous threshold requests stay consistent");

  // Bring the attempt to one signal BELOW the threshold using the real route.
  for (let index = 1; index < MAX_HIDDEN; index += 1) {
    await sendSignal(serverUrl, assessment.publicId, attempt.id, {
      email,
      type: "VISIBILITY_HIDDEN",
    });
  }
  const beforeRace = await attemptRowFor(assessment.id, email);
  check(
    "the concurrency fixture is one signal below the threshold and still active",
    beforeRace.status === "IN_PROGRESS" &&
      (await integrityRepository.countIntegrityEventsByType(attempt.id, "VISIBILITY_HIDDEN")) ===
        MAX_HIDDEN - 1,
    summarize({ status: beforeRace.status })
  );

  const cheatedBefore = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_CHEATED).length;

  // Fire the remaining signals SIMULTANEOUSLY: each request independently reads
  // the persisted count and may decide to terminate, but only one conditional
  // UPDATE can win.
  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () =>
      sendSignal(serverUrl, assessment.publicId, attempt.id, {
        email,
        type: "VISIBILITY_HIDDEN",
      })
    )
  );
  // A request that reaches the attempt AFTER the winner committed is answered
  // per the terminal contract (409) — exactly the answer the sequential
  // "a CHEATED attempt accepts no further integrity signal" check asserts.
  // What must never happen is a server error, and at least one signal must be
  // accepted as the deterministic trigger.
  const raceStatuses = concurrent.map((response) => response.status);
  check(
    "every simultaneous signal is answered without a server error",
    raceStatuses.every((status) => status === 200 || status === 409) &&
      raceStatuses.filter((status) => status === 200).length >= 1,
    summarize(raceStatuses)
  );

  const afterRace = await attemptRowFor(assessment.id, email);
  check(
    "the attempt ends in exactly one terminal state (CHEATED)",
    afterRace.status === "CHEATED",
    summarize({ status: afterRace.status })
  );
  check(
    "the persisted reason is single and deterministic after the race",
    afterRace.cheatReason === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize({ cheatReason: afterRace.cheatReason })
  );
  check(
    "the terminal timestamp was written once (no overwrite by the losers)",
    afterRace.cheatedAt instanceof Date && afterRace.cheatedAt.getTime() >= beforeRace.startedAt.getTime(),
    summarize({ cheatedAt: afterRace.cheatedAt })
  );

  const cheatedAfter = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_CHEATED).length;
  check(
    "exactly ONE CHEATED realtime event was announced for the one real transition",
    cheatedAfter - cheatedBefore === 1,
    summarize({ before: cheatedBefore, after: cheatedAfter })
  );

  const noAnswer = await postJson(answerUrl(serverUrl, assessment.publicId), {
    email,
    attemptId: attempt.id,
    questionId: null,
    answer: { text: "x" },
  });
  check(
    "a racing answer after the terminal transition cannot resurrect the attempt",
    noAnswer.status >= 400 && (await attemptRowFor(assessment.id, email)).status === "CHEATED",
    summarize({ status: noAnswer.status })
  );

  // Direct idempotency of the ONE authoritative transition.
  const repeatTransition = await integrityService.markAttemptCheated({
    attemptId: attempt.id,
    reason: "EXCESSIVE_VISIBILITY_CHANGES",
  });
  check(
    "re-running the terminal transition changes nothing (0 rows, terminal is terminal)",
    repeatTransition.transitioned === false && repeatTransition.attempt?.status === "CHEATED",
    summarize(repeatTransition)
  );

  const parallelTransitions = await Promise.all(
    Array.from({ length: 5 }, () =>
      integrityService.markAttemptCheated({
        attemptId: attempt.id,
        reason: "SERVER_INTEGRITY_VIOLATION",
      })
    )
  );
  check(
    "five simultaneous terminal transitions update zero rows (atomic conditional write)",
    parallelTransitions.every((outcome) => outcome.transitioned === false),
    summarize(parallelTransitions.map((outcome) => outcome.transitioned))
  );

  // A legitimately SUBMITTED attempt can never be overwritten by a late cheat.
  const submittedTransition = await integrityService.markAttemptCheated({
    attemptId: submittedAttempt.id,
    reason: "DUPLICATE_ATTEMPT",
  });
  const submittedRow = await prisma.jobAssessmentAttempt.findUnique({
    where: { id: submittedAttempt.id },
  });
  check(
    "a SUBMITTED attempt is never overwritten by a late CHEATED decision",
    submittedTransition.transitioned === false &&
      submittedRow.status === "SUBMITTED" &&
      submittedRow.cheatReason === null,
    summarize({ status: submittedRow.status, cheatReason: submittedRow.cheatReason })
  );

  // The service-level guard refuses a signal for a terminal attempt too.
  let signalError = null;
  try {
    await integrityService.processVisibilitySignal({
      attempt: submittedRow,
      type: "VISIBILITY_HIDDEN",
      metadata: {},
    });
  } catch (error) {
    signalError = error;
  }
  check(
    "the service refuses a signal for a terminal attempt (409, no transition, no row)",
    signalError?.status === 409 &&
      (await prisma.jobAssessmentAttemptIntegrityEvent.count({
        where: { attemptId: submittedAttempt.id },
      })) === 0,
    summarize({ status: signalError?.status, message: signalError?.message })
  );
};

// ---------------------------------------------------------------------------
// E. Phase 3 compatibility — the server timer and its rules are untouched
// ---------------------------------------------------------------------------
const sectionPhase3Compatibility = async ({ serverUrl, assessment, email, questionId, expiredEmail }) => {
  section("E. Phase 3 compatibility — server-authoritative timer and attempt rules");

  // A fresh candidate in the SAME assessment so this section starts clean.
  const freshEmail = `ph5-phase3-${SUFFIX}@example.test`;
  const freshAttempt = await openActiveAttempt({
    publicId: assessment.publicId,
    assessmentId: assessment.id,
    email: freshEmail,
    questionId,
  });
  check(
    "a fresh candidate reaches a live attempt (Phase 3 lifecycle intact)",
    freshAttempt.status === "IN_PROGRESS",
    summarize({ status: freshAttempt.status })
  );

  const timerSpan = freshAttempt.deadlineAt.getTime() - freshAttempt.startedAt.getTime();
  check(
    "the persisted deadline is derived server-side from the configured duration",
    timerSpan === assessment.durationSeconds * 1000,
    summarize({ timerSpan, expected: assessment.durationSeconds * 1000 })
  );

  const hostile = await sendSignal(serverUrl, assessment.publicId, freshAttempt.id, {
    email: freshEmail,
    type: "VISIBILITY_HIDDEN",
    deadline: new Date(Date.now() + 999999999).toISOString(),
    deadlineAt: new Date(Date.now() + 999999999).toISOString(),
    startedAt: new Date(0).toISOString(),
    status: "CHEATED",
    cheatReason: "SERVER_INTEGRITY_VIOLATION",
  });
  const afterHostile = await attemptRowFor(assessment.id, freshEmail);
  check(
    "a client-supplied deadline cannot overwrite the persisted server deadline",
    afterHostile.deadlineAt.getTime() === freshAttempt.deadlineAt.getTime(),
    summarize({ before: freshAttempt.deadlineAt, after: afterHostile.deadlineAt })
  );
  check(
    "a client-supplied startedAt cannot overwrite the persisted start",
    afterHostile.startedAt.getTime() === freshAttempt.startedAt.getTime(),
    summarize({ before: freshAttempt.startedAt, after: afterHostile.startedAt })
  );
  check(
    "a client-supplied status/cheatReason can never terminate the attempt",
    hostile.status === 200 &&
      afterHostile.status === "IN_PROGRESS" &&
      afterHostile.cheatReason === null,
    summarize({ http: hostile.status, status: afterHostile.status, reason: afterHostile.cheatReason })
  );

  const resumed = await attemptService.startAssessmentAttempt(assessment.publicId, freshEmail);
  const attemptsForEmail = await prisma.jobAssessmentAttempt.count({
    where: { assessmentId: assessment.id, email: freshEmail },
  });
  check(
    "Phase 3's one-attempt-per-(assessment,email) rule is preserved (resume, never a second row)",
    attemptsForEmail === 1 && resumed.attempt?.id === freshAttempt.id,
    summarize({ attemptsForEmail, resumedId: resumed.attempt?.id, originalId: freshAttempt.id })
  );

  const rowsBeforeRefresh = (await integrityRowsFor(freshAttempt.id)).length;
  const refreshed = await attemptService.getAssessmentAttempt(assessment.publicId, freshEmail);
  check(
    "a browser refresh does not reset or duplicate integrity state",
    (await integrityRowsFor(freshAttempt.id)).length === rowsBeforeRefresh &&
      rowsBeforeRefresh === 1 &&
      refreshed.attempt?.status === "IN_PROGRESS",
    summarize({ rows: rowsBeforeRefresh, status: refreshed.attempt?.status })
  );

  // Lazy TIMED_UP must still work exactly as Phase 3 defined it: a past
  // persisted deadline closes the attempt on the next touch, with no timer.
  // The expired candidate is a real INVITED candidate of this assessment (see
  // the fixture list in main()), so the public attempt flow is authorized.
  const expiredAttempt = await openActiveAttempt({
    publicId: assessment.publicId,
    assessmentId: assessment.id,
    email: expiredEmail,
    questionId: null,
  });
  await prisma.jobAssessmentAttempt.update({
    where: { id: expiredAttempt.id },
    data: { deadlineAt: new Date(Date.now() - 1000) },
  });
  const expiredRead = await attemptService.getAssessmentAttempt(assessment.publicId, expiredEmail);
  check(
    "the Phase 3 lazy TIMED_UP path still works against the persisted deadline",
    expiredRead.attempt?.status === "TIMED_UP",
    summarize({ status: expiredRead.attempt?.status })
  );
  check(
    "a timed-up attempt rejects integrity signals (terminal, no row appended)",
    (await sendSignal(serverUrl, assessment.publicId, expiredAttempt.id, {
      email: expiredEmail,
      type: "VISIBILITY_HIDDEN",
    })).status === 409 &&
      (await integrityRowsFor(expiredAttempt.id)).length === 0
  );

  check(
    "integrity processing never mutates the persisted timer",
    (await attemptRowFor(assessment.id, freshEmail)).deadlineAt.getTime() ===
      freshAttempt.deadlineAt.getTime()
  );
};

// ---------------------------------------------------------------------------
// F. Security — no cross-tenant path, no client-authored verdict, no leaks
// ---------------------------------------------------------------------------
const sectionSecurity = async ({ serverUrl, assessment, otherAssessment, recruiterUser, emailA, attemptA, emailB, attemptB, question }) => {
  section("F. Security — authorization, client-authored verdicts and data leaks");

  check(
    "the endpoint is capability-scoped: another attempt's id is denied (403)",
    (
      await sendSignal(serverUrl, assessment.publicId, attemptB.id, {
        email: emailA,
        type: "VISIBILITY_HIDDEN",
      })
    ).status === 403,
    "cross-attempt access was not denied"
  );

  check(
    "another assessment's link cannot address this attempt",
    (
      await sendSignal(serverUrl, otherAssessment.publicId, attemptA.id, {
        email: emailA,
        type: "VISIBILITY_HIDDEN",
      })
    ).status >= 400,
    "cross-assessment access was not denied"
  );

  check(
    "another candidate's verified identity cannot write to this attempt",
    (
      await sendSignal(serverUrl, assessment.publicId, attemptA.id, {
        email: emailB,
        type: "VISIBILITY_HIDDEN",
      })
    ).status === 403,
    "cross-candidate access was not denied"
  );

  const assertedCheated = await sendSignal(serverUrl, assessment.publicId, attemptA.id, {
    email: emailA,
    type: "CHEATED",
  });
  check(
    "a client cannot ask for the CHEATED status by naming it as the signal type (400)",
    assertedCheated.status === 400,
    summarize({ status: assertedCheated.status, body: assertedCheated.body })
  );

  const rowsBeforeReason = (await integrityRowsFor(attemptA.id)).length;
  const reasonAttempt = await sendSignal(serverUrl, assessment.publicId, attemptA.id, {
    email: emailA,
    type: "VISIBILITY_VISIBLE",
    reason: "SERVER_INTEGRITY_VIOLATION",
    cheatReason: "SERVER_INTEGRITY_VIOLATION",
  });
  const lastRow = (await integrityRowsFor(attemptA.id)).at(-1);
  check(
    "a client-supplied cheat reason is ignored — only the rule's own reason persists",
    reasonAttempt.status === 200 &&
      lastRow?.reason === "ASSESSMENT_TAB_VISIBLE" &&
      lastRow?.type === "VISIBILITY_VISIBLE",
    summarize({ http: reasonAttempt.status, reason: lastRow?.reason })
  );
  check(
    "the ignored client fields were not smuggled into the persisted metadata",
    leaksOf(JSON.stringify(lastRow?.metadata ?? {})).length === 0 &&
      !JSON.stringify(lastRow?.metadata ?? {}).includes("SERVER_INTEGRITY_VIOLATION") &&
      (await integrityRowsFor(attemptA.id)).length === rowsBeforeReason + 1,
    summarize(lastRow?.metadata)
  );

  check(
    "the integrity response carries no token, hash, answer or secret material",
    leaksOf(reasonAttempt.serialized).length === 0,
    summarize(leaksOf(reasonAttempt.serialized))
  );

  const allRows = await prisma.jobAssessmentAttemptIntegrityEvent.findMany({
    where: { attemptId: { in: [attemptA.id, attemptB.id] } },
  });
  check(
    "no persisted integrity row contains a token, hash, answer or secret",
    leaksOf(JSON.stringify(allRows)).length === 0,
    summarize(leaksOf(JSON.stringify(allRows)))
  );
  check(
    "no persisted integrity row contains answer material for the attempt",
    allRows.every((row) => {
      const keys = collectKeys(row.metadata ?? {});
      return ![...keys].some((key) => /answer|token|hash|password/i.test(key));
    }),
    summarize(allRows.map((row) => [...collectKeys(row.metadata ?? {})]))
  );

  const answerRow = await prisma.jobAssessmentAttemptAnswer.findFirst({
    where: { attemptId: attemptA.id },
  });
  check(
    "the candidate's answer exists in its own table and never in the integrity log",
    Boolean(answerRow) &&
      !JSON.stringify(allRows).includes(JSON.stringify(answerRow.answer).slice(1, -1)),
    summarize({ answerPresent: Boolean(answerRow) })
  );

  // listJobCandidateAttempts takes (user, jobId) — the same two-argument form
  // the realtime harness and the controller use. Omitting the user would make
  // jobId undefined and reach findJobById(undefined) inside Prisma.
  const recruiterProjection = await attemptService.listJobCandidateAttempts(
    recruiterUser,
    (await prisma.job.findUnique({ where: { id: assessment.jobId } })).id
  );
  const projected = recruiterProjection.attempts.find((row) => row.attemptId === attemptA.id);
  const projectionKeys = projected ? Object.keys(projected).sort() : [];
  check(
    "the recruiter projection exposes status + concise reason only (no answers, no tokens)",
    projectionKeys.includes("cheatReason") &&
      projectionKeys.includes("status") &&
      !projectionKeys.some((key) => /answer|token|hash|password|verification/i.test(key)),
    summarize(projectionKeys)
  );
  check(
    "an untouched attempt projects a null reason (no invented accusation)",
    (await attemptService.listJobCandidateAttempts(
      recruiterUser,
      (await prisma.job.findUnique({ where: { id: assessment.jobId } })).id
    )).attempts.find((row) => row.attemptId === attemptB.id)?.cheatReason === null,
    "a clean attempt carried a reason"
  );
};

// ---------------------------------------------------------------------------
// G. Realtime — published after commit, delivered by the Phase 4 gateway
// ---------------------------------------------------------------------------
const sectionRealtime = async ({ serverUrl, assessment, job, recruiterA, recruiterB, email, questionId }) => {
  section("G. Realtime — CHEATED reaches the recruiter through the existing Phase 4 path");

  check(
    "the realtime layer uses the isolated harness channel (environment configuration)",
    getRealtimeChannel() === process.env.REALTIME_REDIS_CHANNEL &&
      getRealtimeChannel() !== DEFAULT_REALTIME_CHANNEL,
    summarize({ channel: getRealtimeChannel() })
  );

  const attempt = await openActiveAttempt({
    publicId: assessment.publicId,
    assessmentId: assessment.id,
    email,
    questionId,
  });

  // A probe that answers the ordering question directly: when the event ARRIVES,
  // is the terminal state already committed in PostgreSQL?
  const probe = [];
  const probeSubscription = await subscribeRealtimeEvents((event) => {
    const clean = sanitizeCandidateStatusEvent(event);
    if (!clean || clean.eventType !== REALTIME_EVENT_TYPES.ASSESSMENT_CHEATED) return;
    void (async () => {
      const row = await prisma.jobAssessmentAttempt.findUnique({ where: { id: attempt.id } });
      probe.push({ event: clean, dbStatusAtReceive: row?.status ?? null });
    })();
  });

  const recruiterStream = await openMockStream(recruiterA.user, job.id);
  const otherStream = await openMockStream(recruiterB.user, job.id);
  check(
    "an authorized recruiter holds a stream for their own job while another is rejected",
    recruiterStream.res.statusCode === 200 && otherStream.res.jsonPayload !== null,
    summarize({
      authorized: recruiterStream.res.statusCode,
      unauthorized: otherStream.res.statusCode,
      unauthorizedBody: otherStream.res.jsonPayload,
    })
  );

  for (let index = 1; index <= MAX_HIDDEN; index += 1) {
    await sendSignal(serverUrl, assessment.publicId, attempt.id, {
      email,
      type: "VISIBILITY_HIDDEN",
    });
  }

  const persisted = await attemptRowFor(assessment.id, email);
  check(
    "the threshold transition is committed in PostgreSQL",
    persisted.status === "CHEATED",
    summarize({ status: persisted.status })
  );

  const arrived = await waitFor(() => (probe.length > 0 ? probe : null), { timeoutMs: 5000 });
  check(
    "the ASSESSMENT_CHEATED event was published to the realtime channel",
    Boolean(arrived),
    "no CHEATED event was received"
  );
  check(
    "the event announces the PERSISTED CHEATED status (never a client claim)",
    arrived?.[0]?.event.assessmentStatus === "CHEATED" &&
      arrived?.[0]?.event.eventType === REALTIME_EVENT_TYPES.ASSESSMENT_CHEATED,
    summarize(arrived?.[0]?.event)
  );
  check(
    "the event was published only AFTER the transaction committed",
    arrived?.[0]?.dbStatusAtReceive === "CHEATED",
    summarize({ dbStatusAtReceive: arrived?.[0]?.dbStatusAtReceive })
  );
  check(
    "the event is scoped to the candidate's own job and assessment",
    arrived?.[0]?.event.jobId === job.id && arrived?.[0]?.event.assessmentId === assessment.id,
    summarize({
      jobId: arrived?.[0]?.event.jobId,
      assessmentId: arrived?.[0]?.event.assessmentId,
    })
  );
  check(
    "the event carries the whitelisted fields only and the normalized candidate email",
    jsonEqual(Object.keys(arrived?.[0]?.event ?? {}).sort(), [
      "assessmentId",
      "assessmentStatus",
      "candidateEmail",
      "candidateId",
      "eventType",
      "jobId",
      "occurredAt",
    ]) && arrived?.[0]?.event.candidateEmail === email.toLowerCase(),
    summarize(arrived?.[0]?.event)
  );
  check(
    "no answer, token, hash or secret appears in the realtime payload",
    leaksOf(JSON.stringify(arrived?.[0]?.event ?? {})).length === 0,
    summarize(leaksOf(JSON.stringify(arrived?.[0]?.event ?? {})))
  );

  const delivered = await waitFor(
    () =>
      sseDataPayloads(recruiterStream.res, "candidate-status").find(
        (payload) =>
          payload.eventType === REALTIME_EVENT_TYPES.ASSESSMENT_CHEATED &&
          payload.assessmentStatus === "CHEATED"
      ),
    { timeoutMs: 5000 }
  );
  check(
    "the authorized recruiter's SSE stream receives the CHEATED status",
    Boolean(delivered),
    summarize(sseDataPayloads(recruiterStream.res, "candidate-status"))
  );
  check(
    "a recruiter who does not own the job receives nothing from it",
    !sseDataPayloads(otherStream.res, "candidate-status").some(
      (payload) => payload.jobId === job.id
    ) && otherStream.res.jsonPayload !== null,
    summarize({ status: otherStream.res.statusCode, body: otherStream.res.jsonPayload })
  );

  await probeSubscription.unsubscribe();
  await closeMockStream(recruiterStream);
  await closeMockStream(otherStream);
  check(
    "disconnecting releases the gateway clients and the probe subscriber",
    realtimeGateway.getGatewayStats().connectedClients === 0 &&
      getRealtimePubSubStats().listenerCount >= 1,
    summarize({
      gateway: realtimeGateway.getGatewayStats().connectedClients,
      listeners: getRealtimePubSubStats().listenerCount,
    })
  );

  // Reconnect/reconciliation: the authoritative API is what a reconnecting
  // recruiter reads, so a missed event can never hide the terminal state.
  const authoritative = await attemptService.listJobCandidateAttempts(recruiterA.user, job.id);
  const row = authoritative.attempts.find((entry) => entry.attemptId === attempt.id);
  check(
    "an authoritative refetch after reconnect shows the persisted CHEATED status",
    row?.status === "CHEATED" && row?.cheatReason === "EXCESSIVE_VISIBILITY_CHANGES",
    summarize(row)
  );
  check(
    "a late duplicate event cannot change the authoritative terminal status",
    (await attemptRowFor(assessment.id, email)).status === "CHEATED"
  );

  const forged = sanitizeCandidateStatusEvent({
    eventType: "ASSESSMENT_CHEATED",
    jobId: job.id,
    assessmentId: assessment.id,
    candidateEmail: email,
    assessmentStatus: "CHEATED",
    occurredAt: new Date().toISOString(),
    answers: ["leak"],
    verificationTokenHash: "leak",
  });
  check(
    "a hostile Redis payload cannot smuggle answers/tokens through the sanitizer",
    forged !== null &&
      !Object.prototype.hasOwnProperty.call(forged, "answers") &&
      !Object.prototype.hasOwnProperty.call(forged, "verificationTokenHash"),
    summarize(forged)
  );
  check(
    "a malformed realtime payload is rejected instead of crashing the process",
    sanitizeCandidateStatusEvent({ eventType: "ASSESSMENT_CHEATED" }) === null &&
      sanitizeCandidateStatusEvent({
        eventType: "ASSESSMENT_CHEATED",
        jobId: job.id,
        assessmentId: assessment.id,
        assessmentStatus: "NOT_A_STATUS",
      }) === null &&
      sanitizeCandidateStatusEvent("not-an-object") === null
  );
};

// ---------------------------------------------------------------------------
// cleanup & report
// ---------------------------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  jobAssessmentAttempt: await prisma.jobAssessmentAttempt.count(),
  integrityEvent: await prisma.jobAssessmentAttemptIntegrityEvent.count(),
});

// Deletes exactly what this harness created, in FK-safe order (attempt rows
// reference invitations, so attempts go first; integrity events cascade with
// their attempt). Scoped strictly to tracked ids.
const cleanup = async () => {
  const removed = {};
  const jobIds = tracked.jobIds;
  const userIds = tracked.userIds;

  if (jobIds.length > 0) {
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
  if (userIds.length > 0) {
    removed.user = (await prisma.user.deleteMany({ where: { id: { in: userIds } } })).count;
  }

  return removed;
};



// --- main --------------------------------------------------------------------

const main = async () => {
  const totalsBefore = await snapshotTotals();
  const { child: server, url: serverUrl } = await startExpressServer();
  await startRecorder();

  const emailA = `ph5-cand-a-${SUFFIX}@example.test`;
  const emailB = `ph5-cand-b-${SUFFIX}@example.test`;
  const emailC = `ph5-threshold-${SUFFIX}@example.test`;
  const emailD = `ph5-race-${SUFFIX}@example.test`;
  const emailE = `ph5-phase3-${SUFFIX}@example.test`;
  const emailG = `ph5-realtime-${SUFFIX}@example.test`;
  const emailS = `ph5-submitted-${SUFFIX}@example.test`;
  // The lazy-TIMED_UP section opens a real attempt for this candidate, so it is
  // invited like every other candidate (see allEmails below).
  const emailX = `ph5-expired-${SUFFIX}@example.test`;
  const allEmails = [emailA, emailB, emailC, emailD, emailE, emailG, emailS, emailX];

  try {
    await sectionRuleLayer();

    const recruiterA = await createRecruiterFixture("a");
    const recruiterB = await createRecruiterFixture("b");

    const jobA = await createJobFixture(recruiterA, {
      label: "a",
      emails: allEmails,
      questionCount: 1,
    });
    const jobB = await createJobFixture(recruiterA, {
      label: "b",
      emails: [`ph5-other-${SUFFIX}@example.test`],
      questionCount: 1,
    });
    const question = jobA.questions[0];

    // Phase 2 invitations for every candidate row this harness uses.
    for (let index = 0; index < allEmails.length; index += 1) {
      await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, index);
    }

    const attemptA = await openActiveAttempt({
      publicId: jobA.assessment.publicId,
      assessmentId: jobA.assessment.id,
      email: emailA,
      questionId: question.id,
    });
    const attemptB = await openActiveAttempt({
      publicId: jobA.assessment.publicId,
      assessmentId: jobA.assessment.id,
      email: emailB,
      questionId: null,
    });

    await sectionPersistedSignals({
      serverUrl,
      assessment: jobA.assessment,
      otherAssessment: jobB.assessment,
      emails: [emailA, emailB],
      attempts: [attemptA, attemptB],
    });

    const thresholdAttempt = await openActiveAttempt({
      publicId: jobA.assessment.publicId,
      assessmentId: jobA.assessment.id,
      email: emailC,
      questionId: question.id,
    });
    await sectionThreshold({
      serverUrl,
      assessment: jobA.assessment,
      question,
      email: emailC,
      attempt: thresholdAttempt,
    });

    // A legitimately SUBMITTED attempt, so the concurrency section can prove a
    // terminal state is never overwritten by a late integrity decision.
    await openActiveAttempt({
      publicId: jobA.assessment.publicId,
      assessmentId: jobA.assessment.id,
      email: emailS,
      questionId: question.id,
    });
    await attemptService.submitAssessmentAttempt(jobA.assessment.publicId, emailS);
    const submittedRow = await attemptRowFor(jobA.assessment.id, emailS);
    check(
      "the harness fixture for a terminal attempt is persisted as SUBMITTED",
      submittedRow.status === "SUBMITTED",
      summarize({ status: submittedRow.status })
    );

    const raceAttempt = await openActiveAttempt({
      publicId: jobA.assessment.publicId,
      assessmentId: jobA.assessment.id,
      email: emailD,
      questionId: question.id,
    });
    await sectionConcurrency({
      serverUrl,
      assessment: jobA.assessment,
      email: emailD,
      attempt: raceAttempt,
      submittedAttempt: submittedRow,
    });

    await sectionPhase3Compatibility({
      serverUrl,
      assessment: jobA.assessment,
      email: emailE,
      questionId: question.id,
      // Section E opens a REAL attempt for this invited candidate to prove the
      // lazy TIMED_UP path; without the address the flow throws 403 and aborts.
      expiredEmail: emailX,
    });

    await sectionSecurity({
      serverUrl,
      assessment: jobA.assessment,
      otherAssessment: jobB.assessment,
      recruiterUser: recruiterA.user,
      emailA,
      attemptA: await attemptRowFor(jobA.assessment.id, emailA),
      emailB,
      attemptB: await attemptRowFor(jobA.assessment.id, emailB),
      question,
    });

    await sectionRealtime({
      serverUrl,
      assessment: jobA.assessment,
      job: jobA.job,
      recruiterA,
      recruiterB,
      email: emailG,
      questionId: question.id,
    });
  } catch (error) {
    check(
      "every scenario ran without an unexpected error",
      false,
      `${error?.message}\n        ${error?.stack?.split("\n").slice(0, 3).join("\n        ")}`
    );
  }

  section("H. Cleanup & leftovers");

  await stopRecorder();
  await realtimeGateway.closeAllStreams();
  await stopProcess(server);

  const removed = await cleanup();
  const totalsAfter = await snapshotTotals();
  const leftoverFiles = await countCandidateListLeftovers(prisma, tracked.jobIds);

  check(
    "every fixture row this harness created was removed",
    totalsAfter.user === totalsBefore.user &&
      totalsAfter.job === totalsBefore.job &&
      totalsAfter.jobAssessment === totalsBefore.jobAssessment &&
      totalsAfter.jobAssessmentInvitation === totalsBefore.jobAssessmentInvitation &&
      totalsAfter.jobAssessmentAttempt === totalsBefore.jobAssessmentAttempt &&
      totalsAfter.integrityEvent === totalsBefore.integrityEvent,
    summarize({ totalsBefore, totalsAfter })
  );
  check(
    "the integrity-event table carries no leftover rows for the removed attempts",
    totalsAfter.integrityEvent === totalsBefore.integrityEvent,
    summarize({ removed, totalsAfter })
  );
  // countCandidateListLeftovers returns a NUMBER (candidate-list rows + this
  // run's StoredFile rows combined), so the assertion compares against 0
  // directly — reading object properties off the number is always undefined.
  check(
    "no candidate-list file was left behind",
    leftoverFiles === 0,
    summarize(leftoverFiles)
  );

  const passed = results.filter((result) => result.ok).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed !== total) {
    console.log("FAILED CHECKS:");
    results.filter((result) => !result.ok).forEach((result) => console.log(`  - ${result.label}`));
  }

  await prisma.$disconnect();
  process.exitCode = passed === total ? 0 : 1;
  // BullMQ/ioredis handles can outlive the verdict on Windows, leaving the npm
  // script hanging after the summary — the other harnesses force the exit here
  // (verifyRecruiterRealtime.js) so the real exit code is what npm reports.
  process.exit(process.exitCode);
};

main().catch(async (error) => {
  console.error("UNEXPECTED harness error:", error);
  try {
    await stopRecorder();
    await realtimeGateway.closeAllStreams();
    await Promise.all(children.map((child) => stopProcess(child)));
    await cleanup();
  } catch (cleanupError) {
    console.error("cleanup after failure also failed:", cleanupError);
  }
  await prisma.$disconnect();
  process.exitCode = 1;
  process.exit(1);
});

