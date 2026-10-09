/* eslint-disable no-console */
// PHASE 2 — Recruiter Analysis.
//
// Proves, against the REAL PostgreSQL and the REAL Express HTTP surface:
//   A. Metrics      — per-recruiter jobs/candidates/analyses/assessment activity
//                     are correct and come from persisted rows.
//   B. Search       — recruiter NAME and EMAIL search are applied SERVER-SIDE
//                     (SQL), organization-scoped, and never leak another org.
//   C. Date filters — ALL / THIS MONTH / LAST_30_DAYS / LAST_3_MONTHS /
//                     LAST_6_MONTHS / CUSTOM all resolve server-side and
//                     actually narrow the persisted window.
//   D. Pagination   — paged, and page 2 returns different rows.
//   E. Deleted      — Phase 1's detached jobs (createdByUserId = NULL) are
//                     reported as unattributed, counted in org totals, and NEVER
//                     reassigned to a surviving recruiter.
//   F. Hiring       — unavailable / null everywhere; never inferred.
//   G. Security     — 401 unauth, 403 non-admin, cross-org isolation, client
//                     organizationId ignored.
//   H. Performance  — query count is constant as recruiters are added (no N+1).
require("dotenv").config();

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prisma = require("../src/config/prisma");
const generateAccessToken = require("../src/utils/generateAccessToken");

const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "frontend");
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const results = [];
const tracked = { userIds: [], planIds: [], subscriptionIds: [], organizationIds: [], jobIds: [], analysisIds: [], aiJobIds: [] };
let httpServer = null;

