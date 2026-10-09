/* eslint-disable no-console */
// PHASE 4 — MAIN ORGANIZATION DASHBOARD.
//
// Covers, against a real PostgreSQL database and the REAL Express server:
//
//   A. Summary metrics      — every §1 figure, from its persisted source.
//   B. Assessment activity  — org-level persisted attempt lifecycle.
//   C. Trends               — org-scoped, server-side aggregation, dense series.
//   D. Date-range behaviour — the six existing ORG_RANGE_OPTIONS conventions.
//   E. Empty organization   — a brand-new org with no data at all.
//   F. Cross-org isolation  — org B must never see org A's numbers, and a
//                             client-supplied organizationId must be ignored.
//   G. Hiring contract      — available:false and null (never 0).
//   H. Query/N+1 behaviour  — constant query count as the org grows.
//   I. No candidate-level leakage in the dashboard payloads.
//
// Requires Redis (the project vendors Memurai) because the app imports the
// realtime/BullMQ layer on boot.
require("dotenv").config();

const http = require("node:http");
const path = require("node:path");
const net = require("node:net");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prisma = require("../src/config/prisma");
const generateAccessToken = require("../src/utils/generateAccessToken");

const results = [];
const tracked = { users: [], plans: [], subs: [], orgs: [], jobs: [] };
let server = null;

const section = (t) => console.log(`\n${t}`);
const summarize = (v) => JSON.stringify(v ?? null);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${!ok && detail ? `\n        -> ${detail}` : ""}`);
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const request = (origin, path, { token, method = "GET" } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch {}
          resolve({ status: res.statusCode, json, body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });

const createUser = async (label, roleName) => {
  const user = await prisma.user.create({
    data: {
      fullName: `P4 ${label}`, email: `p4-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL", emailVerified: true, status: "ACTIVE", mustChangePassword: false,
    },
  });
  tracked.users.push(user.id);

  // A real UserRole row is REQUIRED: authenticate() rebuilds the account's roles
  // from the database and rejects (401 UNAUTHORIZED) any token whose claimed role
  // is not actually assigned. ORG_ADMIN additionally needs an ACTIVE org
  // membership, which createOrg below creates.
  const role = await prisma.role.upsert({
    where: { name: roleName },
    update: {},
    create: { name: roleName, description: roleName },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

  return user;
};

// The access-token payload is keyed `userId` (+ role), matching every other
// verification harness. Passing `{ id }` yields a token whose subject is
// `undefined`, which authenticate() correctly rejects as a 401.
const tokenFor = (user, role) => generateAccessToken({ userId: user.id, role });

const createOrg = async (label, { subscribe = true } = {}) => {
  const admin = await createUser(`${label}-admin`, "ORG_ADMIN");
  const org = await prisma.organization.create({
    data: { name: `P4 ${label} ${SUFFIX}`, ownerId: admin.id, status: "ACTIVE" },
  });
  tracked.orgs.push(org.id);
  await prisma.organizationMembership.create({
    data: { userId: admin.id, organizationId: org.id, role: "ORG_ADMIN", status: "ACTIVE" },
  });

  if (subscribe) {
    const plan = await prisma.subscriptionPlan.create({
      data: { name: `P4 ${label} ${SUFFIX}`, type: "ORGANIZATION", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50, maxUsers: 5 },
    });
    tracked.plans.push(plan.id);
    const sub = await prisma.subscription.create({
      data: {
        planId: plan.id, organizationId: org.id, status: "ACTIVE",
        startDate: new Date(), expiryDate: new Date(Date.now() + 30 * 86400000),
      },
    });
    tracked.subs.push(sub.id);
  }
  return { admin, org, token: tokenFor(admin, "ORG_ADMIN") };
};

const createRecruiter = async (label, org) => {
  const user = await createUser(`${label}-rec`, "RECRUITER");
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: org.id, role: "RECRUITER", status: "ACTIVE" },
  });
  return user;
};

// Months-ago helper so the trend/range checks operate on genuinely OLD rows.
const monthsAgo = (n, day = 15) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day, 12, 0, 0));
};

