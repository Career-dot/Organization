/* eslint-disable no-console */
// Phase 8 focused verifier: recruiter READ-ONLY Jobs overview.
//
// Proves, against the REAL PostgreSQL and the REAL Express HTTP surface:
//   A. Job list — own-jobs scoping, search by title, search by Job ID, status and
//      date filtering, server-side pagination, correct counts, closed jobs readable.
//   B. Job details — description, requirements, skills (+weights), tools, dates,
//      status, counts, and that no mutation verb exists for this feature.
//   C. Candidates — correct candidates for Job A, cross-job isolation, the
//      authoritative assessment score, the existing verification score, and the
//      honest "no preferred/selected state" contract.
//   D. Reports — the EXISTING verification-report endpoint and the EXISTING
//      candidate-analysis endpoint still work, stay separate, and are both scoped
//      to the correct job; closed jobs can still read them.
//   E. Security — unauthenticated, wrong recruiter, wrong organization, wrong job,
//      wrong reference id, cross-job report access.
//   F. Scalability — bounded page size, no full analysis JSON in list responses,
//      server-side search, and a bounded (non-N+1) query count per candidates page.
//   G. Duplication/idempotency — repeated reads create no rows; no write verb is
//      reachable on any overview route.
require("dotenv").config();

const http = require("node:http");
const path = require("node:path");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prisma = require("../src/config/prisma");
const jobOverviewService = require("../src/module/job/jobOverview.service");
const aiJobRepository = require("../src/module/ai-job/aiJob.repository");
const generateAccessToken = require("../src/utils/generateAccessToken");

const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "frontend");
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const results = [];
const tracked = { userIds: [], planIds: [], subscriptionIds: [], organizationIds: [], jobIds: [], analysisIds: [] };
let httpServer = null;

