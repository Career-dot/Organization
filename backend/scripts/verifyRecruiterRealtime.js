/* eslint-disable no-console */
// Recruiter realtime candidate-status verification harness — Phase 4.
//
// Run with:  npm run verify:recruiter-realtime
//
// Proves, against the REAL database, the REAL Redis and the REAL service paths:
//   A. Infrastructure — isolated channel, separate publisher/subscriber Redis
//      connections, publish→subscribe roundtrip, malformed-payload safety,
//      listener isolation, bounded cleanup.
//   B. Event model — the whitelisted wire contract for all five event types;
//      no answers/tokens/hashes/AI payloads can ever be built or forwarded.
//   C. Persistence ordering — events are published only AFTER the PostgreSQL
//      transition committed; a failed transition publishes nothing; a Redis
//      outage never rolls back (or blocks) committed business state.
//   D. Authorization — the SSE gateway derives tenancy server-side (subscription
//      scope + job ownership): another recruiter's job, an unknown job and an
//      unauthenticated caller are rejected; a connected stream only ever
//      receives events for its OWN job.
//   E. Candidate identity — events carry persisted row identity/normalized
//      email only; nothing sensitive ever appears in any event.
//   F. Duplicate & out-of-order delivery — duplicates create no duplicate rows
//      and cannot corrupt statistics; a stale event cannot overwrite a newer
//      persisted state (PostgreSQL stays authoritative).
//   G. Reconnect — connection loss, backend/Redis restarts; every recovery is
//      an authoritative refetch, never trusted events.
//   H. Phase 3 integration — STARTED → IN_PROGRESS → SUBMITTED and the lazy
//      TIMED_UP transition each publish exactly one event AFTER commit; the
//      persisted timer is untouched.
//   I. Phase 2 integration — invite / re-invite / email verification events;
//      invitation behavior unchanged.
//   J. Scalability — multiple clients on one job and across jobs share ONE
//      Redis subscription per process; all resources are released on
//      disconnect.
//
// Convention follows scripts/verifyCandidateInvitation.js (CommonJS, the
// application's own Prisma client, throwaway fixtures tracked by id and
// deleted in FK-safe order, deterministic server-log email channel).

require("dotenv").config();

// The platform's deterministic test channel (same convention as
// verifyCandidateInvitation.js): SMTP credentials are BLANKED — never deleted —
// so harness emails go to the server-log fallback and never reach a provider.
const neutralizeSmtp = () => {
  process.env.SMTP_HOST = "";
  process.env.SMTP_PORT = "";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";
  process.env.EMAIL_FROM = "";
};
neutralizeSmtp();

const SUFFIX = `ph4rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// An ISOLATED realtime channel for this run: harness traffic can never reach a
// recruiter connected to a live deployment, and vice versa (the channel is
// resolved at call time by config/redis.pubsub.js).
process.env.REALTIME_REDIS_CHANNEL = `platform:realtime:candidate-status:${SUFFIX}`;
// Isolate the BullMQ namespace so no real worker can ever pick work up.
process.env.AI_QUEUE_PREFIX = SUFFIX;

const XLSX = require("xlsx");
const EventEmitter = require("node:events");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const attemptService = require("../src/module/job/jobAssessmentAttempt.service");

const {
  DEFAULT_REALTIME_CHANNEL,
  getRealtimeChannel,
  getRealtimePubSubStats,
  publishRealtimeEvent,
  subscribeRealtimeEvents,
  closeRealtimePubSub,
} = require("../src/config/redis.pubsub");
const {
  REALTIME_EVENT_TYPES,
  PERSISTED_STATUS_BY_EVENT_TYPE,
  buildCandidateStatusEvent,
  sanitizeCandidateStatusEvent,
} = require("../src/module/job/jobAssessmentRealtime.events");
const realtimePublisher = require("../src/module/job/jobAssessmentRealtime.publisher");
const realtimeGateway = require("../src/module/realtime/realtime.gateway");
const { cleanupJobCandidateLists } = require("./jobCandidateListFixture");
const { smtpConfigured } = require("../src/utils/sendAssessmentVerificationEmail");

// Re-assert the blanking AFTER the application modules loaded their own env.
neutralizeSmtp();
if (smtpConfigured()) {
  console.error(
    "FATAL: a real SMTP provider is still configured — refusing to run, because harness emails must never leave this process."
  );
  process.exit(1);
}

// --- console capture (the deterministic dev/test email channel) --------------
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

// --- reporting ---------------------------------------------------------------

const results = [];

const section = (title) => console.log(`\n${title}`);

const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  console.log(!ok && detail ? `${line}\n        -> ${detail}` : line);
};

const summarize = (value) => JSON.stringify(value ?? null);

const expectRejection = async (label, fn, status) => {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }

  if (!error) {
    check(label, false, `expected a rejection with HTTP ${status}, but the call resolved`);
    return null;
  }

  check(label, error.status === status, `expected HTTP ${status}, got ${error.status}: ${error.message}`);
  return error;
};

// Bounded deterministic wait (25ms ticks) — never a sleep-based long poll.
const waitFor = async (predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) => {
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

// Collects every object key in a JSON structure so captured events can be
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

// --- realtime event recorder (the harness's own Redis subscriber) -----------
const recorded = [];
let recorderSubscription = null;

const startRecorder = async () => {
  recorded.length = 0;
  recorderSubscription = await subscribeRealtimeEvents((event) => {
    // The recorder consumes events exactly the way the browser-facing gateway
    // does: through the whitelisting sanitizer. A malformed or hostile Redis
    // payload can therefore never enter the harness's recorded stream — this
    // mirrors sanitizeCandidateStatusEvent being the single gate between
    // "a Redis message exists" and "a client may see it".
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

const waitForEvent = async (predicate, timeoutMs = 4000) =>
  waitFor(() => recorded.find(predicate), { timeoutMs });

// --- mock SSE connection (drives the REAL gateway) --------------------------
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
  await waitFor(() => !realtimeGateway.getGatewayStats().connectedClients, { timeoutMs: 2000 });
};

// --- fixtures ----------------------------------------------------------------

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
};

const uniqueEmail = (label) =>
  `ph4rt-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

