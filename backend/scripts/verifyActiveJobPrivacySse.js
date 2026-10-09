/* eslint-disable no-console */
// PHASE 3 FINAL VERIFICATION — live Redis-backed SSE privacy.
//
// This is VERIFICATION ONLY. It changes no production code: it drives the REAL
// gateway (realtimeGateway.openJobStream) and the REAL Redis transport
// (publishRealtimeEvent) with TWO simultaneous subscribers on the SAME ACTIVE job:
//
//   * an ORG_ADMIN  -> must receive job-level data only, marked restricted
//   * the RECRUITER -> must keep the existing candidate-level payload
//
// It proves the per-recipient redaction actually works end-to-end through Redis,
// which the unit-level assertions cannot, and that the shared (frozen) event
// object is NOT mutated for one recipient by the other's redaction.
//
// Requires a reachable Redis at REDIS_URL (the project vendors Memurai for this).
require("dotenv").config();

const http = require("node:http");
const { EventEmitter } = require("node:events");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prisma = require("../src/config/prisma");
const generateAccessToken = require("../src/utils/generateAccessToken");
const realtimeGateway = require("../src/module/realtime/realtime.gateway");
const { publishRealtimeEvent } = require("../src/config/redis.pubsub");
const { REALTIME_EVENT_TYPES } = require("../src/module/job/jobAssessmentRealtime.events");
const {
  attachJobCandidateList,
  cleanupJobCandidateLists,
} = require("./jobCandidateListFixture");

const results = [];
const tracked = { userIds: [], planIds: [], subscriptionIds: [], organizationIds: [], jobIds: [] };
let httpServer = null;

