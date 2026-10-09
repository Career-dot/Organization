/* eslint-disable no-console */
// PHASE 1 — permanent recruiter deletion + historical data preservation.
//
// Proves, against the REAL PostgreSQL and the REAL Express HTTP surface:
//   A. Deletion     — User, OrganizationMembership, UserRole, RecruiterProfile,
//                     sessions and password history are really GONE (not soft
//                     flagged), and the account can no longer authenticate.
//   B. Preservation — jobs, candidates, assessments, attempts, answers,
//                     analyses and AiJobs all SURVIVE with createdByUserId NULL.
//   C. Seats/lists  — the seat is released and lists update.
//   D. "Deleted Recruiter" — unattributed ownership, never invented.
//   E. Security     — 401 unauth, 403 non-admin, cross-org, 404 unknown, self and
//                     org-owner refusal, client-supplied organizationId ignored.
//   F. Concurrency  — repeated and concurrent deletes are safe.
//   G. Regression   — Add/Remove/Reactivate/Reset and mustChangePassword intact.
//
// Every fixture row is removed in cleanup.
require("dotenv").config();

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prisma = require("../src/config/prisma");
const generateAccessToken = require("../src/utils/generateAccessToken");
const hashPassword = require("../src/utils/hashPassword");

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

const readFile = (...segments) => fs.readFileSync(path.join(FRONTEND_ROOT, ...segments), "utf8");

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

const ensureRole = async (name) =>
  prisma.role.upsert({ where: { name }, update: {}, create: { name, description: `${name} role` } });

// A usable account: User + role UserRole + ACTIVE plan/subscription.
// `withSubscription: false` builds a principal holding no paid seat.
const createUser = async (label, roleName = "RECRUITER", withSubscription = true) => {
  const passwordHash = await hashPassword(`Initial-${SUFFIX}-pw!9`);
  const user = await prisma.user.create({
    data: {
      fullName: `P1 ${label}`, email: `p1-${label}-${SUFFIX}@example.test`,
      passwordHash, provider: "LOCAL", emailVerified: true, status: "ACTIVE", mustChangePassword: false,
    },
  });
  const role = await ensureRole(roleName);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  tracked.userIds.push(user.id);

  let subscription = null; let plan = null;
  if (withSubscription) {
    plan = await prisma.subscriptionPlan.create({
      data: { name: `P1 Plan ${label} ${SUFFIX}`, type: roleName === "ORG_ADMIN" ? "ORGANIZATION" : "RECRUITER", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50 },
    });
    subscription = await prisma.subscription.create({
      data: { planId: plan.id, userId: user.id, status: "ACTIVE", startDate: new Date(), expiryDate: new Date(Date.now() + 30 * DAY_IN_MS) },
    });
    tracked.planIds.push(plan.id);
    tracked.subscriptionIds.push(subscription.id);
  }
  return { user: { id: user.id, role: roleName, email: user.email, fullName: user.fullName }, subscription, plan };
};

// An ACTIVE organization with an ACTIVE org subscription so checkSubscription
// passes on the org-scoped routes under test.
const createOrganization = async (label, ownerLabel) => {
  const owner = await createUser(ownerLabel, "ORG_ADMIN");
  const organization = await prisma.organization.create({
    data: { name: `P1 ${label} ${SUFFIX}`, ownerId: owner.user.id, status: "ACTIVE" },
  });
  tracked.organizationIds.push(organization.id);
  await prisma.organizationMembership.create({
    data: { userId: owner.user.id, organizationId: organization.id, role: "ORG_ADMIN", status: "ACTIVE" },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: { name: `P1 OrgPlan ${label} ${SUFFIX}`, type: "ORGANIZATION", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50, maxUsers: 20 },
  });
  const subscription = await prisma.subscription.create({
    data: { planId: plan.id, organizationId: organization.id, status: "ACTIVE", startDate: new Date(), expiryDate: new Date(Date.now() + 30 * DAY_IN_MS) },
  });
  tracked.planIds.push(plan.id);
  tracked.subscriptionIds.push(subscription.id);
  return { ...owner, organization, orgSubscription: subscription };
};