// Recruiter fixture — identical to the other harnesses: the service only reads
// user.id/role from the principal, but the row is real so ownership and FK
// cleanup behave exactly as in production.
const createRecruiterFixture = async (label, jobPostingLimit = 10) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Realtime Harness ${label}`,
      email: `ph4rt-recruiter-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Realtime Harness Plan ${label} ${SUFFIX}`,
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

const buildSheet = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  return XLSX.write(
    { SheetNames: ["Candidates"], Sheets: { Candidates: sheet } },
    { type: "buffer", bookType: "xlsx" }
  );
};

const uploadList = async (recruiter, jobId, rows, name) => {
  const buffer = buildSheet(rows);
  return jobService.uploadCandidateList(recruiter.user, jobId, {
    originalname: name,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
};

// Assessment fixture built directly (the AI generation pipeline is out of
// scope here): FINALIZED + ACTIVATED with a public link, exactly the state the
// candidate verification + attempt flows require.
const createAssessmentFixture = async (jobId, label, { durationSeconds = 600 } = {}) => {
  const assessment = await prisma.jobAssessment.create({
    data: {
      jobId,
      title: `Realtime harness assessment ${label}`,
      status: "FINALIZED",
      publicId: `${SUFFIX}-${label}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
      durationSeconds,
    },
  });
  return assessment;
};

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
  title: "Realtime harness job",
  yearsExperience: 5,
  description: "Harness job used to verify the recruiter realtime candidate-status system.",
  analysisDays: 3,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe a database migration you have run in production." }],
};

// Draft → Excel list → assessment → START, through the production service path.
const createJobFixture = async (recruiter, { label, rows, withAssessment = true } = {}) => {
  const draft = await jobService.createDraft(recruiter.user, {
    ...READY_PAYLOAD,
    title: `Realtime harness job ${label}`,
    description: `Harness job ${label} for the realtime candidate-status verification.`,
  });
  tracked.jobIds.push(draft.id);

  await uploadList(
    recruiter,
    draft.id,
    [["Name", "Email"], ...rows],
    `ph4rt-${label}-${SUFFIX}.xlsx`
  );

  const assessment = withAssessment ? await createAssessmentFixture(draft.id, label) : null;

  await jobService.startJob(recruiter.user, draft.id);
  return { job: draft, assessment };
};

const invitationRowFor = (assessmentId, email) =>
  prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

const attemptRowFor = (assessmentId, email) =>
  prisma.jobAssessmentAttempt.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

// Runs ONE real candidate email-verification round trip and returns the code
// used, so the attempt flow can run through the REAL public path.
const verifyCandidateEmail = async (publicId, email) => {
  await jobService.requestAssessmentEmailVerification(publicId, email);
  const code = await waitFor(() => latestCodeFor(email), { timeoutMs: 4000 });
  if (!code) {
    throw new Error(`No verification code was logged for ${email}`);
  }
  await jobService.confirmAssessmentEmailVerification(publicId, email, code);
  return code;
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

// C0 runs FIRST (before any Redis socket exists): it simulates a Redis outage
// with the REAL code path — REDIS_URL is read at connection-creation time, so
// pointing it at an unreachable port makes every publish fail exactly like a
// dead Redis would, while PostgreSQL keeps working.
const sectionRedisOutage = async ({ recruiterA, jobA }) => {
  section("C. Persistence ordering — Redis failure never touches PostgreSQL");
  const goodRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:6390"; // nothing listens here
  process.env.REALTIME_PUBLISH_TIMEOUT_MS = "400";

  let publishResult = null;
  let publishError = null;
  try {
    publishResult = await publishRealtimeEvent(
      buildCandidateStatusEvent({
        eventType: REALTIME_EVENT_TYPES.ASSESSMENT_INVITED,
        jobId: jobA.job.id,
        assessmentId: jobA.assessment.id,
        candidateEmail: uniqueEmail("outage"),
      })
    );
  } catch (error) {
    publishError = error;
  }

  check(
    "a Redis outage is reported as an undelivered event, never thrown",
    publishError === null && publishResult?.published === false,
    summarize({ publishError: publishError?.message, publishResult })
  );

  // The REAL service path with Redis down: the invitation write must succeed.
  let invite = null;
  let inviteError = null;
  try {
    invite = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 0);
  } catch (error) {
    inviteError = error;
  }
  const outageRow = invite
    ? await invitationRowFor(jobA.assessment.id, invite.candidate.email)
    : null;

  check(
    "with Redis down, the invite still commits its invitation (DB independent of Redis)",
    inviteError === null && Boolean(outageRow) && outageRow.status === "INVITED",
    summarize({ inviteError: inviteError?.message, row: outageRow?.status ?? null })
  );

  // Restore the good Redis and drop the dead publisher socket before the
  // transport sections run.
  process.env.REDIS_URL = goodRedisUrl;
  delete process.env.REALTIME_PUBLISH_TIMEOUT_MS;
  await closeRealtimePubSub();

  check(
    "dead realtime sockets are fully released after the outage (no leaked connections)",
    getRealtimePubSubStats().publisherCreated === false &&
      getRealtimePubSubStats().subscriberCreated === false,
    summarize(getRealtimePubSubStats())
  );

  return outageRow;
};