const section = (t) => console.log(`\n${t}`);
const summarize = (v) => JSON.stringify(v ?? null);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${!ok && detail ? `\n        -> ${detail}` : ""}`);
};

const createUser = async (label, roleName) => {
  const user = await prisma.user.create({
    data: {
      fullName: `P3SSE ${label}`, email: `p3sse-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL", emailVerified: true, status: "ACTIVE", mustChangePassword: false,
    },
  });
  const role = await prisma.role.upsert({ where: { name: roleName }, update: {}, create: { name: roleName, description: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  tracked.userIds.push(user.id);
  return { id: user.id, role: roleName, email: user.email, fullName: user.fullName };
};

const createOrganizationFixture = async () => {
  const owner = await createUser("org-admin", "ORG_ADMIN");
  const organization = await prisma.organization.create({
    data: { name: `P3SSE org ${SUFFIX}`, ownerId: owner.id, status: "ACTIVE" },
  });
  tracked.organizationIds.push(organization.id);
  await prisma.organizationMembership.create({
    data: { userId: owner.id, organizationId: organization.id, role: "ORG_ADMIN", status: "ACTIVE" },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: { name: `P3SSE OrgPlan ${SUFFIX}`, type: "ORGANIZATION", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50, maxUsers: 20 },
  });
  const subscription = await prisma.subscription.create({
    data: { planId: plan.id, organizationId: organization.id, status: "ACTIVE", startDate: new Date(), expiryDate: new Date(Date.now() + 30 * 86400000) },
  });
  tracked.planIds.push(plan.id);
  tracked.subscriptionIds.push(subscription.id);

  const recruiter = await createUser("recruiter", "RECRUITER");
  await prisma.organizationMembership.create({
    data: { userId: recruiter.id, organizationId: organization.id, role: "RECRUITER", status: "ACTIVE" },
  });
  return { owner, recruiter, organization };
};

// Drives the REAL gateway with a capture-only response, exactly the pattern the
// existing realtime harness uses (the gateway is controller-thin).
const openStream = async (user, jobId) => {
  const req = new EventEmitter();
  req.user = user;
  req.params = { jobId };
  const res = {
    statusCode: null, headers: null, body: "", jsonPayload: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { this.body += chunk; return true; },
    status(code) {
      this.statusCode = code;
      return { json: (payload) => { this.jsonPayload = payload; } };
    },
    json(payload) { this.jsonPayload = payload; },
  };
  await realtimeGateway.openJobStream(req, res);
  return { req, res };
};

const ssePayloads = (res, eventName) => {
  const out = [];
  for (const frame of res.body.split("\n\n")) {
    if (!frame.includes(`event: ${eventName}`)) continue;
    const line = frame.split("\n").find((l) => l.startsWith("data: "));
    if (line) { try { out.push(JSON.parse(line.slice(6))); } catch {} }
  }
  return out;
};
const main = async () => {
  // =========================================================================
  section("A. Redis is genuinely reachable (precondition)");
  // =========================================================================
  const IORedis = require("ioredis");
  const probe = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  let redisOk = false;
  try { redisOk = (await probe.ping()) === "PONG"; } catch { redisOk = false; }
  check("Redis responds to PING at REDIS_URL", redisOk, "Redis is not reachable");
  if (!redisOk) {
    console.log("\n  Redis unavailable — this harness cannot run. It was NOT skipped silently.");
    process.exitCode = 1;
    return;
  }
  probe.disconnect();

  const { owner, recruiter, organization } = await createOrganizationFixture();

  // An ACTIVE job with a real candidate, so the events below describe real data.
  const job = await prisma.job.create({
    data: {
      title: `P3SSE job ${SUFFIX}`, description: "d", yearsExperience: 3,
      recruiterId: null, organizationId: organization.id, createdByUserId: recruiter.id,
      status: "DRAFT", createdAt: new Date(), startedAt: new Date(),
      analysisEndsAt: new Date(Date.now() + 10 * 86400000),
    },
  });
  tracked.jobIds.push(job.id);
  await attachJobCandidateList({ user: recruiter }, job.id, { count: 2 });

  const candidateEmail = `p3sse-candidate-${SUFFIX}@example.test`;
  const reference = await prisma.jobCandidateReference.create({
    data: {
      jobId: job.id, candidateEmail, candidateName: `P3SSE Candidate ${SUFFIX}`,
      resumeText: "SSE-RESUME-MARKER", linkedinText: "SSE-LINKEDIN-MARKER",
      githubText: "SSE-GITHUB-MARKER", createdByUserId: recruiter.id,
    },
  });
  const assessment = await prisma.jobAssessment.create({
    data: { jobId: job.id, title: "A", status: "FINALIZED", durationSeconds: 600, publicId: `p3sse-${job.id}`.slice(0, 40), finalizedAt: new Date(), activatedAt: new Date() },
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "ACTIVE" } });
  // =========================================================================
  section("B. Two subscribers on the SAME ACTIVE job: ORG_ADMIN + RECRUITER");
  // =========================================================================

  const adminStream = await openStream(owner, job.id);
  const recruiterStream = await openStream(recruiter, job.id);
  check("the ORG_ADMIN stream opened (200)", adminStream.res.statusCode === 200, summarize({ status: adminStream.res.statusCode, body: adminStream.res.jsonPayload }));
  check("the RECRUITER stream opened (200)", recruiterStream.res.statusCode === 200, summarize({ status: recruiterStream.res.statusCode, body: recruiterStream.res.jsonPayload }));

  // Publish ONE real event through Redis. The SAME object is handed to both.
  const published = Object.freeze({
    eventType: REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED,
    jobId: job.id,
    assessmentId: assessment.id,
    candidateId: reference.id,
    candidateEmail,
    assessmentStatus: "SUBMITTED",
    occurredAt: new Date().toISOString(),
  });
  // publishRealtimeEvent returns { published, receivers }. `receivers` counts Redis
  // SUBSCRIBERS (the gateway deliberately uses ONE shared, ref-counted
  // subscription per process for all clients of a job), not one per browser — so
  // 1 is the correct, expected value here with two clients on the same job.
  const delivered = await publishRealtimeEvent({ ...published });
  check("the event was published to the shared Redis channel",
    delivered?.published === true && delivered?.receivers >= 1, summarize(delivered));

  await new Promise((r) => setTimeout(r, 1200));

  const adminEvents = ssePayloads(adminStream.res, "candidate-status");
  const recruiterEvents = ssePayloads(recruiterStream.res, "candidate-status");
  check("the ORG_ADMIN received the event frame", adminEvents.length >= 1, summarize({ count: adminEvents.length }));
  check("the RECRUITER received the event frame", recruiterEvents.length >= 1, summarize({ count: recruiterEvents.length }));

  const adminEvent = adminEvents[adminEvents.length - 1] ?? {};
  const recruiterEvent = recruiterEvents[recruiterEvents.length - 1] ?? {};

  // ---- ORG_ADMIN on an ACTIVE job: job-level only, explicitly restricted ----
  check("ORG_ADMIN receives job-level event information",
    adminEvent.jobId === job.id && adminEvent.eventType === REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED && Boolean(adminEvent.assessmentId),
    summarize(adminEvent));
  check("ORG_ADMIN receives candidateDataRestricted: true", adminEvent.candidateDataRestricted === true, summarize(adminEvent));
  check("ORG_ADMIN receives NO candidateEmail", !("candidateEmail" in adminEvent), summarize(adminEvent));
  check("ORG_ADMIN receives NO candidateId", !("candidateId" in adminEvent), summarize(adminEvent));
  check("ORG_ADMIN receives no candidate name, evidence, score, answers, analysis, verification or cheating data",
    !JSON.stringify(adminEvent).includes(candidateEmail) &&
    !JSON.stringify(adminEvent).includes("SSE-") &&
    !/score|answer|analysisResult|cheat|integrity|verification|resume|linkedin|github/i.test(JSON.stringify(adminEvent)),
    summarize(adminEvent));
  // ---- RECRUITER on the same stream: existing behaviour must be intact ----
  check("RECRUITER still receives candidateEmail on the SAME stream", recruiterEvent.candidateEmail === candidateEmail, summarize(recruiterEvent));
  // `candidateId` is the persisted EXCEL ROW identity when the producing flow knows
  // it, and null otherwise (documented in jobAssessmentRealtime.events). This
  // fixture has no Excel row id, so the sanitizer correctly normalizes it to null —
  // asserted so the difference from redaction (which REMOVES the key) stays clear.
  check("RECRUITER's candidateId is present-and-null (sanitizer semantics), not redacted away",
    "candidateId" in recruiterEvent && recruiterEvent.candidateId === null, summarize(recruiterEvent));
  check("RECRUITER does NOT get the restricted marker", !("candidateDataRestricted" in recruiterEvent), summarize(recruiterEvent));
  check("RECRUITER still receives the per-candidate assessment status", recruiterEvent.assessmentStatus === "SUBMITTED", summarize(recruiterEvent));

  // ---- The shared event must not be mutated between recipients ----
  check("the published event object was NOT mutated by redaction",
    published.candidateEmail === candidateEmail && published.candidateId === reference.id && !("candidateDataRestricted" in published),
    summarize({ email: published.candidateEmail, id: published.candidateId }));
  check("the two recipients received genuinely different payloads",
    JSON.stringify(adminEvent) !== JSON.stringify(recruiterEvent), "both recipients received an identical payload");

  // ---- CLOSED job: the ORG_ADMIN regains candidate-level detail ----
  // =========================================================================
  section("C. CLOSED job — a FRESH connection regains candidate detail");
  // =========================================================================
  await prisma.job.update({ where: { id: job.id }, data: { status: "CLOSED", closedAt: new Date(), closedReason: "RECRUITER_CLOSED" } });
  await new Promise((r) => setTimeout(r, 400));

  // (a) The ALREADY-OPEN admin stream keeps redacting. Its job row is a snapshot
  // from connect time, so a mid-stream close does NOT lift redaction. This is
  // fail-CLOSED: it can only withhold more, never leak.
  await publishRealtimeEvent({ ...published });
  await new Promise((r) => setTimeout(r, 1200));
  const adminExisting = ssePayloads(adminStream.res, "candidate-status").pop() ?? {};
  check("the pre-existing ORG_ADMIN stream stays redacted after the job closes (fail-closed snapshot)",
    adminExisting.candidateDataRestricted === true && !("candidateEmail" in adminExisting), summarize(adminExisting));

  // (b) A NEW connection reads the persisted CLOSED status and therefore regains
  // candidate-level detail. This proves the policy re-evaluates real DB state and
  // that no candidate data is permanently withheld.
  const adminReconnect = await openStream(owner, job.id);
  check("the ORG_ADMIN can reconnect to the CLOSED job", adminReconnect.res.statusCode === 200, summarize({ status: adminReconnect.res.statusCode }));
  await publishRealtimeEvent({ ...published });
  await new Promise((r) => setTimeout(r, 1200));
  const adminAfter = ssePayloads(adminReconnect.res, "candidate-status").pop() ?? {};
  check("ORG_ADMIN receives candidateEmail again on a fresh stream once CLOSED", adminAfter.candidateEmail === candidateEmail, summarize(adminAfter));
  check("ORG_ADMIN no longer sees the restricted marker once CLOSED", !("candidateDataRestricted" in adminAfter), summarize(adminAfter));

  realtimeGateway.closeAllStreams?.();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\n  FAILED:");
    failed.forEach((f) => console.log(`   - ${f.label}`));
  }
  process.exitCode = failed.length ? 1 : 0;
};

const cleanup = async () => {
  try {
    await cleanupJobCandidateLists(prisma, tracked.jobIds);
    if (tracked.jobIds.length) await prisma.job.deleteMany({ where: { id: { in: tracked.jobIds } } });
    if (tracked.subscriptionIds.length) await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } });
    if (tracked.organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: tracked.organizationIds } } });
    if (tracked.userIds.length) await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } });
    if (tracked.planIds.length) await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } });
  } catch (error) {
    console.error("cleanup failed:", error.message);
  }
};

main()
  .catch((error) => { console.error("\nHARNESS ERROR:", error); process.exitCode = 1; })
  .finally(async () => {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await cleanup();
    await prisma.$disconnect();
  });