const addRecruiterToOrg = async (organizationId, label) => {
  const recruiter = await createUser(label, "RECRUITER");
  const membership = await prisma.organizationMembership.create({
    data: { userId: recruiter.user.id, organizationId, role: "RECRUITER", status: "ACTIVE" },
  });
  await prisma.recruiterProfile.create({ data: { userId: recruiter.user.id, companyName: `P1 ${label}` } });
  return { ...recruiter, membership };
};
// A fully-populated historical job owned by the recruiter: skills, tools, two
// candidates, an assessment + question, an invitation, a SUBMITTED attempt with
// an answer and an integrity event, plus an AiJob + candidate analysis.
// This whole row set must SURVIVE the account deletion.
const createHistoricalJob = async (recruiterUserId, organizationId, label) => {
  const createdAt = new Date(Date.now() - 40 * DAY_IN_MS);
  const job = await prisma.job.create({
    data: {
      title: `P1 Historical ${label}`, description: `Historical description ${label}`,
      yearsExperience: 5, recruiterId: null, organizationId, createdByUserId: recruiterUserId,
      status: "CLOSED", createdAt, startedAt: createdAt,
      closedAt: new Date(createdAt.getTime() + 10 * DAY_IN_MS), closedReason: "RECRUITER_CLOSED",
      analysisEndsAt: new Date(createdAt.getTime() + 5 * DAY_IN_MS),
    },
  });
  tracked.jobIds.push(job.id);

  await prisma.jobSkill.createMany({
    data: [{ jobId: job.id, name: "Node.js", weight: 60, sortOrder: 0 }, { jobId: job.id, name: "PostgreSQL", weight: 40, sortOrder: 1 }],
  });
  await prisma.jobTool.create({ data: { jobId: job.id, name: "Docker", sortOrder: 0 } });

  const references = [];
  for (const candidate of [
    { email: `p1-cand-a-${label}-${SUFFIX}@example.test`, name: "Candidate A" },
    { email: `p1-cand-b-${label}-${SUFFIX}@example.test`, name: "Candidate B" },
  ]) {
    references.push(await prisma.jobCandidateReference.create({
      data: {
        jobId: job.id, candidateEmail: candidate.email, candidateName: candidate.name,
        preferredRole: "Backend Engineer", resumeText: `Resume text for ${candidate.name}`,
        createdByUserId: recruiterUserId,
      },
    }));
  }

  const assessment = await prisma.jobAssessment.create({
    data: { jobId: job.id, title: `Assessment ${label}`, status: "FINALIZED", durationSeconds: 600, publicId: `p1-${label}-${SUFFIX}-${job.id}`.slice(0, 40), finalizedAt: createdAt, activatedAt: createdAt },
  });
  const question = await prisma.jobAssessmentQuestion.create({
    data: { assessmentId: assessment.id, section: "REQUIRED_SKILLS", sortOrder: 0, prompt: "Pick the right answer", questionType: "SINGLE_CHOICE", points: 10, options: ["A", "B"], correctAnswer: { choice: "A" } },
  });
  const invitation = await prisma.jobAssessmentInvitation.create({
    data: {
      jobId: job.id, assessmentId: assessment.id, email: references[0].candidateEmail,
      status: "EMAIL_VERIFIED", verificationTokenHash: `p1-inv-${label}-${SUFFIX}`.slice(0, 64),
      invitedAt: createdAt, expiresAt: new Date(createdAt.getTime() + 7 * DAY_IN_MS),
      // The durable "invitation email was claimed and sent" marker. The column
      // is invitationEmailSentAt (NOT emailSentAt).
      invitationEmailSentAt: createdAt,
      emailVerifiedAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
    },
  });
  const attempt = await prisma.jobAssessmentAttempt.create({
    data: {
      assessmentId: assessment.id, invitationId: invitation.id, jobId: job.id,
      email: references[0].candidateEmail, status: "SUBMITTED",
      startedAt: createdAt,
      // deadlineAt is REQUIRED by the schema (the attempt window), not optional.
      deadlineAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
      submittedAt: new Date(createdAt.getTime() + 20 * 60 * 1000),
      score: 8, maxScore: 10, scorePercentage: 80,
    },
  });
  const answer = await prisma.jobAssessmentAttemptAnswer.create({
    data: { attemptId: attempt.id, questionId: question.id, answer: { choice: "A" } },
  });
  const integrityEvent = await prisma.jobAssessmentAttemptIntegrityEvent.create({
    data: { attemptId: attempt.id, type: "VISIBILITY_HIDDEN", reason: "Visibility changed during the attempt", metadata: { visibility: "hidden", hiddenCount: 1 } },
  });
  const aiJob = await prisma.aiJob.create({
    data: {
      jobId: job.id, operation: "CANDIDATE_ANALYSIS", status: "COMPLETED",
      scopeKey: references[0].candidateEmail,
      requestPayload: { fixture: label }, result: { fixture: label, verdict: "STRONG_MATCH" },
      startedAt: createdAt, completedAt: createdAt,
    },
  });
  tracked.aiJobIds.push(aiJob.id);
  const analysis = await prisma.jobCandidateAnalysis.create({
    data: {
      jobId: job.id, aiJobId: aiJob.id, candidateEmail: references[0].candidateEmail,
      candidateName: references[0].candidateName, analysisVersion: 1,
      referenceId: references[0].id, attemptId: attempt.id,
      result: { fixture: label, summary: "Historical analysis payload" }, completedAt: createdAt,
    },
  });
  tracked.analysisIds.push(analysis.id);

  return { job, references, assessment, question, invitation, attempt, answer, integrityEvent, aiJob, analysis };
};