const sectionInfrastructure = async () => {
  section("A. Infrastructure — channel config, connections, delivery, safety");

  check(
    "the isolated harness channel is honored (environment configuration only)",
    getRealtimeChannel() === process.env.REALTIME_REDIS_CHANNEL &&
      getRealtimeChannel() !== DEFAULT_REALTIME_CHANNEL,
    summarize({ channel: getRealtimeChannel() })
  );

  await startRecorder();
  check(
    "recorder subscription opens ONE shared subscriber connection",
    getRealtimePubSubStats().subscriberCreated === true &&
      getRealtimePubSubStats().listenerCount === 1,
    summarize(getRealtimePubSubStats())
  );

  const roundtrip = buildCandidateStatusEvent({
    eventType: REALTIME_EVENT_TYPES.ASSESSMENT_INVITED,
    jobId: "infra-roundtrip-job",
    assessmentId: "infra-roundtrip-assessment",
    candidateEmail: "roundtrip@example.test",
  });
  const delivered = await publishRealtimeEvent(roundtrip);
  const seen = await waitForEvent(
    (event) =>
      event.jobId === "infra-roundtrip-job" && event.candidateEmail === "roundtrip@example.test"
  );
  check(
    "publish→subscribe roundtrip delivers the event on the isolated channel",
    delivered.published === true && Boolean(seen) && delivered.receivers >= 1,
    summarize({ delivered, seen })
  );

  check(
    "PUBLISH succeeds while the subscriber is in subscribe mode (dedicated sockets)",
    // In subscriber mode a shared socket rejects every non-pub/sub command —
    // a successful publish proves publisher and subscriber are separate Redis
    // connections (BullMQ keeps its own, untouched here).
    delivered.published === true && getRealtimePubSubStats().publisherConnected === true,
    summarize({ delivered, stats: getRealtimePubSubStats() })
  );

  // Malformed and hostile payloads must be dropped by the subscriber boundary.
  const IORedis = require("ioredis");
  const raw = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const listenerCountBefore = getRealtimePubSubStats().listenerCount;
  const recordedCountBefore = recorded.length;
  await raw.publish(getRealtimeChannel(), "not-json-at-all{{{");
  await raw.publish(
    getRealtimeChannel(),
    JSON.stringify({ eventType: "HACKED", verificationTokenHash: "leak", secret: "x" })
  );
  // Bounded settle window so both raw messages land before the assertion.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await raw.quit().catch(() => {});

  check(
    "malformed and hostile Redis payloads are dropped without crashing or forwarding",
    getRealtimePubSubStats().listenerCount === listenerCountBefore &&
      recorded.length === recordedCountBefore,
    summarize({ recordedCountBefore, recordedNow: recorded.length })
  );

  // A throwing listener must not starve the other listeners.
  const throwing = await subscribeRealtimeEvents(() => {
    throw new Error("listener exploded");
  });
  const countBeforeThrow = recorded.length;
  await publishRealtimeEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_INVITED,
      jobId: "infra-throw-job",
      assessmentId: "infra-throw-assessment",
      candidateEmail: "throw@example.test",
    })
  );
  const seenAfterThrow = await waitForEvent((event) => event.jobId === "infra-throw-job");
  await throwing.unsubscribe();

  check(
    "a throwing listener neither crashes the process nor starves other listeners",
    Boolean(seenAfterThrow) && recorded.length > countBeforeThrow,
    summarize({ seenAfterThrow })
  );

  check(
    "unsubscribed listeners are removed and the shared subscription survives",
    getRealtimePubSubStats().listenerCount === 1 &&
      getRealtimePubSubStats().subscriberCreated === true,
    summarize(getRealtimePubSubStats())
  );
};

const sectionEventModel = () => {
  section("B. Event model — the whitelisted wire contract");

  for (const [eventType, persistedStatus] of Object.entries(PERSISTED_STATUS_BY_EVENT_TYPE)) {
    const event = buildCandidateStatusEvent({
      eventType,
      jobId: "job-1",
      assessmentId: "assessment-1",
      candidateEmail: "MODEL@Example.TEST",
    });
    check(
      `${eventType} builds with its canonical persisted status ${persistedStatus}`,
      event.eventType === eventType &&
        event.assessmentStatus === persistedStatus &&
        event.candidateEmail === "model@example.test" &&
        typeof event.occurredAt === "string" &&
        !Number.isNaN(new Date(event.occurredAt).getTime()),
      summarize(event)
    );
  }

  let buildError = null;
  try {
    buildCandidateStatusEvent({
      eventType: "NOT_A_REAL_EVENT",
      jobId: "job-1",
      assessmentId: "assessment-1",
      candidateEmail: "x@example.test",
    });
  } catch (error) {
    buildError = error;
  }
  check(
    "an unknown event type can never be built (programming error surfaces at the emitter)",
    buildError !== null,
    summarize(buildError?.message)
  );

  const withExtras = sanitizeCandidateStatusEvent({
    eventType: "ASSESSMENT_SUBMITTED",
    jobId: "job-1",
    assessmentId: "assessment-1",
    candidateEmail: "dup@example.test",
    assessmentStatus: "SUBMITTED",
    occurredAt: new Date().toISOString(),
    verificationTokenHash: "should-drop",
    answers: [{ choice: "A" }],
    passwordHash: "should-drop",
    geminiPayload: { secret: true },
  });
  check(
    "the sanitizer drops EVERY extra field (tokens, answers, hashes, AI payloads)",
    withExtras !== null &&
      Object.keys(withExtras).sort().join(",") ===
        ["assessmentId", "assessmentStatus", "candidateEmail", "candidateId", "eventType", "jobId", "occurredAt"].join(","),
    summarize(withExtras)
  );

  check(
    "the sanitizer rejects malformed shapes, unknown types and unknown statuses",
    sanitizeCandidateStatusEvent(null) === null &&
      sanitizeCandidateStatusEvent("string") === null &&
      sanitizeCandidateStatusEvent({ eventType: "HACKED", jobId: "j", assessmentId: "a", assessmentStatus: "SUBMITTED" }) === null &&
      sanitizeCandidateStatusEvent({
        eventType: "ASSESSMENT_SUBMITTED",
        jobId: "j",
        assessmentId: "a",
        assessmentStatus: "CANCELLED", // outside the status enum (CHEATED became canonical in Phase 5)
        occurredAt: new Date().toISOString(),
      }) === null &&
      sanitizeCandidateStatusEvent({
        eventType: "ASSESSMENT_SUBMITTED",
        jobId: "j",
        assessmentId: "a",
        assessmentStatus: "SUBMITTED",
        occurredAt: "not-a-date",
      }) === null,
    summarize(null)
  );

  check(
    "candidateId must be a persisted integer identity (never a string/array index)",
    buildCandidateStatusEvent({
      eventType: "ASSESSMENT_INVITED",
      jobId: "j",
      assessmentId: "a",
      candidateId: 7,
      candidateEmail: "id@example.test",
    }).candidateId === 7 &&
      sanitizeCandidateStatusEvent({
        eventType: "ASSESSMENT_INVITED",
        jobId: "j",
        assessmentId: "a",
        candidateEmail: "id@example.test",
        assessmentStatus: "INVITED",
        candidateId: "row-3",
        occurredAt: new Date().toISOString(),
      }).candidateId === null,
    summarize(null)
  );
};