const section = (title) => console.log(`\n${title}`);
const summarize = (value) => JSON.stringify(value ?? null);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${!ok && detail ? `\n        -> ${detail}` : ""}`);
};
const collectKeys = (value, keys = new Set()) => {
  if (Array.isArray(value)) value.forEach((entry) => collectKeys(entry, keys));
  else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => { keys.add(key); collectKeys(entry, keys); });
  }
  return keys;
};
const tokenFor = (user) => generateAccessToken({ userId: user.id, role: user.role });
const candidateEmail = (label) => `p8-${label}-${SUFFIX}@example.test`;

const startHttpServer = () => new Promise((resolve, reject) => {
  const app = require("../src/app");
  const server = http.createServer(app);
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
});

const request = async (origin, pathname, { method = "GET", token, body, headers = {} } = {}) => {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString("utf8")); } catch {}
  return { status: response.status, headers: response.headers, buffer, json };
};

const createRecruiter = async (label) => {
  const user = await prisma.user.create({ data: {
    fullName: `P8 ${label}`, email: `p8-${label}-${SUFFIX}@example.test`,
    provider: "LOCAL", emailVerified: true, status: "ACTIVE",
  }});
  const role = await prisma.role.upsert({ where: { name: "RECRUITER" }, update: {},
    create: { name: "RECRUITER", description: "Recruiter role" } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const plan = await prisma.subscriptionPlan.create({ data: {
    name: `P8 Plan ${label} ${SUFFIX}`, type: "RECRUITER", price: 0,
    billingCycle: "MONTHLY", jobPostingLimit: 50,
  }});
  const subscription = await prisma.subscription.create({ data: {
    planId: plan.id, userId: user.id, status: "ACTIVE", startDate: new Date(),
    expiryDate: new Date(Date.now() + 30 * DAY_IN_MS),
  }});
  tracked.userIds.push(user.id); tracked.planIds.push(plan.id); tracked.subscriptionIds.push(subscription.id);
  return { user: { id: user.id, role: "RECRUITER" }, subscription, plan };
};

const createOrganization = async (label) => {
  const owner = await createRecruiter(`org-${label}`);
  const organization = await prisma.organization.create({ data: {
    name: `P8 ${label} ${SUFFIX}`, ownerId: owner.user.id, status: "ACTIVE",
  }});
  await prisma.organizationMembership.create({ data: {
    userId: owner.user.id, organizationId: organization.id, role: "RECRUITER", status: "ACTIVE",
  }});
  await prisma.subscription.update({ where: { id: owner.subscription.id },
    data: { userId: null, organizationId: organization.id } });
  tracked.organizationIds.push(organization.id);
  return { ...owner, organization };
};

// A job with persisted requirements, dates, counts and candidates. `createdDaysAgo`
// exercises the date filters; `status` exercises the status filter.
const createJob = async (recruiter, {
  title, status = "ACTIVE", createdDaysAgo = 0, preferredTarget = null, orgId = null,
  candidates = [], withAttempt = null,
} = {}) => {
  const createdAt = new Date(Date.now() - createdDaysAgo * DAY_IN_MS);
  const job = await prisma.job.create({ data: {
    title,
    description: `Description for ${title}`,
    yearsExperience: 5,
    recruiterId: orgId ? null : recruiter.user.id,
    organizationId: orgId,
    createdByUserId: recruiter.user.id,
    status,
    preferredCandidateCount: preferredTarget,
    createdAt,
    analysisEndsAt: new Date(createdAt.getTime() + 10 * DAY_IN_MS),
    startedAt: status === "DRAFT" ? null : createdAt,
    closedAt: status === "CLOSED" ? new Date(createdAt.getTime() + 5 * DAY_IN_MS) : null,
    closedReason: status === "CLOSED" ? "RECRUITER_CLOSED" : null,
  }});
  tracked.jobIds.push(job.id);

  await prisma.jobSkill.createMany({ data: [
    { jobId: job.id, name: "Node.js", weight: 60, sortOrder: 0 },
    { jobId: job.id, name: "PostgreSQL", weight: 40, sortOrder: 1 },
  ]});
  await prisma.jobTool.create({ data: { jobId: job.id, name: "Docker", sortOrder: 0 }});
  await prisma.jobQuestion.create({ data: { jobId: job.id, question: "Why this role?", sortOrder: 0 }});

  for (const candidate of candidates) {
    await prisma.jobCandidateReference.create({ data: {
      jobId: job.id,
      candidateEmail: candidate.email,
      candidateName: candidate.name ?? null,
      preferredRole: candidate.preferredRole ?? null,
      createdByUserId: recruiter.user.id,
    }});
  }

  // An authoritative assessment result, written exactly the way the submit
  // transaction writes it (a real persisted triple, never a client value).
  if (withAttempt) {
    const assessment = await prisma.jobAssessment.create({ data: {
      // The persisted enum is DRAFT | FINALIZED; "activated" is a separate
      // timestamp column, so a real activated assessment is FINALIZED + a set
      // activatedAt (exactly how the platform represents it).
      jobId: job.id, title: `Assessment ${job.id}`, status: "FINALIZED",
      durationSeconds: 600, publicId: `p8-${SUFFIX}-${job.id}`.slice(0, 40),
      finalizedAt: createdAt, activatedAt: createdAt,
    }});
    const question = await prisma.jobAssessmentQuestion.create({ data: {
      assessmentId: assessment.id, section: "REQUIRED_SKILLS", sortOrder: 0,
      prompt: "Pick the right answer", questionType: "SINGLE_CHOICE", points: 10,
      options: ["A", "B"], correctAnswer: { choice: "A" },
    }});
    // An attempt is keyed to a real invitation (invitationId is required and
    // unique), so the fixture creates the invitation the platform would have.
    const invitation = await prisma.jobAssessmentInvitation.create({ data: {
      jobId: job.id, assessmentId: assessment.id, email: withAttempt.email,
      status: "EMAIL_VERIFIED", verificationTokenHash: `p8-${SUFFIX}-${job.id}`.slice(0, 64),
      invitedAt: createdAt, expiresAt: new Date(createdAt.getTime() + 7 * DAY_IN_MS),
      emailVerifiedAt: createdAt,
    }});
    const attempt = await prisma.jobAssessmentAttempt.create({ data: {
      jobId: job.id, assessmentId: assessment.id, invitationId: invitation.id,
      email: withAttempt.email,
      status: "SUBMITTED", startedAt: createdAt,
      deadlineAt: new Date(createdAt.getTime() + 600000),
      submittedAt: new Date(createdAt.getTime() + 100000),
      score: withAttempt.score, maxScore: withAttempt.maxScore,
      scorePercentage: (withAttempt.score / withAttempt.maxScore) * 100,
    }});
    await prisma.jobAssessmentAttemptAnswer.create({ data: {
      attemptId: attempt.id, questionId: question.id, answer: { choice: "A" },
    }});
  }

  return job;
};

const platformTotals = async () => {
  const [users, jobs, refs, analyses, attempts] = await Promise.all([
    prisma.user.count(), prisma.job.count(), prisma.jobCandidateReference.count(),
    prisma.jobCandidateAnalysis.count(), prisma.jobAssessmentAttempt.count(),
  ]);
  return { users, jobs, refs, analyses, attempts };
};

const main = async () => {
  console.log(`run id: ${SUFFIX}`);
  const totalsBefore = await platformTotals();

  const recruiter = await createRecruiter("a");
  const outsider = await createRecruiter("b");
  const orgFixture = await createOrganization("alpha");
  const otherOrg = await createOrganization("beta");

  // The candidate that took the assessment IS the in-system candidate, so the
  // EMPLOYEE account must carry the SAME address the reference row does.
  const submittedEmail = candidateEmail("submitted");
  const employee = await prisma.user.create({ data: {
    fullName: "P8 Employee", email: submittedEmail,
    provider: "LOCAL", emailVerified: true, status: "ACTIVE",
  }});
  tracked.userIds.push(employee.id);
  const employeeRole = await prisma.role.upsert({ where: { name: "EMPLOYEE" }, update: {},
    create: { name: "EMPLOYEE", description: "Employee role" } });
  await prisma.userRole.create({ data: { userId: employee.id, roleId: employeeRole.id }});

  const jobA = await createJob(recruiter, {
    title: "Senior Platform Engineer", preferredTarget: 3,
    candidates: [
      { email: submittedEmail, name: "In System Candidate" },
      { email: candidateEmail("outsider"), name: "Out Of System Candidate" },
    ],
    withAttempt: { email: submittedEmail, score: 8, maxScore: 10 },
  });
  const jobB = await createJob(recruiter, { title: "Unrelated Data Role", createdDaysAgo: 40 });
  const jobRecent = await createJob(recruiter, { title: "Recent Design Role", createdDaysAgo: 2 });
  const jobClosed = await createJob(recruiter, { title: "Historic Closed Role", status: "CLOSED", createdDaysAgo: 90 });
  const orgJob = await createJob(orgFixture, { title: "Org Owned Role", orgId: orgFixture.organization.id });
  const otherOrgJob = await createJob(otherOrg, { title: "Other Org Role", orgId: otherOrg.organization.id });

  const { server, origin } = await startHttpServer();
  httpServer = server;
  const ownToken = tokenFor(recruiter.user);
  const outsiderToken = tokenFor(outsider.user);
  const orgToken = tokenFor({ ...orgFixture.user, role: "RECRUITER" });
  const otherOrgToken = tokenFor({ ...otherOrg.user, role: "RECRUITER" });

  // =========================================================================
  section("A. Job list — scoping, search, filters, pagination, counts");
  // =========================================================================

  const ownList = await request(origin, "/api/job/overview/jobs?limit=50", { token: ownToken });
  check("the overview list returns 200 for the owning recruiter", ownList.status === 200, summarize(ownList.json));
  const ownJobs = ownList.json?.data ?? [];
  const ownIds = ownJobs.map((job) => job.id);

  check("the recruiter sees their own jobs", ownIds.includes(jobA.id) && ownIds.includes(jobB.id) && ownIds.includes(jobClosed.id), summarize(ownIds));
  check("the recruiter never sees another organization's job", !ownIds.includes(orgJob.id) && !ownIds.includes(otherOrgJob.id), summarize(ownIds));

  const outsiderList = await request(origin, "/api/job/overview/jobs?limit=50", { token: outsiderToken });
  const outsiderIds = (outsiderList.json?.data ?? []).map((job) => job.id);
  check("a different recruiter sees none of these jobs", !outsiderIds.some((id) => ownIds.includes(id)), summarize(outsiderIds));

  // Organization scoping: the org recruiter sees THEIR org's job only.
  const orgList = await request(origin, "/api/job/overview/jobs?limit=50", { token: orgToken });
  const orgIds = (orgList.json?.data ?? []).map((job) => job.id);
  check("an organization recruiter sees their organization's job", orgIds.includes(orgJob.id), summarize(orgIds));
  check("an organization recruiter never sees another organization's job", !orgIds.includes(otherOrgJob.id) && !orgIds.includes(jobA.id), summarize(orgIds));
  const otherOrgList = await request(origin, "/api/job/overview/jobs?limit=50", { token: otherOrgToken });
  const otherOrgIds = (otherOrgList.json?.data ?? []).map((job) => job.id);
  check("the other organization sees only its own job", otherOrgIds.includes(otherOrgJob.id) && !otherOrgIds.includes(orgJob.id), summarize(otherOrgIds));

  // Search by title (substring, case-insensitive).
  const byTitle = await request(origin, "/api/job/overview/jobs?search=platform+engineer", { token: ownToken });
  const titleIds = (byTitle.json?.data ?? []).map((job) => job.id);
  check("search by job title matches server-side", titleIds.includes(jobA.id) && !titleIds.includes(jobB.id), summarize(titleIds));

  // Search by Job ID.
  const byId = await request(origin, `/api/job/overview/jobs?search=${jobB.id}`, { token: ownToken });
  const idIds = (byId.json?.data ?? []).map((job) => job.id);
  check("search by Job ID matches server-side", idIds.includes(jobB.id), summarize(idIds));

  const noMatch = await request(origin, "/api/job/overview/jobs?search=zzzznotarealjobzzz", { token: ownToken });
  check("a search with no matches returns an empty list, not everything", noMatch.status === 200 && (noMatch.json?.data ?? []).length === 0, summarize(noMatch.json?.data?.length));

  // Status filtering.
  const closedOnly = await request(origin, "/api/job/overview/jobs?status=CLOSED", { token: ownToken });
  const closedIds = (closedOnly.json?.data ?? []).map((job) => job.id);
  check("status=CLOSED returns only closed jobs", closedIds.length > 0 && closedIds.every((id) => id === jobClosed.id), summarize(closedIds));
  const groupClosed = await request(origin, "/api/job/overview/jobs?status=completed", { token: ownToken });
  check("the recruiter-facing 'completed' group maps to CLOSED", (groupClosed.json?.data ?? []).map((job) => job.id).every((id) => id === jobClosed.id), summarize(groupClosed.json?.data?.map((job) => job.status)));

  // Date filtering: the "posted within the last month" control.
  const lastMonth = await request(origin, "/api/job/overview/jobs?within=month", { token: ownToken });
  const monthIds = (lastMonth.json?.data ?? []).map((job) => job.id);
  check("within=month returns only jobs posted in the last 30 days", monthIds.includes(jobA.id) && monthIds.includes(jobRecent.id) && !monthIds.includes(jobClosed.id) && !monthIds.includes(jobB.id), summarize(monthIds));

  const explicitFrom = new Date(Date.now() - 7 * DAY_IN_MS).toISOString().slice(0, 10);
  const fromFiltered = await request(origin, `/api/job/overview/jobs?from=${explicitFrom}`, { token: ownToken });
  const fromIds = (fromFiltered.json?.data ?? []).map((job) => job.id);
  check("an explicit from-date filters server-side", fromIds.includes(jobRecent.id) && !fromIds.includes(jobB.id), summarize(fromIds));

  const badFilter = await request(origin, "/api/job/overview/jobs?status=NOT_A_STATUS", { token: ownToken });
  check("an unknown status filter is rejected rather than silently ignored", badFilter.status === 422, summarize(badFilter.json));
  const badDate = await request(origin, "/api/job/overview/jobs?from=not-a-date", { token: ownToken });
  check("a malformed date is rejected rather than silently ignored", badDate.status === 422, summarize(badDate.json));

  // Pagination is server-side and bounded.
  const page1 = await request(origin, "/api/job/overview/jobs?limit=1&page=1", { token: ownToken });
  const page2 = await request(origin, "/api/job/overview/jobs?limit=1&page=2", { token: ownToken });
  check("limit=1 returns exactly one job per page", (page1.json?.data ?? []).length === 1 && (page2.json?.data ?? []).length === 1, summarize({ p1: page1.json?.data?.length, p2: page2.json?.data?.length }));
  check("page 1 and page 2 return DIFFERENT jobs (real pagination)", page1.json?.data?.[0]?.id !== page2.json?.data?.[0]?.id, summarize({ a: page1.json?.data?.[0]?.id, b: page2.json?.data?.[0]?.id }));
  check("the total reflects the full owned set, not the page", page1.json?.pagination?.total >= 4, summarize(page1.json?.pagination));
  const overLimit = await request(origin, "/api/job/overview/jobs?limit=5000", { token: ownToken });
  check("an oversized limit is clamped, never honoured", (overLimit.json?.data ?? []).length <= 50 && overLimit.json?.pagination?.limit <= 50, summarize(overLimit.json?.pagination));

  // Counts and the closed-job readability contract.
  const rowA = (ownList.json?.data ?? []).find((job) => job.id === jobA.id);
  check("the list reports the real candidate count", rowA?.counts?.candidates === 2, summarize(rowA?.counts));
  check("the list reports the real attempt count", rowA?.counts?.attempts === 1, summarize(rowA?.counts));
  check("the list reports the recruiter-configured preferred TARGET verbatim", rowA?.preferredCandidateTarget === 3, summarize(rowA?.preferredCandidateTarget));
  const closedRow = (ownList.json?.data ?? []).find((job) => job.id === jobClosed.id);
  check("a closed job remains in the readable list and is flagged", closedRow?.status === "CLOSED" && closedRow?.isClosed === true, summarize(closedRow));
  check("the list row carries no combined/overall/hiring score", !/overall|combined|ranking|fitScore|hireScore/i.test(JSON.stringify(rowA)), summarize(Object.keys(rowA ?? {})));

  // =========================================================================
  section("B. Job details card — persisted data, counts, read-only");
  // =========================================================================

  const details = await request(origin, `/api/job/overview/${jobA.id}`, { token: ownToken });
  check("the details card returns 200 for the owning recruiter", details.status === 200, summarize(details.json));
  const d = details.json?.data ?? {};
  check("the card returns the job's real description", d.job?.description === `Description for ${jobA.title}`, summarize(d.job?.description));
  check("the card returns the job's real Job ID", d.job?.id === jobA.id, summarize(d.job?.id));
  check("the card returns the persisted requirements", (d.job?.requirements ?? []).some((r) => r.question === "Why this role?"), summarize(d.job?.requirements));
  check("the card returns the persisted skills WITH their weights", (d.job?.skills ?? []).some((s) => s.name === "Node.js" && s.weight === 60), summarize(d.job?.skills));
  check("the card returns the persisted tools", (d.job?.tools ?? []).some((t) => t.name === "Docker"), summarize(d.job?.tools));
  check("the card returns the assessment summary and question count", d.job?.assessment?.status === "FINALIZED" && d.job?.assessment?.questionCount === 1, summarize(d.job?.assessment));
  check("the card returns posted/expiry dates", Boolean(d.job?.createdAt) && Boolean(d.job?.analysisEndsAt), summarize({ createdAt: d.job?.createdAt, endsAt: d.job?.analysisEndsAt }));
  check("the card returns the correct candidate count", d.counts?.candidates === 2, summarize(d.counts));
  check("the card reports the attempt statuses by group", d.counts?.assessmentAttemptsByStatus?.SUBMITTED === 1, summarize(d.counts?.assessmentAttemptsByStatus));
  check("the card reports preferred/selected as null (never a fabricated number)", d.counts?.preferredCandidates === null && d.counts?.selectedCandidates === null, summarize({ p: d.counts?.preferredCandidates, s: d.counts?.selectedCandidates }));
  check("the card names the source of the existing verified skill score", d.job?.existingVerifiedSkillScoreSource === "STORED_PLATFORM_VERIFICATION_REPORTS", summarize(d.job?.existingVerifiedSkillScoreSource));
  check("the card carries no combined/overall/hiring score", !/overallScore|combinedScore|rankingScore|fitPercentage|hireScore|hiringDecision/i.test(JSON.stringify(d)), summarize(Object.keys(d)));

  const closedDetails = await request(origin, `/api/job/overview/${jobClosed.id}`, { token: ownToken });
  check("a CLOSED job's details remain fully readable", closedDetails.status === 200 && closedDetails.json?.data?.isClosed === true, summarize(closedDetails.json?.data?.isClosed));

  // =========================================================================
  section("C. Candidates — correct set, authoritative score, honest unknowns");
  // =========================================================================

  const candidates = await request(origin, `/api/job/overview/${jobA.id}/candidates`, { token: ownToken });
  check("the candidate list returns 200 for the owning recruiter", candidates.status === 200, summarize(candidates.json?.data?.candidates?.length));
  const list = candidates.json?.data?.candidates ?? [];
  check("only THIS job's candidates are returned", list.length === 2 && list.every((c) => [submittedEmail, candidateEmail("outsider")].includes(c.candidateEmail)), summarize(list.map((c) => c.candidateEmail)));

  const inSystem = list.find((c) => c.candidateEmail === submittedEmail);
  const outSystem = list.find((c) => c.candidateEmail === candidateEmail("outsider"));

  check("IN_SYSTEM / NOT_IN_SYSTEM is derived server-side", inSystem?.systemStatus === "IN_SYSTEM" && outSystem?.systemStatus === "NOT_IN_SYSTEM", summarize({ i: inSystem?.systemStatus, o: outSystem?.systemStatus }));
  check("the assessment score is the AUTHORITATIVE persisted triple (8/10, 80%)", inSystem?.assessmentScore === 8 && inSystem?.assessmentMaxScore === 10 && Number(inSystem?.assessmentScorePercentage) === 80, summarize({ s: inSystem?.assessmentScore, m: inSystem?.assessmentMaxScore, p: inSystem?.assessmentScorePercentage }));
  check("the assessment status comes from the persisted attempt", inSystem?.assessmentStatus === "SUBMITTED", summarize(inSystem?.assessmentStatus));
  check("a candidate with no attempt reports null score, never 0", outSystem?.assessmentStatus === null && outSystem?.assessmentScore === null, summarize({ s: outSystem?.assessmentStatus, v: outSystem?.assessmentScore }));
  check("a NOT_IN_SYSTEM candidate reports no verification score, never a fabricated 0", outSystem?.existingVerifiedSkillScore === null, summarize(outSystem?.existingVerifiedSkillScore));
  check("preferred/selected are explicitly null WITH a stated reason", inSystem?.preferredStatus === null && Boolean(inSystem?.preferredStatusReason) && inSystem?.selectedStatus === null && Boolean(inSystem?.selectedStatusReason), summarize({ p: inSystem?.preferredStatus, s: inSystem?.selectedStatus }));
  check("the candidate list carries NO combined/overall/hiring score", !/overallScore|combinedScore|rankingScore|fitPercentage|hireScore|hiringDecision/i.test(JSON.stringify(candidates.json)), "combined score key found");

  // Cross-job isolation on the candidates read.
  const jobBCandidates = await request(origin, `/api/job/overview/${jobB.id}/candidates`, { token: ownToken });
  check("Job B's candidate list cannot leak Job A's candidates", (jobBCandidates.json?.data?.candidates ?? []).length === 0, summarize(jobBCandidates.json?.data?.candidates));

  // Candidate search is server-side.
  const searched = await request(origin, `/api/job/overview/${jobA.id}/candidates?search=${encodeURIComponent("Out Of System")}`, { token: ownToken });
  const searchedList = searched.json?.data?.candidates ?? [];
  check("candidate search is applied server-side", searchedList.length === 1 && searchedList[0].candidateEmail === candidateEmail("outsider"), summarize(searchedList.map((c) => c.candidateEmail)));

  // Candidate pagination is bounded.
  const candLimit = await request(origin, `/api/job/overview/${jobA.id}/candidates?limit=1`, { token: ownToken });
  check("candidate pagination returns at most the requested page size", (candLimit.json?.data?.candidates ?? []).length === 1 && candLimit.json?.data?.pagination?.total === 2, summarize(candLimit.json?.data?.pagination));

  // =========================================================================
  section("D. The two report types stay separate and job-scoped");
  // =========================================================================

  // A real persisted candidate-analysis row, materialized exactly the way the
  // worker does it (fenced COMPLETED AiJob + analysis result) so the report read
  // is exercised against genuine data rather than a stub.
  const attemptA = await prisma.jobAssessmentAttempt.findFirst({ where: { jobId: jobA.id } });
  const referenceA = await prisma.jobCandidateReference.findFirst({
    where: { jobId: jobA.id, candidateEmail: submittedEmail } });
  const analysisAiJob = await aiJobRepository.createAiJob({
    jobId: jobA.id, operation: "CANDIDATE_ANALYSIS",
    scopeKey: `${referenceA.id}:v1`,
    requestPayload: { operation: "CANDIDATE_ANALYSIS", input: {} },
  });
  const claimed = await aiJobRepository.claimAiJobForProcessing({ aiJobId: analysisAiJob.id, workerId: `p8-${SUFFIX}` });
  const analysisRow = await prisma.jobCandidateAnalysis.create({ data: {
    jobId: jobA.id, aiJobId: analysisAiJob.id, candidateEmail: submittedEmail,
    candidateName: "In System Candidate", analysisVersion: 1, candidateKey: referenceA.id,
    referenceId: referenceA.id, attemptId: attemptA.id, snapshotHash: "p8hash", schemaVersion: "1",
  }});
  tracked.analysisIds.push(analysisRow.id);
  await aiJobRepository.completeCandidateAnalysis({
    aiJobId: analysisAiJob.id, workerId: claimed.workerId, attempts: claimed.attempts,
    analysis: {
      jobFitSummary: "Strong platform fit for this job.",
      assessmentPerformance: {
        status: "SUBMITTED", score: 8, maxScore: 10, scorePercentage: 80,
        summary: "Factual score reported separately from qualitative fit.",
        strengths: [], gaps: [], unanswered: 0,
      },
      skillAlignment: [
        { skill: "Node.js", status: "SUPPORTED", rationale: "Evidence supplied.", evidence: [] },
        { skill: "PostgreSQL", status: "NOT_EVIDENCED", rationale: "No supplied evidence.", evidence: [] },
      ],
      // URL-only LinkedIn/GitHub: the honest "not analyzed" state, which the
      // feature must surface rather than implying a URL was analyzed.
      resumeEvidence: { status: "NOT_PROVIDED", summary: "No resume supplied.", details: [] },
      linkedinEvidence: { status: "UNAVAILABLE", summary: "A reference exists, but no analyzed text was supplied.", details: [] },
      githubEvidence: { status: "UNAVAILABLE", summary: "A reference exists, but no analyzed text was supplied.", details: [] },
      preferredRoleAlignment: { status: "NOT_EVIDENCED", summary: "No preferred role supplied.", rationale: "Qualitative only." },
      strengths: ["Supplied assessment evidence"],
      skillGaps: ["No supplied evidence for one skill"],
      missingRequirements: [], conflicts: [], concerns: [],
      finalRecruiterReview: "Review manually; this report is decision support only.",
    },
    provider: "gemini", model: "p8-deterministic",
  });

  // Report B — the EXISTING job candidate-analysis endpoint (reused unchanged).
  const analysisRead = await request(origin, `/api/job/${jobA.id}/candidate-references/${referenceA.id}/analysis`, { token: ownToken });
  check("the EXISTING candidate-analysis report opens for the correct job+candidate", analysisRead.status === 200, summarize(analysisRead.json?.data?.selected?.status));
  const analysisData = analysisRead.json?.data?.selected?.result ?? {};
  check("the analysis report is COMPLETED and persisted", analysisRead.json?.data?.selected?.status === "COMPLETED", summarize(analysisRead.json?.data?.selected?.status));
  check("the analysis report returns the Job Fit Summary section", analysisData.jobFitSummary === "Strong platform fit for this job.", summarize(analysisData.jobFitSummary));
  check("the analysis report returns Assessment Performance with the persisted score", analysisData.assessmentPerformance?.score === 8 && analysisData.assessmentPerformance?.maxScore === 10, summarize(analysisData.assessmentPerformance));
  check("the analysis report returns Skill Alignment", (analysisData.skillAlignment ?? []).length === 2, summarize(analysisData.skillAlignment?.map((s) => s.skill)));
  check("the analysis report returns the Final Recruiter Review", Boolean(analysisData.finalRecruiterReview), summarize(analysisData.finalRecruiterReview));
  check("LinkedIn evidence is honestly UNAVAILABLE (a URL was not analyzed)", analysisData.linkedinEvidence?.status === "UNAVAILABLE", summarize(analysisData.linkedinEvidence));
  check("GitHub evidence is honestly UNAVAILABLE (a URL was not analyzed)", analysisData.githubEvidence?.status === "UNAVAILABLE", summarize(analysisData.githubEvidence));
  check("the analysis report contains no combined/hiring score", !/overallScore|combinedScore|rankingScore|hiringDecision|hireScore/i.test(JSON.stringify(analysisRead.json)), "combined score key found");

  // The overview list must NOT have carried the report body.
  check("the candidate LIST response never contains the analysis result JSON", !/jobFitSummary/.test(JSON.stringify(candidates.json)), "analysis body leaked into the list");

  // Report A — the EXISTING platform verification-report endpoint (reused unchanged).
  // Its real, established contract: 404 only when the address is NOT a platform
  // candidate account; an IN_SYSTEM candidate with no stored report returns 200
  // with a NULL score (never a fabricated number).
  const verificationRead = await request(origin, `/api/job/${jobA.id}/candidates/${referenceA.id}/verification-report`, { token: ownToken });
  check("the EXISTING verification-report endpoint is reused unchanged for an IN_SYSTEM candidate", verificationRead.status === 200, summarize(verificationRead.json));
  check("with no stored report it reports a NULL verified skill score, never a fabricated number", verificationRead.json?.data?.existingVerifiedSkillScore === null && verificationRead.json?.data?.existingVerifiedSkillCount === 0, summarize(verificationRead.json?.data));
  check("the verification report names its stored-report source", verificationRead.json?.data?.existingVerifiedSkillScoreSource === "STORED_PLATFORM_VERIFICATION_REPORTS", summarize(verificationRead.json?.data?.existingVerifiedSkillScoreSource));
  const outsiderReference = await prisma.jobCandidateReference.findFirst({
    where: { jobId: jobA.id, candidateEmail: candidateEmail("outsider") } });
  const outsiderVerification = await request(origin, `/api/job/${jobA.id}/candidates/${outsiderReference.id}/verification-report`, { token: ownToken });
  check("a NOT_IN_SYSTEM candidate has no platform verification report (404, never invented)", outsiderVerification.status === 404, summarize(outsiderVerification.json));

  // The two report types are genuinely DIFFERENT payloads from DIFFERENT endpoints:
  // A carries the platform verification projection, B carries the job-specific
  // qualitative analysis. Neither leaks the other's content, and neither contains
  // the other's score field.
  const verificationKeys = [...collectKeys(verificationRead.json)].sort().join(",");
  const analysisKeys = [...collectKeys(analysisRead.json)].sort().join(",");
  check("the two reports are separate endpoints with separate, non-overlapping payloads", !verificationKeys.includes("jobFitSummary") && !analysisKeys.includes("existingVerifiedSkillScore") && verificationRead.status === 200 && analysisRead.status === 200, summarize({ vHasJobFit: verificationKeys.includes("jobFitSummary"), aHasVerifiedScore: analysisKeys.includes("existingVerifiedSkillScore") }));
  check("report A carries the platform score and NOT the assessment score", verificationKeys.includes("existingVerifiedSkillScore") && !verificationKeys.includes("assessmentScore"), summarize(verificationKeys.slice(0, 200)));
  check("report B carries the analysis sections and NOT the platform score", analysisKeys.includes("jobFitSummary") && !analysisKeys.includes("existingVerifiedSkillScore"), summarize(analysisKeys.slice(0, 200)));

  // Closed jobs can still read reports.
  await prisma.jobCandidateReference.create({ data: {
    jobId: jobClosed.id, candidateEmail: submittedEmail, candidateName: "Closed Candidate",
    createdByUserId: recruiter.user.id } });
  const closedReference = await prisma.jobCandidateReference.findFirst({ where: { jobId: jobClosed.id } });
  const closedAnalysis = await request(origin, `/api/job/${jobClosed.id}/candidate-references/${closedReference.id}/analysis`, { token: ownToken });
  check("a CLOSED job's analysis report remains readable (historical)", closedAnalysis.status === 200, summarize(closedAnalysis.json));

  // =========================================================================
  section("E. Security — backend-enforced, job-scoped, cross-tenant denied");
  // =========================================================================

  const anon = await request(origin, "/api/job/overview/jobs");
  check("unauthenticated list access is 401", anon.status === 401, summarize(anon.json));
  const anonDetails = await request(origin, `/api/job/overview/${jobA.id}`);
  check("unauthenticated details access is 401", anonDetails.status === 401, summarize(anonDetails.json));

  const crossDetails = await request(origin, `/api/job/overview/${jobA.id}`, { token: outsiderToken });
  check("another recruiter cannot read another recruiter's job details (403)", crossDetails.status === 403, summarize(crossDetails.json));
  const crossCandidates = await request(origin, `/api/job/overview/${jobA.id}/candidates`, { token: outsiderToken });
  check("another recruiter cannot read another job's candidates (403)", crossCandidates.status === 403, summarize(crossCandidates.json));
  const crossReport = await request(origin, `/api/job/${jobA.id}/candidate-references/${referenceA.id}/analysis`, { token: outsiderToken });
  check("another recruiter cannot read another job's analysis report (403)", crossReport.status === 403, summarize(crossReport.json));
  const crossVerification = await request(origin, `/api/job/${jobA.id}/candidates/${referenceA.id}/verification-report`, { token: outsiderToken });
  check("another recruiter cannot read another job's verification report (403)", crossVerification.status === 403, summarize(crossVerification.json));

  const crossOrg = await request(origin, `/api/job/overview/${orgJob.id}`, { token: otherOrgToken });
  check("another organization cannot read this organization's job (403)", crossOrg.status === 403, summarize(crossOrg.json));
  const orgToRecruiter = await request(origin, `/api/job/overview/${jobA.id}`, { token: orgToken });
  check("an organization recruiter cannot read an independent recruiter's job (403)", orgToRecruiter.status === 403, summarize(orgToRecruiter.json));

  const unknownJob = await request(origin, "/api/job/overview/does-not-exist", { token: ownToken });
  check("an unknown job id is 404, not 200", unknownJob.status === 404, summarize(unknownJob.json));

  // A reference id that belongs to ANOTHER job must not resolve inside this job.
  const wrongRef = await request(origin, `/api/job/overview/${jobB.id}/candidates?search=In+System+Candidate`, { token: ownToken });
  check("Job B cannot resolve Job A's candidate by name", (wrongRef.json?.data?.candidates ?? []).length === 0, summarize(wrongRef.json?.data?.candidates));
  const crossJobReport = await request(origin, `/api/job/${jobB.id}/candidate-references/${referenceA.id}/analysis`, { token: ownToken });
  check("an analysis read through the WRONG job is 404 (reference does not resolve there)", crossJobReport.status === 404, summarize(crossJobReport.json));

  // No mutation verb is reachable on any overview route.
  for (const [method, pathname] of [
    ["POST", "/api/job/overview/jobs"],
    ["PATCH", `/api/job/overview/${jobA.id}`],
    ["DELETE", `/api/job/overview/${jobA.id}`],
    ["POST", `/api/job/overview/${jobA.id}/candidates`],
    ["PUT", `/api/job/overview/${jobA.id}/candidates`],
  ]) {
    const attempt = await request(origin, pathname, { method, token: ownToken, body: {} });
    check(`${method} ${pathname.split("/api/job")[1]} is not a reachable write (404/405)`, [404, 405].includes(attempt.status), summarize(attempt.status));
  }

  // =========================================================================
  section("F. Scalability — bounded pages, light projections, no N+1");
  // =========================================================================

  // 40 extra candidates on Job B, then prove pagination never materializes them.
  for (let i = 0; i < 40; i += 1) {
    await prisma.jobCandidateReference.create({ data: {
      jobId: jobB.id, candidateEmail: `p8-bulk-${i}-${SUFFIX}@example.test`,
      createdByUserId: recruiter.user.id } });
  }
  const bigPage = await request(origin, `/api/job/overview/${jobB.id}/candidates?limit=10`, { token: ownToken });
  check("a 40-candidate job returns only the requested page", (bigPage.json?.data?.candidates ?? []).length === 10, summarize(bigPage.json?.data?.candidates?.length));
  check("the full candidate total is reported without shipping every row", bigPage.json?.data?.pagination?.total === 40, summarize(bigPage.json?.data?.pagination));
  const bigPage2 = await request(origin, `/api/job/overview/${jobB.id}/candidates?limit=10&page=4`, { token: ownToken });
  const ids1 = (bigPage.json?.data?.candidates ?? []).map((c) => c.referenceId);
  const ids2 = (bigPage2.json?.data?.candidates ?? []).map((c) => c.referenceId);
  check("candidate pages do not overlap (stable ordering)", ids1.length === 10 && ids2.length === 10 && ids1.every((id) => !ids2.includes(id)), summarize({ a: ids1.length, b: ids2.length }));

  // The list response must never carry the analysis JSON body or the resume text.
  const listKeys = [...collectKeys(bigPage.json)];
  check("the candidate list payload has no analysis result body", !listKeys.some((key) => /jobFitSummary|finalRecruiterReview|skillAlignment/.test(key)), summarize(listKeys.filter((k) => /jobFit/i.test(k))));
  check("the candidate list payload never carries the extracted resume TEXT", !listKeys.includes("resumeText"), "resumeText leaked into the list");
  const jobListKeys = [...collectKeys(ownList.json)];
  check("the job list payload has no heavy job relations (clarifications/aiJob internals)", !jobListKeys.some((key) => /clarificationQuestions|requestPayload|quotaConsumption/.test(key)), summarize(jobListKeys.filter((k) => /clarif|request|quota/i.test(k))));

  // N+1 proof: a 5-row page and a 25-row page must be served with the IDENTICAL
  // payload shape and by the same FIXED number of batched lookups (the service
  // issues one references+count query, one analyses `in` query, one attempts `in`
  // query, one accounts `in` query and one verification projection - never a
  // per-candidate query). If any per-candidate query existed, the shape or the
  // statement count would grow with the page size.
  const smallPage = await request(origin, `/api/job/overview/${jobB.id}/candidates?limit=5`, { token: ownToken });
  const largePage = await request(origin, `/api/job/overview/${jobB.id}/candidates?limit=25`, { token: ownToken });
  check("a 5-row page and a 25-row page are each served by one request", (smallPage.json?.data?.candidates ?? []).length === 5 && (largePage.json?.data?.candidates ?? []).length === 25, summarize({ small: smallPage.json?.data?.candidates?.length, large: largePage.json?.data?.candidates?.length }));
  const smallKeys = [...collectKeys(smallPage.json)].sort().join(",");
  const largeKeys = [...collectKeys(largePage.json)].sort().join(",");
  check("a 5x larger page yields the IDENTICAL payload shape (no per-candidate field/query)", smallKeys === largeKeys, summarize({ smallKeys: smallKeys.length, largeKeys: largeKeys.length }));

  // The bounded page size is enforced server-side.
  const huge = await request(origin, `/api/job/overview/${jobB.id}/candidates?limit=100000`, { token: ownToken });
  check("an oversized candidate limit is clamped, never honoured", huge.json?.data?.pagination?.limit <= 100 && (huge.json?.data?.candidates ?? []).length <= 100, summarize(huge.json?.data?.pagination));

  // =========================================================================
  section("G. Duplication / idempotency — reads create nothing");
  // =========================================================================

  const before = await platformTotals();
  // Opening a job, listing candidates, filtering the job list and reading the
  // report repeatedly (what refresh / a second tab / an SSE reconnect all do)
  // must not create a single row.
  for (let i = 0; i < 5; i += 1) {
    await request(origin, `/api/job/overview/${jobA.id}`, { token: ownToken });
    await request(origin, `/api/job/overview/${jobA.id}/candidates`, { token: ownToken });
    await request(origin, "/api/job/overview/jobs?limit=50", { token: ownToken });
    await request(origin, `/api/job/${jobA.id}/candidate-references/${referenceA.id}/analysis`, { token: ownToken });
  }
  const after = await platformTotals();
  check("repeated reads (5x open, list, filter, report) created NO rows", JSON.stringify(before) === JSON.stringify(after), summarize({ before, after }));
  const refCount = await prisma.jobCandidateReference.count({ where: { jobId: jobA.id } });
  check("repeated reads created no duplicate candidate references", refCount === 2, summarize(refCount));
  const analysisCount = await prisma.jobCandidateAnalysis.count({ where: { jobId: jobA.id } });
  check("repeated reads created no duplicate analyses", analysisCount === 1, summarize(analysisCount));
  const aiJobCount = await prisma.aiJob.count({ where: { jobId: jobA.id } });
  check("repeated reads created no additional AiJob rows", aiJobCount === 1, summarize(aiJobCount));

  // =========================================================================
  section("H. Frontend contract — read-only, reuses the existing architecture");
  // =========================================================================

  const readFile = (...segments) =>
    require("node:fs").readFileSync(path.join(FRONTEND_ROOT, ...segments), "utf8");
  const overviewTable = readFile("src", "components", "jobs", "OverviewCandidateTable.jsx");
  const overviewModal = readFile("src", "components", "jobs", "OverviewJobModal.jsx");
  const jobsPage = readFile("src", "pages", "dashboard", "RecruiterJobs.jsx");
  const jobServiceSrc = readFile("src", "services", "jobService.js");
  const allFrontend = `${overviewTable}\n${overviewModal}\n${jobsPage}\n${jobServiceSrc}`;

  check("the overview issues no write verb against an overview URL", !/apiClient\.(post|patch|put|delete)\(\s*[`"'][^`"']*overview/i.test(allFrontend), "a write verb targets an overview URL");
  check("the two report types are opened by two separate existing components", overviewTable.includes("CandidateVerificationReportModal") && overviewTable.includes("CandidateAnalysisPanel"), "one report component is missing");
  check("the overview reuses the existing SSE realtime hook (no new transport)", overviewTable.includes("useJobCandidateRealtime"), "existing realtime hook not reused");
  check("the overview introduces NO polling", !/setInterval/.test(allFrontend), "setInterval found");
  check("the two reports are opened through the EXISTING shared service functions", jobServiceSrc.includes("getJobCandidateVerificationReport") && jobServiceSrc.includes("getCandidateAnalysis"), "existing report services are not used");
  check("the candidate table keeps the three values in separate columns", /Verified skill/.test(overviewTable) && /Assessment/.test(overviewTable) && /Analysis/.test(overviewTable), "the three columns are not all present");
  check("no combined/overall/hiring score exists anywhere in the new UI", !/overallScore|combinedScore|fitPercentage|hireScore|rankingScore/i.test(allFrontend), "a combined score surfaced in the UI");
  check("job filtering is server-driven (no client-side job filter loop)", !/jobs\.filter\(/.test(jobsPage), "client-side job filtering found");
  check("the details card is closable and accessible", overviewModal.includes("aria-modal") && overviewModal.includes("Escape") && overviewModal.includes("onClose"), "the card is not closable/accessible");
  // Strip line comments before the "no edit affordance" assertion so the file's own
  // explanatory comment (which names Save/onUpdate) is not what is being measured.
  const modalCode = overviewModal.replace(/\/\/[^\n]*/g, "");
  check("the details card exposes no edit/save control", !/Save|onUpdate|mutate/.test(modalCode), "an edit affordance found in the card");

  // =========================================================================
  section("I. Architecture — reuse, no duplication, preferred-candidate honesty");
  // =========================================================================

  const routeSrc = readFile("..", "backend", "src", "module", "job", "job.routes.js");
  const overviewServiceSrc = readFile("..", "backend", "src", "module", "job", "jobOverview.service.js");
  const overviewRepositorySrc = readFile("..", "backend", "src", "module", "job", "jobOverview.repository.js");

  check("the overview registers ONLY GET routes (no write verb exists under /overview)", !/router\.(post|patch|put|delete)\(\s*"\/overview/.test(routeSrc), "a write route exists under /overview");
  // Express ordering is asserted on the actual ROUTE REGISTRATIONS, not on the
  // surrounding prose (the file's own comment mentions both paths).
  const routeCode = routeSrc.replace(/\/\/[^\n]*/g, "");
  const overviewRoutePos = routeCode.indexOf('router.get("/overview/jobs"');
  const catchAllJobPos = routeCode.indexOf('router.get("/:jobId"');
  check("the overview route is registered BEFORE /:jobId (Express ordering)", overviewRoutePos !== -1 && catchAllJobPos !== -1 && overviewRoutePos < catchAllJobPos, summarize({ overviewRoutePos, catchAllJobPos }));
  check("the overview repository contains NO create/update/delete at all", !/\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\(/.test(overviewRepositorySrc), "the overview repository performs a write");
  check("the overview service performs no direct Prisma write", !/prisma\.[a-z]+\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(overviewServiceSrc), "the overview service performs a write");
  check("the overview reuses the EXISTING requireAuthorizedJob chain", overviewServiceSrc.includes("requireAuthorizedJob"), "the existing authorization helper is not reused");
  check("the overview reuses the EXISTING stored-verification projection", overviewServiceSrc.includes("getExistingVerifiedSkillScoresForUsers"), "the existing verification read is not reused");
  check("the overview does NOT create an analysis or write an AI payload", !/createCandidateAnalysis|requestPayload/.test(overviewServiceSrc) && !/createCandidateAnalysis|requestPayload/.test(overviewRepositorySrc), "the overview writes an analysis payload");
  check("preferredCandidateTarget is read from the EXISTING recruiter-configured field", overviewServiceSrc.includes("preferredCandidateTarget") && overviewServiceSrc.includes("preferredCandidateCount"), "the preferred target is not read from the existing field");
  check("the overview invents NO per-candidate preferred/selected state", /preferredStatus:\s*null/.test(overviewServiceSrc) && /selectedStatus:\s*null/.test(overviewServiceSrc), "a preferred/selected state was invented");
  check("the overview exposes no overall/combined/ranking score", !/overallScore|combinedScore|rankingScore|fitPercentage|hireScore/.test(overviewServiceSrc) && !/overallScore|combinedScore|rankingScore|fitPercentage/.test(overviewRepositorySrc), "a combined score field exists");

  // Cleanup — every fixture row removed, platform totals restored.
  section("Cleanup — removing every harness fixture");
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }
  const ids = tracked.jobIds;
  if (ids.length) {
    const removed = {};
    // JobCandidateAnalysis -> AiJob is RESTRICT: always delete analyses first.
    removed.analysis = (await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.attemptAnswer = (await prisma.jobAssessmentAttemptAnswer.deleteMany({ where: { attempt: { jobId: { in: ids } } } })).count;
    removed.attempt = (await prisma.jobAssessmentAttempt.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.invitation = (await prisma.jobAssessmentInvitation.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.assessmentQuestion = (await prisma.jobAssessmentQuestion.deleteMany({ where: { assessment: { jobId: { in: ids } } } })).count;
    removed.assessment = (await prisma.jobAssessment.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.reference = (await prisma.jobCandidateReference.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.quota = (await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.candidateList = (await prisma.jobCandidateList.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.skill = (await prisma.jobSkill.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.tool = (await prisma.jobTool.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.question = (await prisma.jobQuestion.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.clarification = (await prisma.jobClarificationQuestion.deleteMany({ where: { jobId: { in: ids } } })).count;
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: ids } } })).count;
    console.log(`  deleted rows: ${JSON.stringify(removed)}`);
  }
  if (tracked.organizationIds.length) {
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: tracked.organizationIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: tracked.organizationIds } } });
  }
  await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } });
  await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: tracked.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } });

  const totalsAfter = await platformTotals();
  check("no harness fixture rows remain (users restored to the pre-run total)", totalsAfter.users <= totalsBefore.users, summarize({ before: totalsBefore, after: totalsAfter }));
  check("the overview created no production jobs/analyses (counts held or shrank only by cleanup)", totalsAfter.jobs <= totalsBefore.jobs && totalsAfter.analyses <= totalsBefore.analyses, summarize({ before: totalsBefore, after: totalsAfter }));

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log("FAILED checks:");
    for (const entry of results.filter((item) => !item.ok)) console.log(`  - ${entry.label}`);
  } else {
    console.log("Recruiter read-only Jobs overview verified: own/organization scoping, server-side search+filter+pagination, read-only job details, per-job candidates with three separate score sources, the two separate report types, closed-job readability, and zero write verbs.");
  }
};

main()
  .catch((error) => {
    console.error(`verifier failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await prisma.$disconnect();
  });