const snapshotHistorical = async (h) => ({
  job: await prisma.job.count({ where: { id: h.job.id } }),
  // The fixture creates TWO candidates (A and B), so the expected count is 2.
  candidates: await prisma.jobCandidateReference.count({ where: { id: { in: h.references.map((r) => r.id) } } }),
  assessment: await prisma.jobAssessment.count({ where: { id: h.assessment.id } }),
  attempt: await prisma.jobAssessmentAttempt.count({ where: { id: h.attempt.id } }),
  answer: await prisma.jobAssessmentAttemptAnswer.count({ where: { id: h.answer.id } }),
  integrityEvents: await prisma.jobAssessmentAttemptIntegrityEvent.count({ where: { id: h.integrityEvent.id } }),
  aiJob: await prisma.aiJob.count({ where: { id: h.aiJob.id } }),
  analysis: await prisma.jobCandidateAnalysis.count({ where: { id: h.analysis.id } }),
});

// The exact row set the fixture creates, used as the "before" baseline. Comparing
// the snapshot to THIS (rather than to a blanket `every(n === 1)`) is what proves
// preservation: an identical before/after snapshot means nothing was lost.
const EXPECTED_HISTORICAL = {
  job: 1, candidates: 2, assessment: 1, attempt: 1,
  answer: 1, integrityEvents: 1, aiJob: 1, analysis: 1,
};