const sectionAuthorization = async ({ recruiterA, recruiterB, jobA, jobB, jobNoAssessment }) => {
  section("D. Authorization — the SSE gateway derives tenancy server-side");

  const own = await realtimeGateway.authorizeJobStream(recruiterA.user, jobA.job.id);
  check(
    "a recruiter is authorized for their OWN job",
    own?.jobId === jobA.job.id,
    summarize(own)
  );

  await expectRejection(
    "another recruiter's job is rejected (403) — the URL jobId is never proof",
    () => realtimeGateway.authorizeJobStream(recruiterB.user, jobA.job.id),
    403
  );
  await expectRejection(
    "an unknown job id is rejected (404)",
    () => realtimeGateway.authorizeJobStream(recruiterA.user, `missing-${SUFFIX}`),
    404
  );
  await expectRejection(
    "an unauthenticated caller is rejected (401)",
    () => realtimeGateway.authorizeJobStream(null, jobA.job.id),
    401
  );

  // End-to-end through the REAL gateway + REAL Redis pub/sub.
  const streamA = await openMockStream(recruiterA.user, jobA.job.id);
  check(
    "the authorized stream opens with SSE headers and a ready handshake",
    streamA.res.statusCode === 200 &&
      streamA.res.headers["Content-Type"].startsWith("text/event-stream") &&
      sseDataPayloads(streamA.res, "ready").length === 1,
    summarize({ status: streamA.res.statusCode, ready: sseDataPayloads(streamA.res, "ready") })
  );

  await realtimePublisher.publishInvitationEvent({
    jobId: jobA.job.id,
    assessmentId: jobA.assessment.id,
    candidateId: 9,
    candidateEmail: uniqueEmail("streamA"),
  });
  const receivedA = await waitFor(() =>
    sseDataPayloads(streamA.res, "candidate-status").find(
      (event) => event.candidateEmail?.endsWith("@example.test") && event.candidateId === 9
    )
  );
  check(
    "an event for the authorized job reaches the connected recruiter stream",
    Boolean(receivedA) && receivedA.jobId === jobA.job.id && receivedA.candidateId === 9,
    summarize(receivedA)
  );

  await realtimePublisher.publishInvitationEvent({
    jobId: jobB.job.id,
    assessmentId: jobB.assessment.id,
    candidateId: 0,
    candidateEmail: uniqueEmail("streamB-leak-probe"),
  });
  const leaked = await waitFor(
    () =>
      sseDataPayloads(streamA.res, "candidate-status").find((event) => event.jobId === jobB.job.id) ??
      null,
    { timeoutMs: 600 }
  );
  check(
    "an event for ANOTHER recruiter's job never reaches the stream (no cross-tenant leak)",
    leaked === null,
    summarize({ leaked })
  );

  check(
    "gateway stats track the connected client and its authorized job",
    realtimeGateway.getGatewayStats().connectedClients === 1 &&
      realtimeGateway.getGatewayStats().subscribedJobs === 1,
    summarize(realtimeGateway.getGatewayStats())
  );

  // A hostile/unknown event type on the SAME authorized channel must never be
  // forwarded to the browser (the sanitizer is the single gate).
  const IORedis = require("ioredis");
  const hostile = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const bodyBeforeHostile = streamA.res.body;
  await hostile.publish(
    getRealtimeChannel(),
    JSON.stringify({
      eventType: "HACKED",
      jobId: jobA.job.id,
      assessmentId: jobA.assessment.id,
      assessmentStatus: "SUBMITTED",
      candidateEmail: "hostile@example.test",
      verificationTokenHash: "leak-attempt",
      occurredAt: new Date().toISOString(),
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await hostile.quit().catch(() => {});
  check(
    "a hostile event on the authorized channel is never forwarded to the stream",
    streamA.res.body === bodyBeforeHostile,
    summarize({ grew: streamA.res.body.length - bodyBeforeHostile })
  );

  await closeMockStream(streamA);
  check(
    "closing the stream releases the client and the process subscription (bounded cleanup)",
    realtimeGateway.getGatewayStats().connectedClients === 0 &&
      getRealtimePubSubStats().listenerCount === 1,
    summarize({
      gateway: realtimeGateway.getGatewayStats(),
      pubsub: getRealtimePubSubStats(),
    })
  );

  return { jobNoAssessment };
};

const sectionPhase2 = async ({ recruiterA, jobA, jobNoAssessment }) => {
  section("I. Phase 2 integration — invitation & email-verification events");
  const assessment = jobA.assessment;

  const listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const row1 = listing.candidates.find((entry) => entry.id === 1);
  check(
    "the persisted candidate row identity is available for reconciliation (never an index)",
    row1 && row1.rowIndex === row1.id && row1.id === 1,
    summarize(row1)
  );

  const invitedBefore = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_INVITED).length;
  await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1);
  const invitedEvent = await waitFor(() =>
    eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_INVITED)
      .slice(invitedBefore)
      .find((event) => event.candidateId === 1)
  );
  const row1AfterEvent = invitedEvent
    ? await invitationRowFor(assessment.id, invitedEvent.candidateEmail)
    : null;

  check(
    "the INVITED event carries the persisted row identity and normalized email",
    Boolean(invitedEvent) &&
      invitedEvent.jobId === jobA.job.id &&
      invitedEvent.assessmentId === assessment.id &&
      invitedEvent.candidateEmail === row1.email.toLowerCase() &&
      invitedEvent.assessmentStatus === "INVITED",
    summarize(invitedEvent)
  );
  check(
    "the INVITED event is published only AFTER the invitation row committed",
    Boolean(row1AfterEvent) && row1AfterEvent.status === "INVITED",
    summarize(row1AfterEvent)
  );

  const reInvitedCount = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_INVITED).length;
  await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1);
  await waitFor(
    () => eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_INVITED).length > reInvitedCount
  );
  const invitationRowCount = await prisma.jobAssessmentInvitation.count({
    where: { assessmentId: assessment.id },
  });
  check(
    "a re-invite publishes a fresh event but NEVER duplicates the invitation row",
    invitationRowCount === 2 && Boolean(row1AfterEvent),
    summarize({ invitationRowCount })
  );

  const recordedBefore = recorded.length;
  await expectRejection(
    "a refused invite (job without assessment, 404) publishes NO success event",
    () => jobService.inviteJobCandidate(recruiterA.user, jobNoAssessment.job.id, 0),
    404
  );
  check(
    "no event was emitted for the failed transition",
    recorded.length === recordedBefore,
    summarize({ before: recordedBefore, after: recorded.length })
  );

  const verifiedBefore = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_EMAIL_VERIFIED).length;
  await verifyCandidateEmail(assessment.publicId, row1.email);
  const verifiedEvent = await waitFor(() =>
    eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_EMAIL_VERIFIED)
      .slice(verifiedBefore)
      .find((event) => event.candidateEmail === row1.email.toLowerCase())
  );
  const verifiedRow = verifiedEvent
    ? await invitationRowFor(assessment.id, verifiedEvent.candidateEmail)
    : null;
  check(
    "the EMAIL_VERIFIED event arrives with the committed persisted status",
    Boolean(verifiedEvent) &&
      verifiedEvent.assessmentStatus === "EMAIL_VERIFIED" &&
      Boolean(verifiedRow) &&
      verifiedRow.status === "EMAIL_VERIFIED",
    summarize({ verifiedEvent, row: verifiedRow?.status ?? null })
  );

  const refreshed = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const refreshedRow1 = refreshed.candidates.find((entry) => entry.id === 1);
  const refreshedRow0 = refreshed.candidates.find((entry) => entry.id === 0);
  check(
    "the authoritative candidate list reflects the persisted invitation states",
    refreshedRow1.invitationStatus === "EMAIL_VERIFIED" && refreshedRow0.invitationStatus === "INVITED",
    summarize({
      row0: refreshedRow0?.invitationStatus ?? null,
      row1: refreshedRow1?.invitationStatus ?? null,
    })
  );

  return { row1Email: row1.email };
};