const createJob = async (org, recruiter, { createdAt, status = "ACTIVE" } = {}) => {
  const job = await prisma.job.create({
    data: {
      title: `P4 job ${SUFFIX}`, description: "d", yearsExperience: 3,
      organizationId: org.id, createdByUserId: recruiter.id, status: "DRAFT",
      createdAt, startedAt: createdAt,
      analysisEndsAt: new Date(Date.now() + 10 * 86400000),
    },
  });
  tracked.jobs.push(job.id);
  if (status !== "DRAFT") await prisma.job.update({ where: { id: job.id }, data: { status } });
  return job;
};

// Real persisted attempt lifecycle rows — the ONLY source the dashboard may read.
const createAttempt = async (job, { status, startedAt, submittedAt = null, timedOutAt = null, cheatedAt = null, email }) => {
  // One JobAssessment per job (the schema enforces it), so reuse the job's own
  // assessment rather than creating a second one per attempt.
  const assessment =
    (await prisma.jobAssessment.findFirst({ where: { jobId: job.id } })) ??
    (await prisma.jobAssessment.create({
      data: {
        jobId: job.id, title: "A", status: "FINALIZED", durationSeconds: 600,
        publicId: `p4-${job.id}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 40),
        finalizedAt: new Date(), activatedAt: new Date(),
      },
    }));
  const invitation = await prisma.jobAssessmentInvitation.create({
    data: {
      assessmentId: assessment.id, jobId: job.id, email,
      status: "EMAIL_VERIFIED",
      invitedAt: new Date(startedAt.getTime()), expiresAt: new Date(startedAt.getTime() + 7 * 86400000),
      emailVerifiedAt: new Date(startedAt.getTime()),
    },
  });
  return prisma.jobAssessmentAttempt.create({
    data: {
      jobId: job.id, assessmentId: assessment.id, invitationId: invitation.id,
      email, status, startedAt, deadlineAt: new Date(startedAt.getTime() + 600000),
      submittedAt, timedOutAt, cheatedAt,
    },
  });
};
const main = async () => {
  const IORedis = require("ioredis");
  const probe = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  try { check("Redis is reachable (app boot requires it)", (await probe.ping()) === "PONG"); }
  catch { check("Redis is reachable (app boot requires it)", false, "Redis unreachable"); }
  probe.disconnect();

  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    server = http.createServer(require("../src/app"));
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((r) => setTimeout(r, 800));

  section("Fixture — org A: two recruiters, jobs across months, real attempt lifecycle");
  const A = await createOrg("A");
  const Arec1 = await createRecruiter("a1", A.org);
  const Arec2 = await createRecruiter("a2", A.org);

  const jobOld = await createJob(A.org, Arec1, { createdAt: monthsAgo(4), status: "CLOSED" });
  const jobMid = await createJob(A.org, Arec1, { createdAt: monthsAgo(1), status: "ACTIVE" });
  const jobNew = await createJob(A.org, Arec2, { createdAt: new Date(), status: "ACTIVE" });

  await prisma.jobCandidateReference.create({
    data: { jobId: jobOld.id, candidateEmail: `p4-old-${SUFFIX}@example.test`, candidateName: "P4 Old", createdByUserId: Arec1.id, createdAt: monthsAgo(4) },
  });
  await prisma.jobCandidateReference.create({
    data: { jobId: jobNew.id, candidateEmail: `p4-new-${SUFFIX}@example.test`, candidateName: "P4 New", createdByUserId: Arec2.id, createdAt: new Date() },
  });

  // Real persisted lifecycle: SUBMITTED, TIMED_UP, CHEATED, STARTED, IN_PROGRESS.
  await createAttempt(jobOld, { status: "SUBMITTED", startedAt: monthsAgo(4), submittedAt: monthsAgo(4), email: `p4-s1-${SUFFIX}@example.test` });
  await createAttempt(jobMid, { status: "TIMED_UP", startedAt: monthsAgo(1), timedOutAt: monthsAgo(1), email: `p4-s2-${SUFFIX}@example.test` });
  await createAttempt(jobMid, { status: "CHEATED", startedAt: monthsAgo(1), cheatedAt: monthsAgo(1), email: `p4-s3-${SUFFIX}@example.test` });
  await createAttempt(jobNew, { status: "STARTED", startedAt: new Date(), email: `p4-s4-${SUFFIX}@example.test` });
  await createAttempt(jobNew, { status: "IN_PROGRESS", startedAt: new Date(), email: `p4-s5-${SUFFIX}@example.test` });

  const summaryRes = await request(origin, "/api/organization/dashboard/summary", { token: A.token });
  const s = summaryRes.json?.data ?? {};

  section("A. Summary metrics (all-time) match the persisted rows");
  check("GET /dashboard/summary returns 200", summaryRes.status === 200, summarize(summaryRes.json));
  check("organization is the SERVER-resolved org", s.organization?.id === A.org.id, summarize(s.organization));
  check("total recruiters = 2 (real membership rows)", s.recruiters?.total === 2, summarize(s.recruiters));
  check("active recruiters = 2", s.recruiters?.active === 2, summarize(s.recruiters));
  check("total jobs = 3 (real Job rows)", s.jobs?.total === 3, summarize(s.jobs));
  check("active jobs = 2", s.jobs?.active === 2, summarize(s.jobs));
  check("closed jobs = 1", s.jobs?.closed === 1, summarize(s.jobs));
  check("total candidates = 2 (real JobCandidateReference rows)", s.candidates?.total === 2, summarize(s.candidates));
  check("recruiter seat limit = plan maxUsers minus the admin seat", s.seats?.limit === 4, summarize(s.seats));
  check("recruiter seats used = 2 active recruiters", s.seats?.used === 2, summarize(s.seats));
  check("recruiter seats remaining = limit - used", s.seats?.remaining === 2, summarize(s.seats));
  check("subscription expiry is a real persisted date", Boolean(s.subscription?.expiryDate), summarize(s.subscription));
  check("subscription reported ACTIVE", s.subscription?.active === true, summarize(s.subscription));
  section("B. Organization-level assessment activity (persisted lifecycle)");
  const a = s.assessments ?? {};
  check("assessments.total = 5 attempts", a.total === 5, summarize(a));
  check("assessments.submitted = 1", a.submitted === 1, summarize(a));
  check("assessments.timedUp = 1", a.timedUp === 1, summarize(a));
  check("assessments.cheated = 1", a.cheated === 1, summarize(a));
  check("assessments.started = 1 (raw STARTED state, not merged away)", a.started === 1, summarize(a));
  check("assessments.inProgressRaw = 1 (raw IN_PROGRESS state)", a.inProgressRaw === 1, summarize(a));
  check("assessments.inProgress = 2 (STARTED + IN_PROGRESS: existing platform meaning)", a.inProgress === 2, summarize(a));
  check("assessments.completionRate = submitted/total = 20", a.completionRate === 20, summarize(a));
  const bucketSum = a.started + a.inProgressRaw + a.submitted + a.timedUp + a.cheated;
  check("every attempt is accounted for in exactly one persisted state", bucketSum === a.total, summarize({ bucketSum, total: a.total }));

  section("G. Hiring contract — unavailable, never zero");
  const h = s.hiring ?? {};
  check("hiring.available is false", h.available === false, summarize(h));
  check("hiring.hired is null (NOT 0)", h.hired === null, summarize(h.hired));
  check("hiring.notHired is null (NOT 0)", h.notHired === null, summarize(h.notHired));
  check("hiring.hiringRate is null", h.hiringRate === null, summarize(h.hiringRate));
  check("hiring.totalCandidates is the real candidate count", h.totalCandidates === 2, summarize(h.totalCandidates));
  check("hiring carries an explicit human-readable reason", typeof h.reason === "string" && h.reason.length > 0, summarize(h.reason));

  section("I. The dashboard payload carries NO candidate-level data");
  const wholePayload = JSON.stringify(summaryRes.json);
  check("no candidate email in the summary payload", !wholePayload.includes(`p4-old-${SUFFIX}@example.test`) && !wholePayload.includes(`p4-new-${SUFFIX}@example.test`), "candidate email leaked");
  check("no candidate name in the summary payload", !wholePayload.includes("P4 Old") && !wholePayload.includes("P4 New"), "candidate name leaked");
  check("no candidate score in the summary payload", !/"score"|"scorePercentage"|"maxScore"/.test(wholePayload), "score leaked");
  check("hiring is not inferred from a score/analysis field", !/"hireded"|"hiredCount"\s*:\s*[1-9]/.test(wholePayload), "a numeric hired value leaked");

  section("C. Trends — organization-scoped, server-side, dense series");
  const allRes = await request(origin, "/api/organization/dashboard/analytics?range=ALL", { token: A.token });
  const all = allRes.json?.data ?? {};
  check("GET /dashboard/analytics returns 200", allRes.status === 200, summarize(allRes.json));
  check("analytics organizationId is the server-resolved org", all.organizationId === A.org.id, summarize(all.organizationId));
  const series = Array.isArray(all.series) ? all.series : [];
  check("series is non-empty for ALL time", series.length > 0, summarize({ length: series.length }));
  check("series is DENSE (every bucket has a YYYY-MM key)", series.every((p) => /^\d{4}-\d{2}$/.test(p.bucket)), summarize(series.map((p) => p.bucket)));
  check("series is ordered ascending", series.every((p, i) => i === 0 || p.bucket > series[i - 1].bucket), summarize(series.map((p) => p.bucket)));
  check("series is capped at 24 buckets", series.length <= 24, summarize({ length: series.length }));
  const totalPosted = series.reduce((acc, p) => acc + (p.jobsPosted || 0), 0);
  check("jobs trend sums to the org's 3 real jobs", totalPosted === 3, summarize({ totalPosted }));
  const totalAdded = series.reduce((acc, p) => acc + (p.candidatesAdded || 0), 0);
  check("candidates trend sums to the org's 2 real candidates", totalAdded === 2, summarize({ totalAdded }));
  const totalAttempts = series.reduce((acc, p) => acc + (p.assessmentsStarted || 0), 0);
  check("assessment trend sums to the org's 5 real attempts", totalAttempts === 5, summarize({ totalAttempts }));
  const oldBucket = series.find((p) => p.bucket === monthsAgo(4).toISOString().slice(0, 7));
  check("the 4-months-ago bucket carries that month's job", oldBucket?.jobsPosted === 1, summarize(oldBucket));
  check("the current bucket carries the new job", series[series.length - 1]?.jobsPosted === 1, summarize(series[series.length - 1]));
  check("analytics.hiring repeats the same unavailable contract", all.hiring?.available === false && all.hiring?.hired === null, summarize(all.hiring));
  check("analytics.assessments is present", typeof all.assessments?.total === "number", summarize(all.assessments));
  section("D. Date-range behaviour — the six EXISTING conventions, server-side");
  const monthRes = await request(origin, "/api/organization/dashboard/analytics?range=MONTH", { token: A.token });
  const month = monthRes.json?.data ?? {};
  check("range=MONTH resolves to the THIS_MONTH window", month.range?.label === "THIS_MONTH" && month.range?.from !== null, summarize(month.range));
  check("range=MONTH narrows the trend to 1 bucket", month.series?.length === 1, summarize({ len: month.series?.length, buckets: month.series?.map((p) => p.bucket) }));
  check("range=MONTH excludes the 4-months-ago job", (month.series ?? []).reduce((acc, p) => acc + (p.jobsPosted || 0), 0) === 1, summarize(month.series));
  check("range=MONTH reports only the current month's attempts", month.assessments?.total === 2, summarize(month.assessments));

  const last30 = await request(origin, "/api/organization/dashboard/analytics?range=LAST_30_DAYS", { token: A.token });
  check("range=LAST_30_DAYS resolves to a ~30-day window", last30.json?.data?.range?.label === "LAST_30_DAYS" && Math.abs(Date.now() - new Date(last30.json.data.range.from).getTime() - 30 * 86400000) < 5000, summarize(last30.json?.data?.range));

  const last6 = await request(origin, "/api/organization/dashboard/analytics?range=LAST_6_MONTHS", { token: A.token });
  const l6 = last6.json?.data ?? {};
  check("range=LAST_6_MONTHS resolves", l6.range?.label === "LAST_6_MONTHS" && l6.range?.from !== null, summarize(l6.range));
  check("range=LAST_6_MONTHS keeps the 4-months-ago job", (l6.series ?? []).reduce((acc, p) => acc + (p.jobsPosted || 0), 0) === 3, summarize(l6.series?.map((p) => p.bucket)));
  check("LAST_6_MONTHS series has 6 buckets", l6.series?.length === 6, summarize({ len: l6.series?.length }));

  const last3 = await request(origin, "/api/organization/dashboard/analytics?range=LAST_3_MONTHS", { token: A.token });
  const l3 = last3.json?.data ?? {};
  check("range=LAST_3_MONTHS resolves", l3.range?.label === "LAST_3_MONTHS" && l3.range?.from !== null, summarize(l3.range));
  check("range=LAST_3_MONTHS drops the 4-months-ago job", (l3.series ?? []).reduce((acc, p) => acc + (p.jobsPosted || 0), 0) === 2, summarize(l3.series?.map((p) => p.bucket)));

  const customFrom = monthsAgo(4).toISOString().slice(0, 10);
  const customTo = monthsAgo(1).toISOString().slice(0, 10);
  const custom = await request(origin, `/api/organization/dashboard/analytics?from=${customFrom}&to=${customTo}`, { token: A.token });
  const cu = custom.json?.data ?? {};
  check("explicit from/to resolves to the CUSTOM window", cu.range?.label === "CUSTOM", summarize(cu.range));
  check("CUSTOM trend spans exactly the 4 requested months", cu.series?.length === 4, summarize({ len: cu.series?.length, buckets: cu.series?.map((p) => p.bucket) }));
  check("CUSTOM trend excludes the current month's job", (cu.series ?? []).reduce((acc, p) => acc + (p.jobsPosted || 0), 0) === 2, summarize(cu.series?.map((p) => [p.bucket, p.jobsPosted])));

  const badRange = await request(origin, "/api/organization/dashboard/analytics?range=NOPE", { token: A.token });
  check("an unknown range is rejected with 422", badRange.status === 422, summarize({ status: badRange.status }));
  const badDates = await request(origin, "/api/organization/dashboard/analytics?from=15-01-2026", { token: A.token });
  check("a malformed date is rejected with 422", badDates.status === 422, summarize({ status: badDates.status }));
  const inverted = await request(origin, "/api/organization/dashboard/analytics?from=2026-06-01&to=2026-01-01", { token: A.token });
  check("an inverted range is rejected with 422", inverted.status === 422, summarize({ status: inverted.status }));
  section("F. Cross-organization isolation");
  const B = await createOrg("B");
  const Brec = await createRecruiter("b1", B.org);
  const Bjob = await createJob(B.org, Brec, { createdAt: new Date(), status: "ACTIVE" });
  await createAttempt(Bjob, { status: "SUBMITTED", startedAt: new Date(), submittedAt: new Date(), email: `p4-b-${SUFFIX}@example.test` });

  const bSum = await request(origin, "/api/organization/dashboard/summary", { token: B.token });
  const bs = bSum.json?.data ?? {};
  check("org B sees exactly its own 1 job", bs.jobs?.total === 1, summarize(bs.jobs));
  check("org B sees only its own 1 recruiter", bs.recruiters?.total === 1, summarize(bs.recruiters));
  check("org B sees 0 candidates (none of its own)", bs.candidates?.total === 0, summarize(bs.candidates));
  check("org B sees only its own 1 attempt", bs.assessments?.total === 1, summarize(bs.assessments));
  check("org B never sees org A's 3 jobs", bs.jobs?.total !== 3, summarize(bs.jobs));

  const bAnalytics = await request(origin, "/api/organization/dashboard/analytics?range=ALL", { token: B.token });
  const bSeries = bAnalytics.json?.data?.series ?? [];
  check("org B's trend contains only org B's job", bSeries.reduce((acc, p) => acc + (p.jobsPosted || 0), 0) === 1, summarize(bSeries.map((p) => [p.bucket, p.jobsPosted])));
  check("org B's trend contains no org A attempts", bSeries.reduce((acc, p) => acc + (p.assessmentsStarted || 0), 0) === 1, summarize(bSeries.map((p) => [p.bucket, p.assessmentsStarted])));

  // A client-supplied organizationId must be IGNORED, never honoured.
  const spoof = await request(origin, `/api/organization/dashboard/summary?organizationId=${B.org.id}`, { token: A.token });
  check("a client-supplied organizationId is ignored (summary stays org A)", spoof.json?.data?.organization?.id === A.org.id, summarize(spoof.json?.data?.organization));
  check("the spoofed request still returns org A's own 3 jobs", spoof.json?.data?.jobs?.total === 3, summarize(spoof.json?.data?.jobs));
  const spoofA = await request(origin, `/api/organization/dashboard/analytics?range=ALL&organizationId=${B.org.id}`, { token: A.token });
  check("a client-supplied organizationId is ignored (analytics stays org A)", spoofA.json?.data?.organizationId === A.org.id, summarize(spoofA.json?.data?.organizationId));

  const noAuth = await request(origin, "/api/organization/dashboard/summary");
  check("an unauthenticated summary request is rejected 401", noAuth.status === 401, summarize({ status: noAuth.status }));
  const asRecruiter = await request(origin, "/api/organization/dashboard/summary", { token: tokenFor(Arec1, "RECRUITER") });
  check("a RECRUITER cannot read the ORG_ADMIN dashboard (403)", asRecruiter.status === 403, summarize({ status: asRecruiter.status }));

  section("E. Empty organization — no data is not an error");
  const E = await createOrg("E");
  const eSum = await request(origin, "/api/organization/dashboard/summary", { token: E.token });
  const es = eSum.json?.data ?? {};
  check("empty org summary returns 200 (not an error)", eSum.status === 200, summarize(eSum.json));
  check("empty org has 0 recruiters", es.recruiters?.total === 0, summarize(es.recruiters));
  check("empty org has 0 jobs", es.jobs?.total === 0, summarize(es.jobs));
  check("empty org has 0 candidates", es.candidates?.total === 0, summarize(es.candidates));
  check("empty org has 0 assessment activity", es.assessments?.total === 0, summarize(es.assessments));
  check("empty org completionRate is null, not 0", es.assessments?.completionRate === null, summarize(es.assessments?.completionRate));
  const eAnalytics = await request(origin, "/api/organization/dashboard/analytics?range=ALL", { token: E.token });
  check("empty org analytics returns 200", eAnalytics.status === 200, summarize(eAnalytics.json));
  const eSeries = eAnalytics.json?.data?.series ?? [];
  check("empty org still gets a dense zero-filled series", eSeries.length > 0 && eSeries.every((p) => (p.jobsPosted || 0) === 0 && (p.candidatesAdded || 0) === 0), summarize({ len: eSeries.length }));
  check("empty org hiring is still the honest unavailable contract", eAnalytics.json?.data?.hiring?.available === false && eAnalytics.json?.data?.hiring?.hired === null, summarize(eAnalytics.json?.data?.hiring));
  check("empty org has 0 used seats", es.seats?.used === 0, summarize(es.seats));
  section("H. Query behaviour — constant as the organization grows (no N+1)");
  // Count the real Prisma model operations issued by ONE dashboard request, then
  // repeat the measurement after growing the organization. If the dashboard looped
  // per recruiter/job/candidate the count would grow with the data; because every
  // figure is a COUNT/GROUP BY, it must not.
  const measureDashboardQueries = async (fn) => {
    const counters = {};
    const models = ["job", "jobCandidateReference", "jobAssessmentAttempt", "jobCandidateAnalysis", "aiJob", "organizationMembership", "user", "subscription", "subscriptionPlan", "jobQuotaConsumption", "organization"];
    const originals = {};
    for (const model of models) {
      const delegate = prisma[model];
      if (!delegate) continue;
      originals[model] = {};
      for (const op of ["count", "findMany", "findFirst", "findUnique", "groupBy", "aggregate"]) {
        const original = delegate[op];
        if (typeof original !== "function") continue;
        originals[model][op] = original;
        delegate[op] = (...args) => {
          counters[`${model}.${op}`] = (counters[`${model}.${op}`] || 0) + 1;
          return original(...args);
        };
      }
    }
    try {
      await fn();
    } finally {
      for (const model of Object.keys(originals)) {
        for (const op of Object.keys(originals[model])) prisma[model][op] = originals[model][op];
      }
    }
    return Object.values(counters).reduce((a, b) => a + b, 0);
  };

  const queriesBefore = await measureDashboardQueries(() =>
    request(origin, "/api/organization/dashboard/analytics?range=ALL", { token: A.token })
  );
  check("dashboard analytics issues a bounded number of model queries", queriesBefore > 0 && queriesBefore <= 25, summarize({ queriesBefore }));
  // PHASE4_SEC_GROW
  // Grow the organization substantially, then re-measure.
  const bulkRecruiters = [];
  for (let i = 0; i < 10; i += 1) bulkRecruiters.push(await createRecruiter(`bulk${i}`, A.org));
  for (let i = 0; i < 10; i += 1) {
    const j = await createJob(A.org, bulkRecruiters[i], { createdAt: monthsAgo(i % 3), status: "ACTIVE" });
    await prisma.jobCandidateReference.create({
      data: { jobId: j.id, candidateEmail: `p4-bulk${i}-${SUFFIX}@example.test`, candidateName: `P4 Bulk ${i}`, createdByUserId: bulkRecruiters[i].id, createdAt: monthsAgo(i % 3) },
    });
  }
  const queriesAfter = await measureDashboardQueries(() =>
    request(origin, "/api/organization/dashboard/analytics?range=ALL", { token: A.token })
  );
  check("query count does NOT grow with 10 more recruiters + 10 jobs + 10 candidates", queriesAfter === queriesBefore, summarize({ queriesBefore, queriesAfter }));

  const grownSum = await request(origin, "/api/organization/dashboard/summary", { token: A.token });
  check("the grown org reports real new recruiter and job totals", grownSum.json?.data?.recruiters?.total === 12 && grownSum.json?.data?.jobs?.total === 13, summarize({ recruiters: grownSum.json?.data?.recruiters?.total, jobs: grownSum.json?.data?.jobs?.total }));
  check("the grown org reports its real candidate total", grownSum.json?.data?.candidates?.total === 12, summarize(grownSum.json?.data?.candidates?.total));

  section("Phase 3 surface still intact alongside the dashboard");
  const jobsList = await request(origin, "/api/organization/dashboard/jobs?limit=50", { token: A.token });
  check("Job Analysis still lists only org A's own jobs", (jobsList.json?.data?.jobs ?? []).length === 13, summarize((jobsList.json?.data?.jobs ?? []).length));
  check("the dashboard exposes no candidate-level rows", !JSON.stringify(jobsList.json).includes(`p4-bulk0-${SUFFIX}@example.test`), "candidate email leaked");

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
    if (tracked.jobs.length) {
      await prisma.jobCandidateReference.deleteMany({ where: { jobId: { in: tracked.jobs } } });
      await prisma.jobAssessmentAttempt.deleteMany({ where: { jobId: { in: tracked.jobs } } });
      await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: { in: tracked.jobs } } });
      await prisma.jobAssessment.deleteMany({ where: { jobId: { in: tracked.jobs } } });
      await prisma.job.deleteMany({ where: { id: { in: tracked.jobs } } });
    }
    if (tracked.subs.length) await prisma.subscription.deleteMany({ where: { id: { in: tracked.subs } } });
    if (tracked.orgs.length) await prisma.organization.deleteMany({ where: { id: { in: tracked.orgs } } });
    if (tracked.users.length) await prisma.user.deleteMany({ where: { id: { in: tracked.users } } });
    if (tracked.plans.length) await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.plans } } });
  } catch (error) {
    console.error("cleanup failed:", error.message);
  }
};

main()
  .catch((error) => { console.error("\nHARNESS ERROR:", error); process.exitCode = 1; })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await cleanup();
    await prisma.$disconnect();
  });