const section = (t) => console.log(`\n${t}`);
const summarize = (v) => JSON.stringify(v ?? null);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${!ok && detail ? `\n        -> ${detail}` : ""}`);
};

const startHttpServer = () =>
  new Promise((resolve, reject) => {
    const app = require("../src/app");
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });

const request = async (origin, pathname, { method = "GET", token, body } = {}) => {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json };
};

const tokenFor = (user) => generateAccessToken({ userId: user.id, role: user.role });

// Counts the SQL statements Prisma executes, to prove there is no N+1.
//
// Uses the SUPPORTED `query` extension hook. Two earlier attempts were wrong and
// would have hidden a real regression:
//   * patching `prisma._query` / `prisma._client` — private and absent in
//     Prisma 6, so it counted nothing and reported -1;
//   * `prisma.$use` — removed in Prisma 6, so it threw and aborted the run.
//
// The measured service module is loaded against an EXTENDED client (same
// DATABASE_URL), so every statement it issues is counted without touching the
// application's own PrismaClient.
const loadServiceWithCounter = () => {
  const { PrismaClient } = require("@prisma/client");
  let counting = false;
  let count = 0;

  const client = new PrismaClient().$extends({
    query: {
      $allOperations({ query, args }) {
        if (counting) count += 1;
        return query(args);
      },
    },
  });

  // The service/repository read `require("../src/config/prisma")`. Swapping that
  // module's export for the extended client makes the whole chain measurable.
  const prismaModulePath = require.resolve("../src/config/prisma");
  require.cache[prismaModulePath].exports = client;

  // Force the service + repository to bind to the extended client.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}module${path.sep}organization${path.sep}`)) {
      delete require.cache[key];
    }
  }
  const organizationService = require("../src/module/organization/organization.service");

  return {
    organizationService,
    measure: async (fn) => {
      count = 0;
      counting = true;
      try {
        return { result: await fn(), queries: count };
      } finally {
        counting = false;
      }
    },
    dispose: async () => { await client.$disconnect(); },
  };
};
const createUser = async (label, roleName = "RECRUITER", withSubscription = true) => {
  const user = await prisma.user.create({
    data: {
      fullName: `P2 ${label}`, email: `p2-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL", emailVerified: true, status: "ACTIVE", mustChangePassword: false,
    },
  });
  const role = await prisma.role.upsert({ where: { name: roleName }, update: {}, create: { name: roleName, description: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  tracked.userIds.push(user.id);

  if (withSubscription) {
    const plan = await prisma.subscriptionPlan.create({
      data: { name: `P2 Plan ${label} ${SUFFIX}`, type: roleName === "ORG_ADMIN" ? "ORGANIZATION" : "RECRUITER", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50 },
    });
    const subscription = await prisma.subscription.create({
      data: { planId: plan.id, userId: user.id, status: "ACTIVE", startDate: new Date(), expiryDate: new Date(Date.now() + 30 * DAY_IN_MS) },
    });
    tracked.planIds.push(plan.id);
    tracked.subscriptionIds.push(subscription.id);
  }
  return { user: { id: user.id, role: roleName, email: user.email, fullName: user.fullName } };
};

const createOrganization = async (label, ownerLabel) => {
  const owner = await createUser(ownerLabel, "ORG_ADMIN");
  const organization = await prisma.organization.create({
    data: { name: `P2 ${label} ${SUFFIX}`, ownerId: owner.user.id, status: "ACTIVE" },
  });
  tracked.organizationIds.push(organization.id);
  await prisma.organizationMembership.create({
    data: { userId: owner.user.id, organizationId: organization.id, role: "ORG_ADMIN", status: "ACTIVE" },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: { name: `P2 OrgPlan ${label} ${SUFFIX}`, type: "ORGANIZATION", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50, maxUsers: 50 },
  });
  const subscription = await prisma.subscription.create({
    data: { planId: plan.id, organizationId: organization.id, status: "ACTIVE", startDate: new Date(), expiryDate: new Date(Date.now() + 30 * DAY_IN_MS) },
  });
  tracked.planIds.push(plan.id);
  tracked.subscriptionIds.push(subscription.id);
  return { ...owner, organization };
};

const addRecruiterToOrg = async (organizationId, label) => {
  const recruiter = await createUser(label, "RECRUITER");
  await prisma.organizationMembership.create({
    data: { userId: recruiter.user.id, organizationId, role: "RECRUITER", status: "ACTIVE" },
  });
  return recruiter;
};

// One job with `createdAt` backdated by `daysAgo`, plus optional candidates and a
// SUBMITTED assessment attempt (the source of the assessment-activity metrics).
const createJob = async ({ ownerUserId, organizationId, title, status = "ACTIVE", daysAgo = 0, candidates = 0, attempt = null }) => {
  const createdAt = new Date(Date.now() - daysAgo * DAY_IN_MS);
  const job = await prisma.job.create({
    data: {
      title, description: `desc ${title}`, recruiterId: null,
      organizationId, createdByUserId: ownerUserId, status, createdAt,
      startedAt: createdAt,
      closedAt: status === "CLOSED" ? new Date(createdAt.getTime() + DAY_IN_MS) : null,
      closedReason: status === "CLOSED" ? "RECRUITER_CLOSED" : null,
    },
  });
  tracked.jobIds.push(job.id);

  for (let i = 0; i < candidates; i += 1) {
    await prisma.jobCandidateReference.create({
      data: {
        jobId: job.id,
        candidateEmail: `p2-cand-${i}-${title}-${SUFFIX}@example.test`.slice(0, 100),
        candidateName: `Candidate ${i}`,
        createdByUserId: ownerUserId,
        createdAt,
      },
    });
  }

  if (attempt) {
    const assessment = await prisma.jobAssessment.create({
      data: {
        jobId: job.id, title: `Assessment ${job.id}`, status: "FINALIZED",
        durationSeconds: 600, publicId: `p2-${job.id}-${SUFFIX}`.slice(0, 40),
        finalizedAt: createdAt, activatedAt: createdAt,
      },
    });
    const invitation = await prisma.jobAssessmentInvitation.create({
      data: {
        jobId: job.id, assessmentId: assessment.id, email: `p2-att-${job.id}-${SUFFIX}@example.test`.slice(0, 120),
        status: "EMAIL_VERIFIED", verificationTokenHash: `p2-i-${job.id}-${SUFFIX}`.slice(0, 64),
        invitedAt: createdAt, expiresAt: new Date(createdAt.getTime() + 7 * DAY_IN_MS),
        invitationEmailSentAt: createdAt, emailVerifiedAt: createdAt,
      },
    });
    await prisma.jobAssessmentAttempt.create({
      data: {
        assessmentId: assessment.id, invitationId: invitation.id, jobId: job.id,
        email: `p2-att-${job.id}-${SUFFIX}@example.test`.slice(0, 120),
        status: attempt.status, startedAt: createdAt,
        deadlineAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
        submittedAt: createdAt, score: 7, maxScore: 10, scorePercentage: 70,
      },
    });
  }

  return job;
};
const main = async () => {
  const { origin, server } = await startHttpServer();
  httpServer = server;

  const orgA = await createOrganization("org-a", "org-a-admin");
  const orgB = await createOrganization("org-b", "org-b-admin");
  const adminToken = tokenFor(orgA.user);

  // Recruiter 1: rich recent activity (3 jobs, 4 candidates, 2 attempts).
  const r1 = await addRecruiterToOrg(orgA.organization.id, "alpha-recruiter");
  await createJob({ ownerUserId: r1.user.id, organizationId: orgA.organization.id, title: "R1 job A", status: "ACTIVE", daysAgo: 2, candidates: 2, attempt: { status: "SUBMITTED" } });
  await createJob({ ownerUserId: r1.user.id, organizationId: orgA.organization.id, title: "R1 job B", status: "CLOSED", daysAgo: 5, candidates: 1 });
  await createJob({ ownerUserId: r1.user.id, organizationId: orgA.organization.id, title: "R1 job C", status: "ACTIVE", daysAgo: 1, candidates: 1, attempt: { status: "IN_PROGRESS" } });

  // Recruiter 2: only OLD activity. 100 days is older than 30 days but INSIDE a
  // calendar-anchored 6-month window (6 calendar months is ~181-184 days, so a
  // 200-day-old job would legitimately fall outside it — the fixture must not sit
  // on that boundary).
  const r2 = await addRecruiterToOrg(orgA.organization.id, "beta-recruiter");
  await createJob({ ownerUserId: r2.user.id, organizationId: orgA.organization.id, title: "R2 old job", status: "CLOSED", daysAgo: 100, candidates: 1 });

  // Org B recruiter — must never appear in org A's response.
  const rB = await addRecruiterToOrg(orgB.organization.id, "gamma-other-org");
  await createJob({ ownerUserId: rB.user.id, organizationId: orgB.organization.id, title: "RB job", candidates: 1 });

  const outsider = await createUser("outsider", "RECRUITER", false);
  const outsiderToken = tokenFor(outsider.user);

  const getAudit = (qs = "", token = adminToken) =>
    request(origin, `/api/organization/recruiters/audit${qs}`, { token });

  // =========================================================================
  section("A. Per-recruiter metrics come from persisted rows");
  // =========================================================================

  const all = await getAudit("");
  check("the audit endpoint returns 200", all.status === 200 && all.json?.success === true, summarize(all.json));
  const rows = all.json?.data?.recruiters ?? [];
  const row1 = rows.find((r) => r.userId === r1.user.id);
  const row2 = rows.find((r) => r.userId === r2.user.id);

  check("both org A recruiters are listed", Boolean(row1) && Boolean(row2), summarize(rows.map((r) => r.email)));
  check("recruiter name is returned", row1?.fullName?.includes("alpha-recruiter"), summarize(row1?.fullName));
  check("recruiter email is returned", row1?.email?.includes("alpha-recruiter"), summarize(row1?.email));
  check("recruiter status is returned", row1?.status === "ACTIVE", summarize(row1?.status));

  check("jobs posted is correct (3)", row1?.jobs?.posted === 3, summarize(row1?.jobs));
  check("active jobs is correct (2)", row1?.jobs?.active === 2, summarize(row1?.jobs));
  check("closed jobs is correct (1)", row1?.jobs?.closed === 1, summarize(row1?.jobs));
  check("total candidates is correct (4)", row1?.candidates === 4, summarize(row1?.candidates));

  check("assessment activity counts the persisted attempts (2)", row1?.assessments?.total === 2, summarize(row1?.assessments));
  check("submitted attempts are counted (1)", row1?.assessments?.submitted === 1, summarize(row1?.assessments));
  check("in-progress attempts are counted (1)", row1?.assessments?.inProgress === 1, summarize(row1?.assessments));
  check("completion rate is a real persisted ratio (1/2 = 50%)", row1?.assessments?.completionRate === 50, summarize(row1?.assessments));
  check("a recruiter with no attempts reports 0 attempts and a null rate", row2?.assessments?.total === 0 && row2?.assessments?.completionRate === null, summarize(row2?.assessments));

  check("organization seat usage is reported", all.json?.data?.seats?.active === 2, summarize(all.json?.data?.seats));
  check("no candidate-analysis JSON leaks into the summary",
    !JSON.stringify(all.json).includes("jobFitSummary"), "analysis payload leaked into the summary");
  // =========================================================================
  section("B. Server-side search (name + email), organization-scoped");
  // =========================================================================

  const byName = await getAudit(`?search=${encodeURIComponent("alpha-recruiter")}`);
  const byNameRows = byName.json?.data?.recruiters ?? [];
  check("searching by NAME returns exactly that recruiter", byNameRows.length === 1 && byNameRows[0].userId === r1.user.id, summarize(byNameRows.map((r) => r.fullName)));

  const byEmail = await getAudit(`?search=${encodeURIComponent("beta-recruiter")}`);
  check("searching by EMAIL returns exactly that recruiter",
    (byEmail.json?.data?.recruiters ?? []).length === 1 && byEmail.json.data.recruiters[0].userId === r2.user.id,
    summarize((byEmail.json?.data?.recruiters ?? []).map((r) => r.email)));

  const partial = await getAudit(`?search=${encodeURIComponent("recruiter")}`);
  check("a partial term matches BOTH org A recruiters", (partial.json?.data?.recruiters ?? []).length === 2, summarize((partial.json?.data?.recruiters ?? []).map((r) => r.fullName)));

  const noMatch = await getAudit(`?search=${encodeURIComponent("zzz-nobody-zzz")}`);
  check("a non-matching search returns an empty list, not everything", noMatch.status === 200 && (noMatch.json?.data?.recruiters ?? []).length === 0, summarize((noMatch.json?.data?.recruiters ?? []).length));

  const crossSearch = await getAudit(`?search=${encodeURIComponent("gamma-other-org")}`);
  check("search cannot reach a recruiter in ANOTHER organization", (crossSearch.json?.data?.recruiters ?? []).length === 0, summarize(crossSearch.json?.data?.recruiters));

  check("the active search term is echoed back", byName.json?.data?.search === "alpha-recruiter", summarize(byName.json?.data?.search));
  check("pagination total reflects the SEARCHED set, not all recruiters", byName.json?.data?.pagination?.total === 1, summarize(byName.json?.data?.pagination));

  // =========================================================================
  section("C. Date filters are resolved server-side");
  // =========================================================================

  check("ALL time reports label ALL and no window", all.json?.data?.range?.label === "ALL" && all.json.data.range.from === null, summarize(all.json?.data?.range));

  const thisMonth = await getAudit("?range=MONTH");
  check("THIS MONTH resolves to a real window", thisMonth.json?.data?.range?.label === "THIS_MONTH" && thisMonth.json.data.range.from !== null, summarize(thisMonth.json?.data?.range));

  const last30 = await getAudit("?range=LAST_30_DAYS");
  check("LAST 30 DAYS resolves to a window ~30 days back",
    last30.json?.data?.range?.label === "LAST_30_DAYS" && Math.abs(Date.now() - new Date(last30.json.data.range.from).getTime() - 30 * DAY_IN_MS) < 5000,
    summarize(last30.json?.data?.range));

  const last3 = await getAudit("?range=LAST_3_MONTHS");
  check("LAST 3 MONTHS resolves to a calendar-anchored window", last3.json?.data?.range?.label === "LAST_3_MONTHS" && last3.json.data.range.from !== null, summarize(last3.json?.data?.range));

  const last6 = await getAudit("?range=LAST_6_MONTHS");
  check("LAST 6 MONTHS starts earlier than LAST 3 MONTHS",
    last6.json?.data?.range?.label === "LAST_6_MONTHS" && new Date(last6.json.data.range.from) < new Date(last3.json.data.range.from),
    summarize({ from3: last3.json?.data?.range?.from, from6: last6.json?.data?.range?.from }));

  // The window must actually narrow persisted rows. NOTE the contract: `jobs` is
  // deliberately ALL-TIME and is never replaced by a window (that is the
  // pre-existing behaviour of this endpoint); the windowed figures live in
  // `inRange`. So the window is proven on `inRange.jobsPosted`.
  const r2All = (all.json?.data?.recruiters ?? []).find((r) => r.userId === r2.user.id);
  const r2_30 = (last30.json?.data?.recruiters ?? []).find((r) => r.userId === r2.user.id);
  const r2_6 = (last6.json?.data?.recruiters ?? []).find((r) => r.userId === r2.user.id);
  check("a recruiter with only 100-day-old jobs appears in ALL time", r2All?.jobs?.posted === 1, summarize(r2All?.jobs));
  check("LAST 30 DAYS reports 0 jobs in the window for that recruiter", r2_30?.inRange?.jobsPosted === 0, summarize(r2_30?.inRange));
  check("LAST 6 MONTHS includes the 100-day-old job in the window", r2_6?.inRange?.jobsPosted === 1, summarize(r2_6?.inRange));
  check("ALL time exposes no windowed figures at all", all.json?.data?.range?.from === null && (all.json?.data?.recruiters ?? []).every((r) => r.inRange === null), "inRange present without a date filter");

  const custom = await getAudit(`?from=${new Date(Date.now() - 10 * DAY_IN_MS).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`);
  check("a CUSTOM from/to range is accepted and labelled CUSTOM", custom.status === 200 && custom.json?.data?.range?.label === "CUSTOM", summarize(custom.json?.data?.range));

  const badRange = await getAudit("?range=LAST_99_YEARS");
  check("an unknown range is rejected server-side (422)", badRange.status === 422, summarize({ status: badRange.status }));
  const badOrder = await getAudit(`?from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() - 10 * DAY_IN_MS).toISOString().slice(0, 10)}`);
  check("from > to is rejected server-side (422)", badOrder.status === 422, summarize({ status: badOrder.status }));
  const badDate = await getAudit("?from=not-a-date");
  check("an unparseable date is rejected server-side", badDate.status === 422, summarize({ status: badDate.status }));
  // =========================================================================
  section("D. Pagination reflects the searched set");
  // =========================================================================

  const pageSize = 1;
  const p1 = await getAudit(`?limit=${pageSize}&page=1`);
  const p2 = await getAudit(`?limit=${pageSize}&page=2`);
  check("page 1 honours the requested limit", (p1.json?.data?.recruiters ?? []).length === pageSize, summarize((p1.json?.data?.recruiters ?? []).length));
  check("page 2 returns a DIFFERENT recruiter", p1.json.data.recruiters[0].userId !== p2.json.data.recruiters[0].userId, summarize({ p1: p1.json?.data?.recruiters?.map((r) => r.fullName), p2: p2.json?.data?.recruiters?.map((r) => r.fullName) }));
  check("pagination metadata is coherent", p1.json?.data?.pagination?.total === 2 && p1.json.data.pagination.totalPages === 2, summarize(p1.json?.data?.pagination));
  const hugeLimit = await getAudit("?limit=100000");
  check("an oversized limit is clamped, not honoured", hugeLimit.json?.data?.pagination?.limit <= 100, summarize(hugeLimit.json?.data?.pagination));

  // =========================================================================
  section("E. Phase 1 deleted recruiters — honest unattributed handling");
  // =========================================================================

  // Delete recruiter r1 exactly as Phase 1 does: real row delete, jobs detached.
  const doomed = await addRecruiterToOrg(orgA.organization.id, "doomed-recruiter");
  await createJob({ ownerUserId: doomed.user.id, organizationId: orgA.organization.id, title: "Doomed job 1", status: "CLOSED", daysAgo: 10, candidates: 3 });
  await createJob({ ownerUserId: doomed.user.id, organizationId: orgA.organization.id, title: "Doomed job 2", status: "ACTIVE", daysAgo: 12, candidates: 1 });

  const deleteResponse = await request(origin, `/api/organization/recruiters/${doomed.user.id}`, { method: "DELETE", token: adminToken });
  check("the recruiter is permanently deleted via the Phase 1 endpoint", deleteResponse.status === 200, summarize({ status: deleteResponse.status }));

  const afterDelete = await getAudit("");
  const unattributed = afterDelete.json?.data?.unattributedHistoricalJobs;
  check("the deleted recruiter no longer appears as an active recruiter",
    !(afterDelete.json?.data?.recruiters ?? []).some((r) => r.userId === doomed.user.id), "deleted recruiter still listed");
  check("the deleted recruiter does not appear in ANY status bucket", !(afterDelete.json?.data?.recruiters ?? []).some((r) => r.fullName?.includes("doomed")), "deleted recruiter still listed");

  check("detached jobs are reported as unattributed, not dropped", unattributed?.total === 2, summarize(unattributed));
  check("the unattributed bucket is labelled honestly", unattributed?.label === "Unattributed Historical Jobs" && unattributed?.labelShort === "Deleted Recruiter", summarize({ label: unattributed?.label, labelShort: unattributed?.labelShort }));
  check("the unattributed bucket has NO userId (it is not a recruiter)", unattributed?.userId === null, summarize(unattributed?.userId));
  check("detached jobs keep their candidates in org totals", unattributed?.candidates === 4, summarize(unattributed?.candidates));
  check("detached jobs keep their status split", unattributed?.byStatus?.CLOSED === 1 && unattributed?.byStatus?.ACTIVE === 1, summarize(unattributed?.byStatus));

  // CRITICAL: the detached jobs must NOT be folded into a surviving recruiter.
  const survivor = (afterDelete.json?.data?.recruiters ?? []).find((r) => r.userId === r2.user.id);
  check("detached jobs are NOT reassigned to a surviving recruiter", survivor?.jobs?.posted === 1, summarize(survivor?.jobs));
  const survivor2 = (afterDelete.json?.data?.recruiters ?? []).find((r) => r.userId === r1.user.id);
  check("they are not reassigned to the other active recruiter either", survivor2?.jobs?.posted === 3, summarize(survivor2?.jobs));

  const dbDetached = await prisma.job.count({ where: { organizationId: orgA.organization.id, createdByUserId: null } });
  check("the detached jobs still exist in the database", dbDetached === 2, summarize(dbDetached));
  const goneUser = await prisma.user.count({ where: { id: doomed.user.id } });
  check("the deleted recruiter User row is gone", goneUser === 0, summarize(goneUser));

  // =========================================================================
  section("F. Hiring is never invented");
  // =========================================================================

  const hiringRow = (afterDelete.json?.data?.recruiters ?? []).find((r) => r.userId === r1.user.id);
  check("hiring is reported as unavailable", hiringRow?.hiring?.available === false, summarize(hiringRow?.hiring));
  check("hired is null, not 0", hiringRow?.hiring?.hired === null, summarize(hiringRow?.hiring?.hired));
  check("notHired is null, not 0", hiringRow?.hiring?.notHired === null, summarize(hiringRow?.hiring?.notHired));
  check("hiringRate is null", hiringRow?.hiring?.hiringRate === null, summarize(hiringRow?.hiring?.hiringRate));
  check("selected is null (never derived from a score)", hiringRow?.selected === null, summarize(hiringRow?.selected));
  check("no hired figure is inferred anywhere in the payload",
    !/"hired"\s*:\s*[1-9]/.test(JSON.stringify(afterDelete.json)), "a non-null hired value was returned");
  // =========================================================================
  section("G. Security and organization isolation");
  // =========================================================================

  const unauth = await request(origin, "/api/organization/recruiters/audit");
  check("unauthenticated access returns 401", unauth.status === 401, summarize({ status: unauth.status }));

  const nonAdmin = await getAudit("", outsiderToken);
  check("a non-ORG_ADMIN is rejected with 403", nonAdmin.status === 403, summarize({ status: nonAdmin.status }));

  const orgBResponse = await request(origin, "/api/organization/recruiters/audit", { token: tokenFor(orgB.user) });
  const orgBRows = orgBResponse.json?.data?.recruiters ?? [];
  check("org B sees ONLY its own recruiter", orgBRows.length === 1 && orgBRows[0].userId === rB.user.id, summarize(orgBRows.map((r) => r.fullName)));
  check("org B cannot see any org A recruiter", !orgBRows.some((r) => r.userId === r1.user.id || r.userId === r2.user.id), "cross-org recruiter leaked");

  // A client-supplied organizationId must never override the server-resolved org.
  const spoof = await getAudit(`?organizationId=${orgB.organization.id}`);
  const spoofRows = spoof.json?.data?.recruiters ?? [];
  check("a client-supplied organizationId cannot redirect the query", spoof.json?.data?.organizationId === orgA.organization.id, summarize(spoof.json?.data?.organizationId));
  check("the spoofed query still returns org A recruiters only", !spoofRows.some((r) => r.userId === rB.user.id), "org B data returned for org A admin");

  const crossRecruiterJobs = await request(origin, `/api/organization/recruiters/${rB.user.id}/jobs`, { token: adminToken });
  check("org A cannot read org B's recruiter jobs (404)", crossRecruiterJobs.status === 404, summarize({ status: crossRecruiterJobs.status }));

  // =========================================================================
  section("H. No N+1 — query count is constant as recruiters grow");
  // =========================================================================

  const organizationService = require("../src/module/organization/organization.service");
  const counter = loadServiceWithCounter();
  const adminPrincipal = { id: orgA.user.id, role: "ORG_ADMIN" };

  const before = await counter.measure(() => counter.organizationService.listAuditRecruiters(adminPrincipal, {}));
  const countBefore = before.result?.recruiters?.length ?? 0;
  check("the baseline request issued queries", before.queries > 0, summarize({ queries: before.queries, recruiters: countBefore }));

  // Add 6 more recruiters, then repeat the identical call.
  for (let i = 0; i < 6; i += 1) {
    await addRecruiterToOrg(orgA.organization.id, `bulk-${i}`);
  }
  const after = await counter.measure(() => counter.organizationService.listAuditRecruiters(adminPrincipal, {}));
  const countAfter = after.result?.recruiters?.length ?? 0;

  check("adding 6 recruiters did increase the returned rows", countAfter > countBefore, summarize({ before: countBefore, after: countAfter }));
  // Both calls use no date filter, so the statement counts must be identical.
  check("the query count did NOT grow with the recruiter count (no N+1)",
    after.queries === before.queries,
    summarize({ queriesBefore: before.queries, queriesAfter: after.queries, recruitersBefore: countBefore, recruitersAfter: countAfter }));
  console.log(`        [measured] queries=${after.queries} for ${countAfter} recruiters`);
  await counter.dispose();
  // =========================================================================
  section("I. Frontend contract");
  // =========================================================================

  const page = fs.readFileSync(path.join(FRONTEND_ROOT, "src", "pages", "dashboard", "OrganizationRecruiterAnalysis.jsx"), "utf8");
  const nav = fs.readFileSync(path.join(FRONTEND_ROOT, "src", "components", "organization", "orgAdminNav.js"), "utf8");
  const serviceSrc = fs.readFileSync(path.join(FRONTEND_ROOT, "src", "services", "organizationService.js"), "utf8");

  check("the page sends the search term to the SERVER", /params\.search = search/.test(page), "search is not sent to the API");
  check("the page does NOT filter recruiters in React", !/recruiters\.filter\(/.test(page), "client-side filtering found");
  check("the page sends page + limit for server pagination", /params = \{ page, limit: PAGE_LIMIT \}/.test(page), "no server pagination params");
  check("all six date options are offered",
    ["ALL", "MONTH", "LAST_30_DAYS", "LAST_3_MONTHS", "LAST_6_MONTHS", "CUSTOM"].every((v) => nav.includes(`value: "${v}"`)), "a range option is missing");
  check("custom range sends from/to to the server", /params\.from = from/.test(page) && /params\.to = to/.test(page), "custom range not sent");
  check("the unattributed historical bucket is rendered", /unattributed\.label/.test(page), "unattributed bucket not rendered");
  check("hiring renders an explicit not-tracked state", /not tracked yet/.test(page), "hiring empty state missing");
  check("assessment activity is rendered", /recruiter\.assessments\.submitted/.test(page), "assessment activity not rendered");
  check("the page sends NO organizationId", !/organizationId/.test(page), "the page sends an organizationId");
  check("the service layer sends no organizationId",
    !/getAuditRecruiters[\s\S]{0,300}organizationId/.test(serviceSrc), "the service sends an organizationId");

  // =========================================================================
  section("J. Summary");
  // =========================================================================

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
    if (tracked.aiJobIds.length) await prisma.aiJob.deleteMany({ where: { id: { in: tracked.aiJobIds } } });
    if (tracked.analysisIds.length) await prisma.jobCandidateAnalysis.deleteMany({ where: { id: { in: tracked.analysisIds } } });
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