const sectionPhase3 = async ({ recruiterA, jobA, row1Email }) => {
  section("H. Phase 3 integration — attempt lifecycle events");
  const assessment = jobA.assessment;
  const publicId = assessment.publicId;

  // START (row1 was EMAIL_VERIFIED in the Phase 2 section).
  const startEventsBefore = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_STARTED).length;
  await attemptService.startAssessmentAttempt(publicId, row1Email);
  const startedEvent = await waitFor(() =>
    eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_STARTED)
      .slice(startEventsBefore)
      .find((event) => event.candidateEmail === row1Email.toLowerCase())
  );
  const startedRow = startedEvent ? await attemptRowFor(assessment.id, row1Email) : null;
  check(
    "START publishes ASSESSMENT_STARTED with the persisted STARTED status",
    Boolean(startedEvent) &&
      startedEvent.assessmentStatus === "STARTED" &&
      startedEvent.jobId === jobA.job.id,
    summarize(startedEvent)
  );
  check(
    "the attempt row is committed with server-derived startedAt/deadlineAt",
    Boolean(startedRow) &&
      startedRow.status === "STARTED" &&
      startedRow.startedAt !== null &&
      startedRow.deadlineAt !== null,
    summarize(startedRow)
  );

  // IN_PROGRESS — the first persisted answer moves the attempt forward.
  const question = await prisma.jobAssessmentQuestion.findFirst({
    where: { assessmentId: assessment.id, sortOrder: 1 },
  });
  const progressEventsBefore = recorded.filter(
    (event) => event.assessmentStatus === "IN_PROGRESS"
  ).length;
  await attemptService.saveAttemptAnswer(publicId, row1Email, question.id, {
    choice: "Option A",
  });
  const progressEvent = await waitFor(() =>
    recorded
      .filter((event) => event.assessmentStatus === "IN_PROGRESS")
      .slice(progressEventsBefore)
      .find((event) => event.candidateEmail === row1Email.toLowerCase())
  );
  const progressRow = await attemptRowFor(assessment.id, row1Email);
  check(
    "the first persisted answer publishes the IN_PROGRESS transition",
    Boolean(progressEvent) && progressEvent.eventType === REALTIME_EVENT_TYPES.ASSESSMENT_STARTED,
    summarize(progressEvent)
  );
  check(
    "IN_PROGRESS is persisted (the event only announces committed state)",
    Boolean(progressRow) && progressRow.status === "IN_PROGRESS",
    summarize(progressRow)
  );

  // The timer authority must be untouched by realtime publication.
  const timerUnchanged =
    startedRow &&
    progressRow &&
    progressRow.startedAt.getTime() === startedRow.startedAt.getTime() &&
    progressRow.deadlineAt.getTime() === startedRow.deadlineAt.getTime() &&
    assessment.durationSeconds === 600;
  check(
    "realtime events never touch the persisted timer (startedAt/deadlineAt/duration stable)",
    timerUnchanged,
    summarize({
      startedAt: progressRow?.startedAt,
      deadlineAt: progressRow?.deadlineAt,
      durationSeconds: assessment.durationSeconds,
    })
  );

  return { publicId, questionId: question.id };
};

const sectionPhase3Terminal = async ({ recruiterA, jobA, row1Email }) => {
  section("H (cont.) — SUBMITTED / TIMED_UP and the authoritative projection");
  const assessment = jobA.assessment;
  const publicId = assessment.publicId;

  // SUBMIT.
  const submitEventsBefore = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED).length;
  await attemptService.submitAssessmentAttempt(publicId, row1Email);
  const submittedEvent = await waitFor(() =>
    eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED)
      .slice(submitEventsBefore)
      .find((event) => event.candidateEmail === row1Email.toLowerCase())
  );
  const submittedRow = await attemptRowFor(assessment.id, row1Email);
  check(
    "submit publishes ASSESSMENT_SUBMITTED after the terminal state committed",
    Boolean(submittedEvent) &&
      submittedEvent.assessmentStatus === "SUBMITTED" &&
      Boolean(submittedRow) &&
      submittedRow.status === "SUBMITTED" &&
      submittedRow.submittedAt !== null,
    summarize({ submittedEvent, row: submittedRow?.status })
  );

  // Idempotent re-submit: the terminal state is returned, nothing is published.
  const submittedAtBefore = submittedRow.submittedAt.getTime();
  const submitEventsAfterFirst = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED).length;
  await attemptService.submitAssessmentAttempt(publicId, row1Email);
  const newSubmitEvents = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED).length;
  const resubmittedRow = await attemptRowFor(assessment.id, row1Email);
  check(
    "a duplicate submit publishes NO second event (at-least-once is not abused)",
    newSubmitEvents === submitEventsAfterFirst,
    summarize({ submitEventsAfterFirst, newSubmitEvents })
  );
  check(
    "a duplicate submit never mutates the committed terminal state",
    resubmittedRow.submittedAt.getTime() === submittedAtBefore,
    summarize({ submittedAtBefore, now: resubmittedRow.submittedAt })
  );

  // TIMED_UP — lazy expiry of a second candidate's attempt (row2).
  const row2Listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const row2 = row2Listing.candidates.find((entry) => entry.id === 2);
  await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 2);
  await verifyCandidateEmail(publicId, row2.email);
  await attemptService.startAssessmentAttempt(publicId, row2.email);

  const timedEventsBefore = eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_TIMED_UP).length;
  // Simulate elapsed time by moving the PERSISTED deadline into the past —
  // exactly what the lazy expiry check reads. No Node timer is involved.
  const activeAttempt = await attemptRowFor(assessment.id, row2.email);
  await prisma.jobAssessmentAttempt.update({
    where: { id: activeAttempt.id },
    data: { deadlineAt: new Date(Date.now() - 1000) },
  });
  await attemptService.getAssessmentAttempt(publicId, row2.email);
  const timedEvent = await waitFor(() =>
    eventsOfType(REALTIME_EVENT_TYPES.ASSESSMENT_TIMED_UP)
      .slice(timedEventsBefore)
      .find((event) => event.candidateEmail === row2.email.toLowerCase())
  );
  const timedRow = await attemptRowFor(assessment.id, row2.email);
  check(
    "the lazy expiry persists TIMED_UP and publishes ASSESSMENT_TIMED_UP",
    Boolean(timedEvent) &&
      timedEvent.assessmentStatus === "TIMED_UP" &&
      Boolean(timedRow) &&
      timedRow.status === "TIMED_UP" &&
      timedRow.timedOutAt !== null,
    summarize({ timedEvent, row: timedRow?.status })
  );

  // Authoritative recruiter projection after the whole lifecycle.
  const projection = await attemptService.listJobCandidateAttempts(recruiterA.user, jobA.job.id);
  const statusByEmail = new Map(projection.attempts.map((entry) => [entry.email, entry.status]));
  check(
    "the recruiter status projection shows the persisted lifecycle (SUBMITTED/TIMED_UP)",
    statusByEmail.get(row1Email.toLowerCase()) === "SUBMITTED" &&
      statusByEmail.get(row2.email.toLowerCase()) === "TIMED_UP",
    summarize([...statusByEmail.entries()])
  );

  return { row2Email: row2.email };
};