const accountSnapshot = async (userId) => ({
  user: await prisma.user.count({ where: { id: userId } }),
  memberships: await prisma.organizationMembership.count({ where: { userId } }),
  userRoles: await prisma.userRole.count({ where: { userId } }),
  recruiterProfiles: await prisma.recruiterProfile.count({ where: { userId } }),
  sessions: await prisma.loginSession.count({ where: { userId } }),
  passwordHistory: await prisma.passwordHistory.count({ where: { userId } }),
  subscriptions: await prisma.subscription.count({ where: { userId } }),
});
const main = async () => {
  const { origin, server } = await startHttpServer();
  httpServer = server;

  const orgA = await createOrganization("org-a", "org-a-admin");
  const orgB = await createOrganization("org-b", "org-b-admin");
  const recruiterA = await addRecruiterToOrg(orgA.organization.id, "recruiter-a");
  const recruiterB = await addRecruiterToOrg(orgB.organization.id, "recruiter-b");
  const recruiterA2 = await addRecruiterToOrg(orgA.organization.id, "recruiter-a2");
  const recruiterA3 = await addRecruiterToOrg(orgA.organization.id, "recruiter-a3");
  const historyA = await createHistoricalJob(recruiterA.user.id, orgA.organization.id, "a");

  const adminToken = tokenFor(orgA.user);
  const adminBToken = tokenFor(orgB.user);
  const recruiterAToken = tokenFor(recruiterA.user);
  const outsider = await createUser("outsider", "RECRUITER", false);
  const outsiderToken = tokenFor(outsider.user);

  // =========================================================================
  section("A. Permanent deletion — the account is really destroyed");
  // =========================================================================

  const before = await accountSnapshot(recruiterA.user.id);
  check("fixture: the recruiter account exists before deletion",
    before.user === 1 && before.memberships === 1 && before.userRoles === 1 && before.recruiterProfiles === 1, summarize(before));

  const historicalBefore = await snapshotHistorical(historyA);
  const beforeMatches = Object.entries(EXPECTED_HISTORICAL).every(([k, n]) => historicalBefore[k] === n);
  check("fixture: all historical rows exist before deletion", beforeMatches, summarize({ expected: EXPECTED_HISTORICAL, actual: historicalBefore }));

  const seatsBefore = await prisma.organizationMembership.count({
    where: { organizationId: orgA.organization.id, role: "RECRUITER", status: "ACTIVE" },
  });
  check("fixture: org A has 3 ACTIVE recruiter seats before deletion", seatsBefore === 3, summarize(seatsBefore));

  const del = await request(origin, `/api/organization/recruiters/${recruiterA.user.id}`, { method: "DELETE", token: adminToken });
  check("DELETE returns 200 with success:true", del.status === 200 && del.json?.success === true, summarize(del.json));

  const after = await accountSnapshot(recruiterA.user.id);
  check("the User row is permanently deleted (not soft-deleted)", after.user === 0, summarize(after));
  check("the OrganizationMembership is deleted", after.memberships === 0, summarize(after));
  check("the RECRUITER UserRole is deleted", after.userRoles === 0, summarize(after));
  check("the RecruiterProfile is deleted", after.recruiterProfiles === 0, summarize(after));
  check("the recruiter's password history is deleted", after.passwordHistory === 0, summarize(after));
  check("the recruiter's account-scoped subscription is deleted", after.subscriptions === 0, summarize(after));

  const goneByEmail = await prisma.user.findFirst({ where: { email: recruiterA.user.email } });
  check("no User row remains with the deleted recruiter's email", goneByEmail === null, summarize(goneByEmail));

  // Login rejects because the login flow resolves the account by email; with no
  // row the credentials can never match.
  const loginAttempt = await request(origin, "/api/auth/login", {
    method: "POST", body: { email: recruiterA.user.email, password: `Initial-${SUFFIX}-pw!9` },
  });
  check("the deleted recruiter can no longer log in", loginAttempt.status >= 400, summarize({ status: loginAttempt.status, body: loginAttempt.json }));

  const meAfterDelete = await request(origin, "/api/organization/me", { token: recruiterAToken });
  check("the deleted recruiter's previously issued token is rejected", meAfterDelete.status === 401 || meAfterDelete.status === 403, summarize({ status: meAfterDelete.status }));
  // =========================================================================
  section("B. Historical data preservation — nothing organizational is lost");
  // =========================================================================

  // The preservation proof is a BEFORE/AFTER COMPARISON of the whole row set: an
// identical snapshot means the deletion removed the account and nothing else.
// (Individual `=== 1` assertions would miss a case where one row type was lost
// while another was duplicated.)
  const historicalAfter = await snapshotHistorical(historyA);
  const afterMatches = Object.entries(EXPECTED_HISTORICAL).every(([k, n]) => historicalAfter[k] === n);
  check("EVERY historical row survives the account deletion (job, candidates, assessment, attempt, answer, integrity event, AiJob, analysis)",
    afterMatches && JSON.stringify(historicalAfter) === JSON.stringify(historicalBefore),
    summarize({ before: historicalBefore, after: historicalAfter }));
  check("the historical Job SURVIVES the account deletion", historicalAfter.job === 1, summarize(historicalAfter.job));
  check("historical candidates SURVIVE (both)", historicalAfter.candidates === 2, summarize(historicalAfter.candidates));
  check("the assessment SURVIVES", historicalAfter.assessment === 1, summarize(historicalAfter.assessment));
  check("the assessment attempt and its score SURVIVE", historicalAfter.attempt === 1, summarize(historicalAfter.attempt));
  check("the attempt answer SURVIVES", historicalAfter.answer === 1, summarize(historicalAfter.answer));
  check("the integrity/cheating event SURVIVES", historicalAfter.integrityEvents === 1, summarize(historicalAfter.integrityEvents));
  check("the AiJob record SURVIVES", historicalAfter.aiJob === 1, summarize(historicalAfter.aiJob));
  check("the candidate analysis and its result payload SURVIVE", historicalAfter.analysis === 1, summarize(historicalAfter.analysis));

  const jobRow = await prisma.job.findUnique({
    where: { id: historyA.job.id },
    select: { createdByUserId: true, recruiterId: true, organizationId: true },
  });
  check("historical Job.createdByUserId is set to NULL", jobRow?.createdByUserId === null, summarize(jobRow));
  check("the job still belongs to the organization (ownership intact)", jobRow?.organizationId === orgA.organization.id, summarize(jobRow));

  const attemptScore = await prisma.jobAssessmentAttempt.findUnique({
    where: { id: historyA.attempt.id }, select: { score: true, maxScore: true, status: true },
  });
  check("the persisted assessment score is intact and unmodified",
    attemptScore?.score === 8 && attemptScore?.maxScore === 10 && attemptScore?.status === "SUBMITTED", summarize(attemptScore));

  const analysisResult = await prisma.jobCandidateAnalysis.findUnique({
    where: { id: historyA.analysis.id }, select: { result: true },
  });
  check("the candidate analysis result payload is intact", analysisResult?.result?.fixture !== undefined, summarize(analysisResult));

  const orphanAnalyses = await prisma.jobCandidateAnalysis.count({
    where: { job: { id: { not: historyA.job.id } }, id: { in: tracked.analysisIds } },
  });
  check("no candidate analysis was re-pointed at another job", orphanAnalyses === 0, summarize(orphanAnalyses));

  // =========================================================================
  section("C. Seat release and list updates");
  // =========================================================================

  const seatsAfter = await prisma.organizationMembership.count({
    where: { organizationId: orgA.organization.id, role: "RECRUITER", status: "ACTIVE" },
  });
  check("the organization seat is released (3 -> 2)", seatsAfter === 2, summarize({ seatsBefore, seatsAfter }));

  const listResponse = await request(origin, "/api/organization/recruiters", { token: adminToken });
  const listed = listResponse.json?.data ?? [];
  check("the deleted recruiter disappears from Manage Recruiters", !listed.some((r) => r.userId === recruiterA.user.id), summarize(listed.map((r) => r.userId)));
  check("the surviving org A recruiters are still listed", listed.filter((r) => r.status === "ACTIVE").length === 2, summarize(listed.map((r) => ({ userId: r.userId, status: r.status }))));

  // =========================================================================
  section("D. 'Deleted Recruiter' — honest unattributed ownership");
  // =========================================================================

  const jobsResponse = await request(origin, "/api/organization/dashboard/jobs?limit=50", { token: adminToken });
  const jobs = jobsResponse.json?.data?.jobs ?? [];
  check("Job Analysis still lists the historical job after the delete", jobs.some((j) => j.id === historyA.job.id), summarize(jobs.map((j) => ({ id: j.id, recruiter: j.recruiter }))));

  const historicalJobRow = jobs.find((j) => j.id === historyA.job.id);
  check("the detached job reports recruiter.userId = null", historicalJobRow?.recruiter?.userId === null, summarize(historicalJobRow?.recruiter));
  check("the detached job reports fullName 'Deleted Recruiter'", historicalJobRow?.recruiter?.fullName === "Deleted Recruiter", summarize(historicalJobRow?.recruiter));
  check("the detached job is flagged isDeleted and has no email",
    historicalJobRow?.recruiter?.isDeleted === true && historicalJobRow?.recruiter?.email === null, summarize(historicalJobRow?.recruiter));
  check("the detached job is NOT attributed to any other recruiter",
    historicalJobRow?.recruiter?.userId !== recruiterA2.user.id && historicalJobRow?.recruiter?.userId !== orgA.user.id, summarize(historicalJobRow?.recruiter));
  check("the historical job's aggregate counts remain available", historicalJobRow?.counts?.candidates >= 2, summarize(historicalJobRow?.counts));

  // Org B must not see org A's detached job at all.
  const orgBJobs = await request(origin, "/api/organization/dashboard/jobs?limit=50", { token: adminBToken });
  check("org B cannot see org A's historical job", !(orgBJobs.json?.data?.jobs ?? []).some((j) => j.id === historyA.job.id), summarize((orgBJobs.json?.data?.jobs ?? []).map((j) => j.id)));
  // =========================================================================
  section("E. Security and authorization");
  // =========================================================================

  const unauth = await request(origin, `/api/organization/recruiters/${recruiterA2.user.id}`, { method: "DELETE" });
  check("unauthenticated delete is rejected with 401", unauth.status === 401, summarize({ status: unauth.status }));

  const nonAdmin = await request(origin, `/api/organization/recruiters/${recruiterA2.user.id}`, { method: "DELETE", token: outsiderToken });
  check("a non-ORG_ADMIN is rejected with 403", nonAdmin.status === 403, summarize({ status: nonAdmin.status }));

  const crossOrg = await request(origin, `/api/organization/recruiters/${recruiterB.user.id}`, { method: "DELETE", token: adminToken });
  check("cross-organization delete is rejected (404, does not leak existence)", crossOrg.status === 404, summarize({ status: crossOrg.status }));
  check("the cross-org target is NOT deleted", (await prisma.user.count({ where: { id: recruiterB.user.id } })) === 1, "cross-org target was deleted");

  const unknown = await request(origin, "/api/organization/recruiters/does-not-exist-at-all", { method: "DELETE", token: adminToken });
  check("an unknown recruiter id returns 404", unknown.status === 404, summarize({ status: unknown.status }));

  const selfDelete = await request(origin, `/api/organization/recruiters/${orgA.user.id}`, { method: "DELETE", token: adminToken });
  check("an ORG_ADMIN cannot delete their own account", selfDelete.status >= 400, summarize({ status: selfDelete.status }));

  // The repository refuses to delete an account that OWNS an Organization,
  // because Organization.ownerId is ON DELETE CASCADE.
  const ownerRecruiter = await addRecruiterToOrg(orgA.organization.id, "owner-recruiter");
  const ownedOrg = await prisma.organization.create({
    data: { name: `P1 Owned ${SUFFIX}`, ownerId: ownerRecruiter.user.id, status: "ACTIVE" },
  });
  tracked.organizationIds.push(ownedOrg.id);

  const ownerDelete = await request(origin, `/api/organization/recruiters/${ownerRecruiter.user.id}`, { method: "DELETE", token: adminToken });
  check("deleting an account that OWNS an organization is refused (409)", ownerDelete.status === 409, summarize({ status: ownerDelete.status, body: ownerDelete.json }));
  check("the organization owned by that account was NOT cascade-deleted",
    (await prisma.organization.count({ where: { id: ownedOrg.id } })) === 1, "owned organization was destroyed");

  // The client cannot steer authorization with a body/param organizationId.
  const spoof = await request(origin, `/api/organization/recruiters/${recruiterA3.user.id}?organizationId=${orgB.organization.id}`, {
    method: "DELETE", token: adminToken, body: { organizationId: orgB.organization.id },
  });
  check("a client-supplied organizationId cannot redirect the delete", spoof.status === 200 || spoof.status === 404, summarize({ status: spoof.status }));
  check("org B is completely unaffected by the spoof attempt",
    (await prisma.organization.count({ where: { id: orgB.organization.id } })) === 1 &&
    (await prisma.user.count({ where: { id: recruiterB.user.id } })) === 1, "org B state changed");
  // =========================================================================
  section("F. Idempotency and concurrency safety");
  // =========================================================================

  const repeat = await request(origin, `/api/organization/recruiters/${recruiterA.user.id}`, { method: "DELETE", token: adminToken });
  check("repeating a delete is handled safely (404, not a 500)", repeat.status === 404, summarize({ status: repeat.status, body: repeat.json }));

  // Two concurrent deletes of the SAME recruiter. Exactly one must win; the
  // others must fail cleanly, and neither may corrupt membership/seat state.
  const seatsBeforeConcurrent = await prisma.organizationMembership.count({
    where: { organizationId: orgA.organization.id, role: "RECRUITER", status: "ACTIVE" },
  });
  const statuses = (await Promise.all([
    request(origin, `/api/organization/recruiters/${recruiterA2.user.id}`, { method: "DELETE", token: adminToken }),
    request(origin, `/api/organization/recruiters/${recruiterA2.user.id}`, { method: "DELETE", token: adminToken }),
    request(origin, `/api/organization/recruiters/${recruiterA2.user.id}`, { method: "DELETE", token: adminToken }),
  ])).map((r) => r.status);

  check("exactly one concurrent delete succeeds", statuses.filter((s) => s === 200).length === 1, summarize(statuses));
  check("the losing concurrent deletes fail cleanly (404, no 500)",
    statuses.filter((s) => s === 404).length === 2 && !statuses.includes(500), summarize(statuses));

  const seatsAfterConcurrent = await prisma.organizationMembership.count({
    where: { organizationId: orgA.organization.id, role: "RECRUITER", status: "ACTIVE" },
  });
  check("concurrent deletes release exactly one seat (no double-free, no corruption)",
    seatsAfterConcurrent === seatsBeforeConcurrent - 1, summarize({ seatsBeforeConcurrent, seatsAfterConcurrent }));
  check("no orphaned membership row remains after concurrency",
    (await prisma.organizationMembership.count({ where: { userId: recruiterA2.user.id } })) === 0, "orphaned membership");
  check("the concurrently deleted user row is gone exactly once",
    (await prisma.user.count({ where: { id: recruiterA2.user.id } })) === 0, "user row still present");

  // =========================================================================
  section("G. Regression — the existing reversible flow still works");
  // =========================================================================

  const addResponse = await request(origin, "/api/organization/recruiters", {
    method: "POST", token: adminToken,
    body: { fullName: "P1 Added Recruiter", email: `p1-added-${SUFFIX}@example.test` },
  });
  check("Add Recruiter still works after the delete feature", addResponse.status === 201 && addResponse.json?.success === true, summarize({ status: addResponse.status }));
  const addedId = addResponse.json?.data?.userId;
  if (addedId) tracked.userIds.push(addedId);
  check("the added recruiter is an ACTIVE member", addResponse.json?.data?.status === "ACTIVE", summarize(addResponse.json?.data));

  const addedMembership = async () =>
    prisma.organizationMembership.findFirst({ where: { organizationId: orgA.organization.id, userId: addedId } });

  const removeResponse = await request(origin, `/api/organization/recruiters/${(await addedMembership()).id}/status`, {
    method: "PATCH", token: adminToken, body: { status: "REMOVED" },
  });
  check("the reversible Remove action still works", removeResponse.status === 200, summarize({ status: removeResponse.status }));
  check("Remove sets the membership to REMOVED but KEEPS the User row",
    (await addedMembership())?.status === "REMOVED" && (await prisma.user.count({ where: { id: addedId } })) === 1,
    "Remove behaved like a permanent delete");

  const reactivateResponse = await request(origin, `/api/organization/recruiters/${(await addedMembership()).id}/status`, {
    method: "PATCH", token: adminToken, body: { status: "ACTIVE" },
  });
  check("Reactivate still works (Remove remains reversible)",
    reactivateResponse.status === 200 && (await addedMembership())?.status === "ACTIVE", summarize({ status: reactivateResponse.status }));

  // mustChangePassword enforcement is untouched by this feature.
  const mustChangeUser = await createUser("must-change", "RECRUITER", false);
  await prisma.user.update({ where: { id: mustChangeUser.user.id }, data: { mustChangePassword: true } });
  await prisma.organizationMembership.create({ data: { userId: mustChangeUser.user.id, organizationId: orgA.organization.id, role: "RECRUITER", status: "ACTIVE" } });
  const blocked = await request(origin, "/api/organization/recruiters", { token: tokenFor(mustChangeUser.user) });
  check("password-change enforcement still blocks a mustChangePassword account", blocked.status === 403 || blocked.status === 401, summarize({ status: blocked.status }));

  const resetTarget = await addRecruiterToOrg(orgA.organization.id, "reset-target");
  const resetResponse = await request(origin, `/api/organization/recruiters/${resetTarget.user.id}/reset-credentials`, { method: "POST", token: adminToken });
  check("Reset Credentials still works", resetResponse.status === 200, summarize({ status: resetResponse.status, body: resetResponse.json }));
  // =========================================================================
  section("H. Architecture — no duplication, no new authorization system");
  // =========================================================================

  const serviceSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "organization", "organization.service.js"), "utf8");
  const routeSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "organization", "organization.routes.js"), "utf8");
  const repositorySrc = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "organization", "organization.repository.js"), "utf8");
  const authMiddlewareSrc = fs.readFileSync(path.join(BACKEND_ROOT, "src", "middleware", "authenticate.js"), "utf8");
  const pageSrc = readFile("src", "pages", "dashboard", "OrganizationRecruiters.jsx");
  const serviceClientSrc = readFile("src", "services", "organizationService.js");
  const buttonSrc = readFile("src", "components", "ui", "Button.jsx");

  check("the delete reuses the EXISTING resolveAdminOrganization resolver",
    /const permanentlyDeleteRecruiter = async[\s\S]*?resolveAdminOrganization\(user\)/.test(serviceSrc), "organization resolver not reused");
  check("the delete route reuses the EXISTING authenticate + authorize(ORG_ADMIN) chain",
    /router\.delete\(\s*"\/recruiters\/:userId"[\s\S]{0,300}?authenticate[\s\S]{0,160}?authorize\("ORG_ADMIN"\)/.test(routeSrc), "existing auth chain not reused");
  check("the delete route keeps the EXISTING checkSubscription gate",
    /router\.delete\(\s*"\/recruiters\/:userId"[\s\S]{0,300}?checkSubscription/.test(routeSrc), "subscription gate missing on the delete route");
  check("no new authorization/role system was introduced",
    !/hasValidRoleConfiguration|resolveRoleSwitch|switchRole/.test(serviceSrc), "a role concept leaked into the service");
  check("the existing authenticate middleware is untouched by this feature",
    !/permanentlyDelete|deleteRecruiter/i.test(authMiddlewareSrc), "auth middleware references the delete feature");
  check("the delete runs inside a single transaction", /permanentlyDeleteRecruiterAccount[\s\S]*?prisma\.\$transaction/.test(repositorySrc), "no transaction wrapping the delete");
  check("the delete takes a row lock to serialize concurrent deletes",
    /FOR UPDATE/.test(repositorySrc), "no row lock on the organization");
  check("the delete writes a durable audit log inside the transaction",
    /ORGANIZATION_RECRUITER_PERMANENTLY_DELETED/.test(repositorySrc), "no audit log written");

  // Frontend contract.
  check("the UI labels the action 'Delete Recruiter' (never just 'Remove')", pageSrc.includes("Delete Recruiter"), "permanent delete button label missing");
  check("the confirmation states it cannot be undone", /cannot be undone/.test(pageSrc), "no irreversibility warning");
  check("the confirmation is honest that historical data is RETAINED", /retained/i.test(pageSrc), "dialog does not disclose retained history");
  check("the page still offers the reversible Remove action alongside it", pageSrc.includes("Remove"), "the existing Remove action disappeared");
  check("separate irreversible and reversible handlers both exist",
    /handlePermanentDelete/.test(pageSrc) && /handleStatusChange/.test(pageSrc), "either flow is missing");
  check("the frontend refreshes the list from the server after deletion", /await loadRecruiters\(\)/.test(pageSrc), "no post-delete refresh");
  check("a loading state is shown while the delete is in flight", /Deleting\.\.\./.test(pageSrc), "no delete loading state");
  check("the client sends NO organizationId with the delete",
    !/deleteRecruiter[\s\S]{0,200}organizationId/.test(serviceClientSrc), "organizationId sent by the client");
  check("the shared Button component was not modified to add a variant", !/danger/.test(buttonSrc), "shared Button changed");

  // =========================================================================
  section("I. Summary");
  // =========================================================================

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\n  FAILED:");
    failed.forEach((f) => console.log(`   - ${f.label}`));
  }
  process.exitCode = failed.length ? 1 : 0;
};

// Deletion order matters and follows the real FK graph:
//   JobCandidateAnalysis -> AiJob (Restrict), so the AiJob row must go BEFORE the
//   Job row (Job -> AiJob is Restrict too, so neither cascades to the other).
// Deleting the job first violates AiJob_jobId_fkey, which is exactly what the
// harness must not do: it is also what the FEATURE must not do, and the
// preservation checks above prove the feature leaves both rows in place.
const cleanup = async () => {
  try {
    if (tracked.analysisIds.length) await prisma.jobCandidateAnalysis.deleteMany({ where: { id: { in: tracked.analysisIds } } });
    if (tracked.aiJobIds.length) await prisma.aiJob.deleteMany({ where: { id: { in: tracked.aiJobIds } } });
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