const sectionIdentity = async ({ jobA, jobB }) => {
  section("E. Candidate identity — nothing sensitive ever leaves the backend");

  // Submitting a terminal attempt now starts candidate analysis automatically, so the
  // SAME channel also carries the Step 7 CANDIDATE_ANALYSIS_UPDATED event. This
  // section owns the assessment lifecycle vocabulary; the analysis event is asserted
  // separately below against its own sanitized whitelist.
  const isCandidateAnalysisEvent = (event) => event.eventType === "CANDIDATE_ANALYSIS_UPDATED";
  const assessmentEvents = recorded.filter((event) => !isCandidateAnalysisEvent(event));
  const candidateAnalysisEvents = recorded.filter(isCandidateAnalysisEvent);

  const allowedKeys = new Set([
    "eventType",
    "jobId",
    "assessmentId",
    "candidateId",
    "candidateEmail",
    "assessmentStatus",
    "occurredAt",
    // recorder-internal only:
    "receivedAt",
  ]);
  const forbiddenKeyProbe = /token|hash|answer|guidance|password|secret|gemini|ai|evidence|score/i;
  const offenders = [];
  for (const event of assessmentEvents) {
    for (const key of Object.keys(event)) {
      // Unknown keys are forbidden outright; the probe is a second net for any
      // future whitelist addition that smuggles sensitive naming in.
      if (!allowedKeys.has(key)) {
        offenders.push({ jobId: event.jobId, key });
      } else if (key !== "receivedAt" && key !== "candidateEmail" && forbiddenKeyProbe.test(key)) {
        offenders.push({ jobId: event.jobId, key });
      }
    }
  }
  check(
    "every captured event carries ONLY the whitelisted wire fields",
    offenders.length === 0,
    summarize(offenders.slice(0, 5))
  );

  const jobIds = new Set(recorded.map((event) => event.jobId));
  const unknownJobIds = [...jobIds].filter(
    (jobId) => ![jobA.job.id, jobB.job.id].includes(jobId) && !jobId.startsWith("infra-")
  );
  check(
    "events are scoped to the fixtures' jobs only (no cross-job drift)",
    unknownJobIds.length === 0,
    summarize(unknownJobIds)
  );

  const badEmails = assessmentEvents.filter(
    (event) =>
      typeof event.candidateEmail === "string" &&
      event.candidateEmail !== event.candidateEmail.toLowerCase()
  );
  check(
    "candidate emails are always normalized (the recruiter list's own rule)",
    badEmails.length === 0,
    summarize(badEmails.slice(0, 3).map((event) => event.candidateEmail))
  );

  const badIds = assessmentEvents.filter(
    (event) => event.candidateId !== null && !Number.isInteger(event.candidateId)
  );
  check(
    "candidateId is always the persisted integer row identity or null",
    badIds.length === 0,
    summarize(badIds.slice(0, 3))
  );

  const persistedStatuses = new Set(["INVITED", "EMAIL_VERIFIED", "STARTED", "IN_PROGRESS", "SUBMITTED", "TIMED_UP"]);
  const badStatuses = assessmentEvents.filter((event) => !persistedStatuses.has(event.assessmentStatus));
  check(
    "assessmentStatus is always a persisted PostgreSQL enum value",
    badStatuses.length === 0,
    summarize(badStatuses.slice(0, 3).map((event) => event.assessmentStatus))
  );

  // The automatic trigger's own event: same channel, entirely separate vocabulary,
  // carrying an opaque reference and nothing that identifies or scores the candidate.
  const candidateAnalysisKeys = new Set([
    "eventType",
    "jobId",
    "referenceId",
    "analysisId",
    "analysisVersion",
    "status",
    "updatedAt",
    // recorder-internal only:
    "receivedAt",
  ]);
  const analysisOffenders = candidateAnalysisEvents.flatMap((event) =>
    Object.keys(event)
      .filter((key) => !candidateAnalysisKeys.has(key))
      .map((key) => ({ key, event: summarize(event) }))
  );
  check(
    "the automatic candidate-analysis event carries ONLY the sanitized Step 7 fields",
    analysisOffenders.length === 0 &&
      candidateAnalysisEvents.every(
        (event) => event.candidateEmail === undefined && event.candidateId === undefined
      ),
    summarize(analysisOffenders.slice(0, 3))
  );
  check(
    "committing a terminal attempt really does publish the automatic candidate-analysis event",
    candidateAnalysisEvents.length > 0 &&
      candidateAnalysisEvents.every((event) => event.status === "PENDING"),
    summarize(candidateAnalysisEvents.map((event) => ({ jobId: event.jobId, status: event.status })).slice(0, 3))
  );

  const noTypeDrift = recorded.filter(
    (event) => !Object.values(REALTIME_EVENT_TYPES).includes(event.eventType)
  );
  check(
    "eventType is always one of the five declared domain events",
    noTypeDrift.length === 0,
    summarize(noTypeDrift.slice(0, 3).map((event) => event.eventType))
  );
};

const sectionDuplicateSafety = async ({ recruiterA, jobA, row1Email }) => {
  section("F. Duplicate & out-of-order delivery — PostgreSQL stays authoritative");
  const assessment = jobA.assessment;
  const submittedRow = await attemptRowFor(assessment.id, row1Email);
  const submittedAt = submittedRow.submittedAt.getTime();

  // A Redis redelivery / double publish of the SAME event.
  const duplicate = buildCandidateStatusEvent({
    eventType: REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED,
    jobId: jobA.job.id,
    assessmentId: assessment.id,
    candidateEmail: row1Email,
    occurredAt: submittedRow.submittedAt,
  });
  await publishRealtimeEvent(duplicate);
  await publishRealtimeEvent(duplicate);
  await waitFor(() => {
    const copies = recorded.filter(
      (event) =>
        event.eventType === REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED &&
        event.candidateEmail === row1Email.toLowerCase()
    );
    return copies.length >= 3 ? copies : null;
  });

  const rowAfterDuplicates = await attemptRowFor(assessment.id, row1Email);
  check(
    "duplicate SUBMITTED events leave the attempt row untouched (idempotent reconciliation)",
    rowAfterDuplicates.status === "SUBMITTED" && rowAfterDuplicates.submittedAt.getTime() === submittedAt,
    summarize({ status: rowAfterDuplicates.status, submittedAt: rowAfterDuplicates.submittedAt })
  );

  const attemptRowCount = await prisma.jobAssessmentAttempt.count({
    where: { assessmentId: assessment.id, email: row1Email.toLowerCase() },
  });
  check(
    "duplicate events never create duplicate candidate/attempt rows",
    attemptRowCount === 1,
    summarize({ attemptRowCount })
  );

  // A STALE event arriving late must not overwrite the newer persisted state.
  await publishRealtimeEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_STARTED,
      jobId: jobA.job.id,
      assessmentId: assessment.id,
      candidateEmail: row1Email,
      assessmentStatus: "IN_PROGRESS",
      occurredAt: new Date(submittedAt - 60000),
    })
  );
  await waitFor(() => recorded.some((event) => event.assessmentStatus === "IN_PROGRESS" && event.candidateEmail === row1Email.toLowerCase()));

  const authoritative = await attemptService.listJobCandidateAttempts(
    recruiterA.user,
    jobA.job.id
  );
  const authoritativeRow = authoritative.attempts.find(
    (entry) => entry.email === row1Email.toLowerCase()
  );
  check(
    "an out-of-order stale event CANNOT corrupt the newer persisted state",
    authoritativeRow.status === "SUBMITTED",
    summarize({ authoritativeStatus: authoritativeRow.status })
  );

  const listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const emails = listing.candidates.map((entry) => entry.email);
  check(
    "the authoritative candidate list still holds exactly one row per candidate",
    emails.length === new Set(emails).size,
    summarize({ count: emails.length, unique: new Set(emails).size })
  );
};

const sectionReconnect = async ({ recruiterA, jobA, row1Email }) => {
  section("G. Reconnect — recovery is always an authoritative refetch");
  const assessment = jobA.assessment;

  // Connection loss: the recorder (a standing consumer) drops its subscription.
  await stopRecorder();
  const statsAfterLoss = getRealtimePubSubStats();

  // Events fired while "disconnected" are MISSED — Redis Pub/Sub keeps nothing.
  await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 3);

  // Reconnect.
  await startRecorder();
  const statsAfterReconnect = getRealtimePubSubStats();
  check(
    "connection loss releases the consumer socket and reconnect reopens it",
    statsAfterLoss.listenerCount === 0 &&
      statsAfterLoss.subscriberCreated === false &&
      statsAfterReconnect.subscriberCreated === true &&
      statsAfterReconnect.listenerCount === 1,
    summarize({ afterLoss: statsAfterLoss, afterReconnect: statsAfterReconnect })
  );
  check(
    "missed events are NOT replayed (at-most-once transport, no fake history)",
    recorded.length === 0,
    summarize({ recorded: recorded.length })
  );

  // The authoritative refetch recovers the full state the events described.
  const listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const row3 = listing.candidates.find((entry) => entry.id === 3);
  check(
    "the authoritative candidate list restores the missed invitation state",
    row3.invitationStatus === "INVITED",
    summarize({ row3: row3.invitationStatus })
  );

  // Backend-restart recovery: gateway state is disposable, PostgreSQL is not.
  await realtimeGateway.closeAllStreams();
  check(
    "a backend restart wipes transport state while PostgreSQL keeps every row",
    realtimeGateway.getGatewayStats().connectedClients === 0 &&
      (await prisma.jobAssessmentAttempt.count({ where: { assessmentId: assessment.id } })) === 2,
    summarize({
      clients: realtimeGateway.getGatewayStats().connectedClients,
      attempts: await prisma.jobAssessmentAttempt.count({ where: { assessmentId: assessment.id } }),
    })
  );

  // Redis-restart recovery: full teardown of BOTH realtime sockets, then a
  // working subscribe + publish roundtrip again (ioredis reconnects/recreates).
  const attemptRowBefore = await attemptRowFor(assessment.id, row1Email);
  await closeRealtimePubSub();
  const statsAfterRedisRestart = getRealtimePubSubStats();
  await startRecorder();
  const probe = buildCandidateStatusEvent({
    eventType: REALTIME_EVENT_TYPES.ASSESSMENT_INVITED,
    jobId: "reconnect-probe-job",
    assessmentId: "reconnect-probe-assessment",
    candidateEmail: "reconnect-probe@example.test",
  });
  const delivered = await publishRealtimeEvent(probe);
  const seen = await waitForEvent((event) => event.jobId === "reconnect-probe-job");
  check(
    "after a Redis restart the realtime layer recovers (subscribe + publish work again)",
    statsAfterRedisRestart.subscriberCreated === false &&
      statsAfterRedisRestart.publisherCreated === false &&
      delivered.published === true &&
      Boolean(seen),
    summarize({ statsAfterRedisRestart, delivered, seen: Boolean(seen) })
  );
  check(
    "PostgreSQL was never dependent on the Redis restart (attempt row intact)",
    Boolean(attemptRowBefore) && attemptRowBefore.status === "SUBMITTED",
    summarize(attemptRowBefore?.status)
  );
};

const sectionScalability = async ({ recruiterA, recruiterB, jobA, jobB }) => {
  section("J. Scalability — many clients, ONE shared Redis subscription");

  // Three concurrent SSE clients across two jobs (two recruiters' own jobs).
  const clientA1 = await openMockStream(recruiterA.user, jobA.job.id);
  const clientA2 = await openMockStream(recruiterA.user, jobA.job.id);
  const clientB = await openMockStream(recruiterB.user, jobB.job.id);

  const stats = realtimeGateway.getGatewayStats();
  check(
    "three concurrent clients share ONE process subscription (bounded Redis usage)",
    stats.connectedClients === 3 &&
      stats.subscribedJobs === 2 &&
      getRealtimePubSubStats().listenerCount === 2,
    summarize({ gateway: stats, pubsub: getRealtimePubSubStats() })
  );

  await realtimePublisher.publishInvitationEvent({
    jobId: jobA.job.id,
    assessmentId: jobA.assessment.id,
    candidateId: 42,
    candidateEmail: uniqueEmail("scaleA"),
  });
  const a1Got = await waitFor(() =>
    sseDataPayloads(clientA1.res, "candidate-status").find((event) => event.candidateId === 42)
  );
  const a2Got = sseDataPayloads(clientA2.res, "candidate-status").find(
    (event) => event.candidateId === 42
  );
  const bGot = sseDataPayloads(clientB.res, "candidate-status").some(
    (event) => event.jobId === jobA.job.id
  );
  check(
    "an event fans out to EVERY client of the same job",
    Boolean(a1Got) && Boolean(a2Got),
    summarize({ a1: Boolean(a1Got), a2: Boolean(a2Got) })
  );
  check(
    "a client of another job receives nothing from it (per-connection authorization)",
    bGot === false,
    summarize({ bLeaked: bGot })
  );

  await realtimePublisher.publishInvitationEvent({
    jobId: jobB.job.id,
    assessmentId: jobB.assessment.id,
    candidateId: 0,
    candidateEmail: uniqueEmail("scaleB"),
  });
  const bGotOwn = await waitFor(() =>
    sseDataPayloads(clientB.res, "candidate-status").find(
      (event) => event.jobId === jobB.job.id && event.candidateEmail?.endsWith("@example.test")
    )
  );
  check(
    "each job's events reach exactly that job's clients (multi-instance-ready distribution)",
    Boolean(bGotOwn),
    summarize(bGotOwn)
  );

  await closeMockStream(clientA1);
  await closeMockStream(clientA2);
  await closeMockStream(clientB);
  const drained = realtimeGateway.getGatewayStats();
  check(
    "all clients disconnected → zero clients, gateway subscription released",
    drained.connectedClients === 0 &&
      drained.subscriptionActive === false &&
      getRealtimePubSubStats().listenerCount === 1,
    summarize({ gateway: drained, pubsub: getRealtimePubSubStats() })
  );
};

// --- cleanup & report --------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  jobAssessmentAttempt: await prisma.jobAssessmentAttempt.count(),
});

// Deletes exactly what this harness created, in FK-safe order (attempt rows
// reference invitations, so attempts go first). Scoped strictly to tracked ids.
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

const countLeftovers = async () => {
  const [users, jobs, assessments, invitations, attempts, lists] = await Promise.all([
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
    prisma.job.count({ where: { id: { in: tracked.jobIds } } }),
    prisma.jobAssessment.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.jobAssessmentInvitation.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.jobAssessmentAttempt.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.jobCandidateList.count({ where: { jobId: { in: tracked.jobIds } } }),
  ]);
  return users + jobs + assessments + invitations + attempts + lists;
};

// --- runner ------------------------------------------------------------------

const main = async () => {
  console.log(`Phase 4 — recruiter realtime candidate-status verification (${SUFFIX})`);
  const totalsBefore = await snapshotTotals();

  // Job A: 4 candidate rows (0..3), assessment with 2 questions.
  // Job B: recruiter B's own job with 1 row (isolation checks).
  // Job C: started job WITHOUT an assessment (failed-transition checks).
  const recruiterA = await createRecruiterFixture("A");
  const recruiterB = await createRecruiterFixture("B");
  const jobA = await createJobFixture(recruiterA, {
    label: "A",
    rows: [
      ["Candidate Zero", uniqueEmail("c0")],
      ["Candidate One", uniqueEmail("c1")],
      ["Candidate Two", uniqueEmail("c2")],
      ["Candidate Three", uniqueEmail("c3")],
    ],
  });
  await createQuestionFixture(jobA.assessment.id, 1, {
    section: "JOB_OVERVIEW",
    prompt: "Pick the option that best describes your deployment experience.",
    questionType: "SINGLE_CHOICE",
    options: ["Option A", "Option B"],
  });
  await createQuestionFixture(jobA.assessment.id, 2, {
    section: "RESPONSIBILITIES",
    prompt: "Describe a production incident you handled.",
    questionType: "SHORT_ANSWER",
  });
  const jobB = await createJobFixture(recruiterB, {
    label: "B",
    rows: [["Other Candidate", uniqueEmail("b0")]],
  });
  const jobNoAssessment = await createJobFixture(recruiterA, {
    label: "no-assessment",
    rows: [["Nobody", uniqueEmail("n0")]],
    withAssessment: false,
  });

  await sectionRedisOutage({ recruiterA, jobA });
  await sectionInfrastructure();
  sectionEventModel();
  await sectionAuthorization({ recruiterA, recruiterB, jobA, jobB, jobNoAssessment });
  const { row1Email } = await sectionPhase2({ recruiterA, jobA, jobNoAssessment });
  await sectionPhase3({ recruiterA, jobA, row1Email });
  await sectionPhase3Terminal({ recruiterA, jobA, row1Email });
  await sectionIdentity({ jobA, jobB });
  await sectionDuplicateSafety({ recruiterA, jobA, row1Email });
  await sectionReconnect({ recruiterA, jobA, row1Email });
  await sectionScalability({ recruiterA, recruiterB, jobA, jobB });

  section("K. Cleanup & leftovers");
  await stopRecorder();
  await realtimeGateway.closeAllStreams();
  await closeRealtimePubSub();
  const removed = await cleanup();
  const leftovers = await countLeftovers();
  check(
    "every fixture row was removed (no leftovers in PostgreSQL)",
    leftovers === 0,
    summarize({ removed, leftovers })
  );

  const passed = results.filter((entry) => entry.ok).length;
  const failed = results.length - passed;
  console.log(`\n========================================`);
  console.log(
    `PASS ${passed} / ${results.length}${failed > 0 ? `  — ${failed} FAILED` : "  — ALL GREEN"}`
  );
  console.log(`========================================`);

  const totalsAfter = await snapshotTotals();
  console.log(`platform totals before: ${summarize(totalsBefore)}`);
  console.log(`platform totals after:  ${summarize(totalsAfter)}`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
};

main().catch(async (error) => {
  console.error(`\nFATAL: ${error.message}`);
  console.error(error.stack);
  try {
    await stopRecorder();
    await realtimeGateway.closeAllStreams();
    await closeRealtimePubSub();
    await cleanup();
  } catch (cleanupError) {
    console.error(`cleanup after failure also failed: ${cleanupError.message}`);
  }
  await prisma.$disconnect();
  process.exit(1);
});
















