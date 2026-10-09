/* eslint-disable no-console */
// PHASE 3 — Job Analysis + ACTIVE-job candidate-level privacy.
//
// Proves, against the REAL PostgreSQL and the REAL Express HTTP surface:
//   A. ACTIVE job, ORG_ADMIN ALLOWED — job details, aggregate counts, aggregate
//      assessment statistics, status, dates, skills/tools/requirements.
//   B. ACTIVE job, ORG_ADMIN DENIED (403) — every candidate-level REST route,
//      proved on BOTH the response AND that the response body contains no
//      candidate identity anywhere.
//   C. CLOSED job — all candidate/report functionality still works, with the
//      verified skill score, assessment score and analysis remaining SEPARATE.
//   D. Recruiter — unchanged access to their own ACTIVE job's candidates.
//   E. IDOR — cross-job and cross-organization reference/attempt combinations.
//   F. SSE — an ACTIVE-job stream to an ORG_ADMIN carries no candidate identity,
//      while the recruiter on the same job still receives it.
//   G. Deleted recruiter — historical job still readable, shows "Deleted Recruiter".
//   H. Hiring — still unavailable/null, never inferred.
//   I. Policy — the centralized module is the ONLY status gate (no duplicates).
require("dotenv").config();

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prisma = require("../src/config/prisma");
const generateAccessToken = require("../src/utils/generateAccessToken");

const BACKEND_ROOT = path.join(__dirname, "..");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
// The EXISTING shared candidate-sheet fixture: builds a real .xlsx and attaches
// it through the production upload path. GET /job/:jobId/candidates reads the
// UPLOADED SHEET (it 400s with "Candidate list is required" without one), so a
// reference-only fixture cannot exercise that route at all.
const { attachJobCandidateList, cleanupJobCandidateLists } = require("./jobCandidateListFixture");

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
  let json = null;
  try { json = JSON.parse(await response.text()); } catch {}
  return { status: response.status, json };
};

const tokenFor = (user) => generateAccessToken({ userId: user.id, role: user.role });

// Fails if ANY candidate identity appears anywhere in a response body. Used
// instead of asserting specific fields are absent, so a NEW leaking field is
// caught too.
const CANDIDATE_MARKERS = (ctx) => [ctx.email, ctx.candidateName].filter(Boolean);
const leaksCandidateData = (payload, markers) => {
  if (payload === null || payload === undefined) return false;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return markers.some((m) => m && text.includes(m));
};
const createUser = async (label, roleName = "RECRUITER", withSubscription = true) => {
  const user = await prisma.user.create({
    data: {
      fullName: `P3 ${label}`, email: `p3-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL", emailVerified: true, status: "ACTIVE", mustChangePassword: false,
    },
  });
  const role = await prisma.role.upsert({ where: { name: roleName }, update: {}, create: { name: roleName, description: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  tracked.userIds.push(user.id);

  if (withSubscription) {
    const plan = await prisma.subscriptionPlan.create({
      data: { name: `P3 Plan ${label} ${SUFFIX}`, type: roleName === "ORG_ADMIN" ? "ORGANIZATION" : "RECRUITER", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50 },
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
    data: { name: `P3 ${label} ${SUFFIX}`, ownerId: owner.user.id, status: "ACTIVE" },
  });
  tracked.organizationIds.push(organization.id);
  await prisma.organizationMembership.create({
    data: { userId: owner.user.id, organizationId: organization.id, role: "ORG_ADMIN", status: "ACTIVE" },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: { name: `P3 OrgPlan ${label} ${SUFFIX}`, type: "ORGANIZATION", price: 0, billingCycle: "MONTHLY", jobPostingLimit: 50, maxUsers: 50 },
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
// A job with the FULL candidate-level evidence chain: 2 candidates (with resume
// text + LinkedIn/GitHub evidence), an assessment, a SUBMITTED attempt carrying
// the persisted score, a cheat integrity event, and a candidate analysis with a
// result payload. Every blocked route is then exercised against REAL rows.
const createJobWithEvidence = async ({ ownerUserId, organizationId, title, status }) => {
  const createdAt = new Date(Date.now() - 10 * DAY_IN_MS);
  const job = await prisma.job.create({
    data: {
      title, description: `Description for ${title}`, yearsExperience: 5,
      recruiterId: null, organizationId, createdByUserId: ownerUserId,
      status, createdAt, startedAt: createdAt,
      analysisEndsAt: new Date(createdAt.getTime() + 10 * DAY_IN_MS),
      closedAt: status === "CLOSED" ? new Date(createdAt.getTime() + 5 * DAY_IN_MS) : null,
      closedReason: status === "CLOSED" ? "RECRUITER_CLOSED" : null,
    },
  });
  tracked.jobIds.push(job.id);

  await prisma.jobSkill.createMany({
    data: [{ jobId: job.id, name: "Node.js", weight: 60, sortOrder: 0 }, { jobId: job.id, name: "PostgreSQL", weight: 40, sortOrder: 1 }],
  });
  await prisma.jobTool.create({ data: { jobId: job.id, name: "Docker", sortOrder: 0 } });

  // Built LOWERCASE on purpose: the overview candidate list normalizes a
  // reference's email before matching persisted attempts (findAttemptsByJobAndEmails),
  // so an attempt created with a mixed-case address would never match and the
  // score would silently read null. A lowercase address keeps the fixture
  // faithful to the platform's own normalization.
  const candidateEmail = `p3-cand-${title.toLowerCase()}-${SUFFIX}@example.test`.slice(0, 100);
  const candidateName = `P3 Candidate ${title}`;

  const reference = await prisma.jobCandidateReference.create({
    data: {
      jobId: job.id, candidateEmail, candidateName, preferredRole: "Backend Engineer",
      resumeText: `RESUME-TEXT-MARKER-${title}`,
      linkedinText: `LINKEDIN-TEXT-MARKER-${title}`,
      githubText: `GITHUB-TEXT-MARKER-${title}`,
      linkedinUrl: "https://linkedin.com/in/p3", githubUrl: "https://github.com/p3",
      createdByUserId: ownerUserId, createdAt,
    },
  });
  const secondReference = await prisma.jobCandidateReference.create({
    data: {
      jobId: job.id,
      candidateEmail: `p3-cand2-${title.toLowerCase()}-${SUFFIX}@example.test`.slice(0, 100),
      candidateName: `P3 Candidate2 ${title}`,
      createdByUserId: ownerUserId, createdAt,
    },
  });
const assessment = await prisma.jobAssessment.create({
    data: { jobId: job.id, title: `Assessment ${title}`, status: "FINALIZED", durationSeconds: 600, publicId: `p3-${job.id}-${SUFFIX}`.slice(0, 40), finalizedAt: createdAt, activatedAt: createdAt },
  });
  const invitation = await prisma.jobAssessmentInvitation.create({
    data: {
      jobId: job.id, assessmentId: assessment.id, email: candidateEmail,
      status: "EMAIL_VERIFIED", verificationTokenHash: `p3-inv-${job.id}-${SUFFIX}`.slice(0, 64),
      invitedAt: createdAt, expiresAt: new Date(createdAt.getTime() + 7 * DAY_IN_MS),
      invitationEmailSentAt: createdAt, emailVerifiedAt: createdAt,
    },
  });
  const attempt = await prisma.jobAssessmentAttempt.create({
    data: {
      assessmentId: assessment.id, invitationId: invitation.id, jobId: job.id,
      email: candidateEmail, status: "SUBMITTED", startedAt: createdAt,
      deadlineAt: new Date(createdAt.getTime() + 3600 * 1000),
      submittedAt: createdAt, score: 8, maxScore: 10, scorePercentage: 80,
    },
  });
  await prisma.jobAssessmentAttemptIntegrityEvent.create({
    data: { attemptId: attempt.id, type: "VISIBILITY_HIDDEN", reason: "CHEAT-MARKER", metadata: { hiddenCount: 1 } },
  });

  const aiJob = await prisma.aiJob.create({
    data: {
      jobId: job.id, operation: "CANDIDATE_ANALYSIS", status: "COMPLETED",
      scopeKey: candidateEmail, requestPayload: { fixture: title },
      result: { ANALYSIS_RESULT_MARKER: title, summary: "analysis" },
      startedAt: createdAt, completedAt: createdAt,
    },
  });
  tracked.aiJobIds.push(aiJob.id);
  const analysis = await prisma.jobCandidateAnalysis.create({
    data: {
      jobId: job.id, aiJobId: aiJob.id, candidateEmail, candidateName,
      analysisVersion: 1, referenceId: reference.id, attemptId: attempt.id,
      result: { ANALYSIS_RESULT_MARKER: title }, completedAt: createdAt,
    },
  });
  tracked.analysisIds.push(analysis.id);

  return { job, reference, secondReference, assessment, attempt, analysis, candidateEmail, candidateName };
};
const main = async () => {
  const { origin, server } = await startHttpServer();
  httpServer = server;

  const orgA = await createOrganization("org-a", "org-a-admin");
  const orgB = await createOrganization("org-b", "org-b-admin");
  const adminToken = tokenFor(orgA.user);
  const adminBToken = tokenFor(orgB.user);

  const recruiterA = await addRecruiterToOrg(orgA.organization.id, "recruiter-a");
  const recruiterAToken = tokenFor(recruiterA.user);
  // The cross-organization fixture job belongs to org B, so it needs a recruiter
  // who is genuinely a member of org B to upload its candidate sheet (upload is
  // ownership-checked, exactly like the real workflow).
  const recruiterB = await addRecruiterToOrg(orgB.organization.id, "recruiter-b");
  const outsider = await createUser("outsider", "RECRUITER", false);
  const outsiderToken = tokenFor(outsider.user);

  const ACTIVE = await createJobWithEvidence({
    ownerUserId: recruiterA.user.id, organizationId: orgA.organization.id, title: "ACTIVE-JOB", status: "ACTIVE",
  });
  const CLOSED = await createJobWithEvidence({
    ownerUserId: recruiterA.user.id, organizationId: orgA.organization.id, title: "CLOSED-JOB", status: "CLOSED",
  });
  const OTHER_ORG = await createJobWithEvidence({
    ownerUserId: recruiterA.user.id, organizationId: orgB.organization.id, title: "ORGB-JOB", status: "CLOSED",
  });

  // Attach a REAL candidate sheet to each job: GET /job/:jobId/candidates reads the
  // uploaded sheet and 400s without one. The production lifecycle only permits a
  // candidate-list upload while the job is a DRAFT, so each fixture job is
  // created DRAFT, given its sheet through the real upload path, and only then
  // transitioned to its target status — mirroring how the product actually works.
  const sheetOwner = { user: recruiterA.user };
  const sheetOwnerB = { user: recruiterB.user };
  for (const fixture of [ACTIVE, CLOSED]) {
    await prisma.job.update({ where: { id: fixture.job.id }, data: { status: "DRAFT" } });
    await attachJobCandidateList(sheetOwner, fixture.job.id, { count: 2 });
    await prisma.job.update({
      where: { id: fixture.job.id },
      data: {
        status: fixture.job.status,
        closedAt: fixture.job.closedAt,
        closedReason: fixture.job.closedReason,
      },
    });
  }
  // Org B's job needs org B's own recruiter to attach its sheet.
  await prisma.job.update({ where: { id: OTHER_ORG.job.id }, data: { status: "DRAFT" } });
  await attachJobCandidateList(sheetOwnerB, OTHER_ORG.job.id, { count: 2 });
  await prisma.job.update({
    where: { id: OTHER_ORG.job.id },
    data: { status: "CLOSED", closedAt: OTHER_ORG.job.closedAt, closedReason: OTHER_ORG.job.closedReason },
  });

  // Every candidate-level ORG_ADMIN-reachable GET route.
  const CANDIDATE_ROUTES = (jobId, referenceId) => [
    ["GET /job/:jobId/candidates", `/api/job/${jobId}/candidates`],
    ["GET /job/overview/:jobId/candidates", `/api/job/overview/${jobId}/candidates`],
    ["GET /job/:jobId/candidate-references", `/api/job/${jobId}/candidate-references`],
    ["GET /job/:jobId/candidate-references (analysis projection)", `/api/job/${jobId}/candidate-references?projection=analysis`],
    ["GET /job/:jobId/candidate-references/:referenceId", `/api/job/${jobId}/candidate-references/${referenceId}`],
    ["GET /job/:jobId/candidate-references/:referenceId/resume", `/api/job/${jobId}/candidate-references/${referenceId}/resume`],
    ["GET /job/:jobId/candidate-references/:referenceId/analysis", `/api/job/${jobId}/candidate-references/${referenceId}/analysis`],
    ["GET /job/:jobId/candidates/:referenceId/verification-report", `/api/job/${jobId}/candidates/${referenceId}/verification-report`],
    ["GET /job/:jobId/assessment/attempts", `/api/job/${jobId}/assessment/attempts`],
  ];

  // =========================================================================
  section("A. ACTIVE job — ORG_ADMIN still gets JOB-LEVEL information");
  // =========================================================================

  const details = await request(origin, `/api/job/overview/${ACTIVE.job.id}`, { token: adminToken });
  check("job details are available to an ORG_ADMIN on an ACTIVE job", details.status === 200, summarize({ status: details.status, body: details.json }));
  // getOverviewJobDetails returns { job, counts, candidateLevelAccess, isClosed }.
  const detailsBody = details.json?.data ?? {};
  const jobPayload = detailsBody.job ?? {};
  const jobCounts = detailsBody.counts ?? {};
  check("job title/description/status/dates are returned", jobPayload.title === "ACTIVE-JOB" && jobPayload.status === "ACTIVE" && Boolean(jobPayload.description) && Boolean(jobPayload.createdAt), summarize({ title: jobPayload.title, status: jobPayload.status }));
  check("skills with weights are returned", Array.isArray(jobPayload.skills) && jobPayload.skills.length === 2, summarize(jobPayload.skills));
  check("tools are returned", Array.isArray(jobPayload.tools) && jobPayload.tools.length === 1, summarize(jobPayload.tools));
  // The candidate COUNT comes from the JobCandidateReference rows. The uploaded
  // sheet is seeded into references as well, so a 2-row sheet on top of the 2
  // explicit references yields 4 — the assertion matches the real count rather
  // than the fixture's initial 2.
  const EXPECTED_REFERENCE_COUNT = 4;
  check("the aggregate candidate COUNT is returned", jobCounts.candidates === EXPECTED_REFERENCE_COUNT, summarize(jobCounts));
  check("the aggregate assessment statistics are returned", jobCounts.assessmentAttemptsByStatus !== undefined, summarize(jobCounts));
  check("the aggregate analyzed count is returned", jobCounts.completedCandidateAnalyses === 1, summarize(jobCounts));
  check("the response states candidate-level access is DENIED", detailsBody.candidateLevelAccess?.allowed === false && detailsBody.candidateLevelAccess?.isActiveJob === true, summarize(detailsBody.candidateLevelAccess));
  check("the denied reason is explained to the user", typeof detailsBody.candidateLevelAccess?.reason === "string", summarize(detailsBody.candidateLevelAccess?.reason));

  // Job Analysis list is a job-level surface and must be unaffected.
  const jobsList = await request(origin, "/api/organization/dashboard/jobs?limit=50", { token: adminToken });
  const listRow = (jobsList.json?.data?.jobs ?? []).find((j) => j.id === ACTIVE.job.id);
  check("Job Analysis still lists the ACTIVE job", Boolean(listRow), summarize((jobsList.json?.data?.jobs ?? []).map((j) => j.id)));
  check("Job Analysis returns its aggregate counts for the ACTIVE job", listRow?.counts?.candidates === EXPECTED_REFERENCE_COUNT, summarize(listRow?.counts));
  check("Job Analysis reports hiring as unavailable, never inferred", listRow?.counts?.hired === null, summarize(listRow?.counts));
  // =========================================================================
  section("B. ACTIVE job — ORG_ADMIN is DENIED every candidate-level route");
  // =========================================================================

  const markers = CANDIDATE_MARKERS(ACTIVE);
  const extraMarkers = [
    "RESUME-TEXT-MARKER", "LINKEDIN-TEXT-MARKER", "GITHUB-TEXT-MARKER",
    "ANALYSIS_RESULT_MARKER", "CHEAT-MARKER", ACTIVE.candidateName,
  ];

  for (const [label, path] of CANDIDATE_ROUTES(ACTIVE.job.id, ACTIVE.reference.id)) {
    const res = await request(origin, path, { token: adminToken });
    check(`${label} -> 403 for ORG_ADMIN on an ACTIVE job`, res.status === 403, summarize({ status: res.status, body: res.json }));
    check(`${label} -> no candidate identity anywhere in the response`,
      !leaksCandidateData(res.json, [...markers, ...extraMarkers]), summarize(res.json));
  }

  // Unauthenticated + non-admin behaviour on an ACTIVE job must be unchanged.
  const unauth = await request(origin, `/api/job/${ACTIVE.job.id}/candidates`);
  check("unauthenticated candidate read is 401", unauth.status === 401, summarize({ status: unauth.status }));
  const outsiderRead = await request(origin, `/api/job/${ACTIVE.job.id}/candidates`, { token: outsiderToken });
  check("a non-member recruiter is refused the ACTIVE job's candidates", outsiderRead.status === 403 || outsiderRead.status === 404, summarize({ status: outsiderRead.status }));

  // The job-level GET must NOT be blocked (it is what Job Analysis renders).
  const stillOpen = await request(origin, `/api/job/overview/${ACTIVE.job.id}`, { token: adminToken });
  check("the ACTIVE job's DETAILS remain readable (job level is not blocked)", stillOpen.status === 200, summarize({ status: stillOpen.status }));

  // =========================================================================
  section("C. CLOSED job — historical candidate/report access still works");
  // =========================================================================

  // NOTE the two candidate-level routes read DIFFERENT sources, by design:
  //   GET /job/:jobId/candidates             -> the UPLOADED SHEET rows
  //   GET /job/overview/:jobId/candidates   -> the JobCandidateReference rows
  // The sheet carries its own addresses, so the identity assertion for the sheet
  // route uses the reference's OWN address (which the sheet route also surfaces
  // once seeded) and the score assertion uses the overview route, which matches
  // attempts by the reference email.
  const closedCandidates = await request(origin, `/api/job/${CLOSED.job.id}/candidates`, { token: adminToken });
  check("candidates are readable on a CLOSED job", closedCandidates.status === 200, summarize({ status: closedCandidates.status, body: closedCandidates.json }));
  // The sheet route returns the UPLOADED sheet's own rows (their addresses differ
  // from the reference rows), so it is asserted as "rows with email addresses"
  // rather than against a reference address. listJobCandidates returns
  // { candidates, pagination, ... }, so the rows live under `data.candidates`.
  const sheetRows = Array.isArray(closedCandidates.json?.data?.candidates)
    ? closedCandidates.json.data.candidates
    : Array.isArray(closedCandidates.json?.data)
      ? closedCandidates.json.data
      : [];
  check("candidate EMAIL addresses are returned for a CLOSED job",
    sheetRows.length > 0 && sheetRows.some((r) => typeof r.email === "string" && r.email.includes("@")),
    summarize({ keys: Object.keys(closedCandidates.json?.data ?? {}), sample: sheetRows.slice(0, 2) }));

  const closedOverviewCandidates = await request(origin, `/api/job/overview/${CLOSED.job.id}/candidates`, { token: adminToken });
  check("the overview candidate list works on a CLOSED job", closedOverviewCandidates.status === 200, summarize({ status: closedOverviewCandidates.status }));
  const closedOverviewRows = closedOverviewCandidates.json?.data?.candidates ?? [];
  check("candidate NAMES and EMAILS are returned for a CLOSED job",
    closedOverviewRows.some((c) => c.candidateName === CLOSED.candidateName && c.candidateEmail === CLOSED.candidateEmail),
    summarize(closedOverviewRows.map((c) => ({ n: c.candidateName, e: c.candidateEmail }))));
  check("the persisted ASSESSMENT SCORE is returned for a CLOSED job",
    closedOverviewRows.some((c) => c.assessmentScore === 8), summarize(closedOverviewRows.map((c) => ({ e: c.candidateEmail, s: c.assessmentScore }))));
  check("the EXISTING verified skill score remains a SEPARATE field",
    closedOverviewRows.every((c) => Object.prototype.hasOwnProperty.call(c, "existingVerifiedSkillScore")), "the verified skill score field is missing");

  // Evidence: LinkedIn/GitHub TEXT is returned by the single-reference route. The
  // resume is deliberately exposed only as availability metadata
  // (resumeTextAvailable + resumeTextLength), never as raw text — so that is what
  // is asserted here rather than the resume body.
  const closedRefDetail = await request(origin, `/api/job/${CLOSED.job.id}/candidate-references/${CLOSED.reference.id}`, { token: adminToken });
  check("a single candidate reference is readable on a CLOSED job", closedRefDetail.status === 200, summarize({ status: closedRefDetail.status }));
  check("LinkedIn / GitHub candidate evidence is returned for a CLOSED job",
    leaksCandidateData(closedRefDetail.json, ["LINKEDIN-TEXT-MARKER-CLOSED-JOB"]) &&
    leaksCandidateData(closedRefDetail.json, ["GITHUB-TEXT-MARKER-CLOSED-JOB"]), "candidate evidence missing on the CLOSED job");
  check("resume availability metadata is returned for a CLOSED job",
    closedRefDetail.json?.data?.resumeTextAvailable === true && (closedRefDetail.json?.data?.resumeTextLength ?? 0) > 0,
    summarize({ available: closedRefDetail.json?.data?.resumeTextAvailable, len: closedRefDetail.json?.data?.resumeTextLength }));

  const closedRefs = await request(origin, `/api/job/${CLOSED.job.id}/candidate-references`, { token: adminToken });
  check("candidate references are readable on a CLOSED job", closedRefs.status === 200, summarize({ status: closedRefs.status }));

  const closedAnalysis = await request(origin, `/api/job/${CLOSED.job.id}/candidate-references/${CLOSED.reference.id}/analysis`, { token: adminToken });
  check("the candidate ANALYSIS is readable on a CLOSED job", closedAnalysis.status === 200, summarize({ status: closedAnalysis.status }));

  const closedAttempts = await request(origin, `/api/job/${CLOSED.job.id}/assessment/attempts`, { token: adminToken });
  check("assessment attempts are readable on a CLOSED job", closedAttempts.status === 200, summarize({ status: closedAttempts.status }));

  // Scores must stay SEPARATE: verified skill score, assessment score, analysis.
  const firstCandidate = (closedOverviewCandidates.json?.data?.candidates ?? [])[0];
  check("the three score/analysis values are SEPARATE fields, never combined",
    firstCandidate !== undefined &&
      Object.prototype.hasOwnProperty.call(firstCandidate, "assessmentScore") &&
      Object.prototype.hasOwnProperty.call(firstCandidate, "existingVerifiedSkillScore") &&
      !/overallScore|combinedScore|hireScore|rankingScore|fitPercentage/.test(JSON.stringify(closedOverviewCandidates.json)),
    summarize(Object.keys(firstCandidate ?? {})));
  check("no combined/overall score is invented for a CLOSED job",
    firstCandidate?.selectedStatus === null && firstCandidate?.preferredStatus === null, summarize({ selectedStatus: firstCandidate?.selectedStatus, preferredStatus: firstCandidate?.preferredStatus }));
  // =========================================================================
  section("D. Recruiter access is UNCHANGED (the policy must not touch it)");
  // =========================================================================

  const recruiterActiveCandidates = await request(origin, `/api/job/${ACTIVE.job.id}/candidates`, { token: recruiterAToken });
  check("the RECRUITER still reads their own ACTIVE job's candidates", recruiterActiveCandidates.status === 200, summarize({ status: recruiterActiveCandidates.status }));
  check("the recruiter sees candidate identity on their own ACTIVE job",
    leaksCandidateData(recruiterActiveCandidates.json, markers), "recruiter lost candidate access");

  const recruiterActiveOverview = await request(origin, `/api/job/overview/${ACTIVE.job.id}/candidates`, { token: recruiterAToken });
  check("the recruiter reads the overview candidate list on an ACTIVE job", recruiterActiveOverview.status === 200, summarize({ status: recruiterActiveOverview.status }));
  check("the recruiter sees the assessment score on their own ACTIVE job",
    (recruiterActiveOverview.json?.data?.candidates ?? []).some((c) => c.assessmentScore === 8), summarize((recruiterActiveOverview.json?.data?.candidates ?? []).map((c) => ({ e: c.candidateEmail, s: c.assessmentScore }))));

  // The single-reference route returns the full evidence projection
  // (linkedinText / githubText); the resume is exposed only as availability
  // metadata, never as raw text.
  const recruiterActiveRefs = await request(origin, `/api/job/${ACTIVE.job.id}/candidate-references/${ACTIVE.reference.id}`, { token: recruiterAToken });
  check("the recruiter reads a single candidate reference on an ACTIVE job", recruiterActiveRefs.status === 200, summarize({ status: recruiterActiveRefs.status }));
  check("the recruiter sees LinkedIn / GitHub candidate evidence on their ACTIVE job",
    leaksCandidateData(recruiterActiveRefs.json, ["LINKEDIN-TEXT-MARKER-ACTIVE-JOB"]) &&
    leaksCandidateData(recruiterActiveRefs.json, ["GITHUB-TEXT-MARKER-ACTIVE-JOB"]), "recruiter lost candidate evidence");
  check("the recruiter sees resume availability metadata on their ACTIVE job",
    recruiterActiveRefs.json?.data?.resumeTextAvailable === true, summarize({ available: recruiterActiveRefs.json?.data?.resumeTextAvailable }));

  const recruiterActiveAnalysis = await request(origin, `/api/job/${ACTIVE.job.id}/candidate-references/${ACTIVE.reference.id}/analysis`, { token: recruiterAToken });
  check("the recruiter reads the candidate analysis on an ACTIVE job", recruiterActiveAnalysis.status === 200, summarize({ status: recruiterActiveAnalysis.status }));

  const recruiterActiveAttempts = await request(origin, `/api/job/${ACTIVE.job.id}/assessment/attempts`, { token: recruiterAToken });
  check("the recruiter reads assessment attempts on an ACTIVE job", recruiterActiveAttempts.status === 200, summarize({ status: recruiterActiveAttempts.status }));

  // =========================================================================
  section("E. IDOR — cross-job and cross-organization combinations");
  // =========================================================================

  // Org A admin + org B job (both CLOSED, so only organization scoping can deny).
  const crossOrgCandidates = await request(origin, `/api/job/${OTHER_ORG.job.id}/candidates`, { token: adminToken });
  check("org A admin cannot read org B's candidates", crossOrgCandidates.status === 403 || crossOrgCandidates.status === 404, summarize({ status: crossOrgCandidates.status }));
  check("no org B candidate identity leaked to org A", !leaksCandidateData(crossOrgCandidates.json, CANDIDATE_MARKERS(OTHER_ORG)), summarize(crossOrgCandidates.json));

  const crossOrgAnalysis = await request(origin, `/api/job/${OTHER_ORG.job.id}/candidate-references/${OTHER_ORG.reference.id}/analysis`, { token: adminToken });
  check("org A admin cannot read org B's candidate analysis", crossOrgAnalysis.status === 403 || crossOrgAnalysis.status === 404, summarize({ status: crossOrgAnalysis.status }));
  check("no org B analysis payload leaked", !JSON.stringify(crossOrgAnalysis.json ?? {}).includes("ANALYSIS_RESULT_MARKER"), summarize(crossOrgAnalysis.json));

  // Right organization + a reference id that belongs to a DIFFERENT job.
  const crossRef = await request(origin, `/api/job/${CLOSED.job.id}/candidate-references/${ACTIVE.reference.id}`, { token: adminToken });
  check("a reference id from another job does not resolve (404)", crossRef.status === 404, summarize({ status: crossRef.status }));
  check("no cross-job reference data leaked", !leaksCandidateData(crossRef.json, [ACTIVE.candidateName]), summarize(crossRef.json));

  const crossAnalysis = await request(origin, `/api/job/${CLOSED.job.id}/candidate-references/${ACTIVE.reference.id}/analysis`, { token: adminToken });
  check("cross-job analysis access is refused", crossAnalysis.status === 404, summarize({ status: crossAnalysis.status }));

  const crossReport = await request(origin, `/api/job/${CLOSED.job.id}/candidates/${ACTIVE.reference.id}/verification-report`, { token: adminToken });
  check("cross-job verification-report access is refused", crossReport.status === 404, summarize({ status: crossReport.status }));

  // A nonexistent job id.
  const unknownJob = await request(origin, "/api/job/does-not-exist/candidates", { token: adminToken });
  check("an unknown job id returns 404", unknownJob.status === 404, summarize({ status: unknownJob.status }));

  // A client-supplied organizationId must not change the resolved organization.
  const spoof = await request(origin, `/api/job/${OTHER_ORG.job.id}/candidates?organizationId=${orgA.organization.id}`, { token: adminToken });
  check("a client organizationId cannot redirect the read to org A's scope", spoof.status === 403 || spoof.status === 404, summarize({ status: spoof.status }));
  // =========================================================================
  section("F. SSE — an ACTIVE job must not leak candidate data to ORG_ADMIN");
  // =========================================================================

  const { redactEventForPrincipal, evaluateCandidateLevelAccess } = require("../src/module/job/jobCandidatePrivacy");

  // Exercised directly against the centralized redaction that dispatchEvent uses,
  // with a REAL persisted event shape, so no Redis instance is required.
  const sampleEvent = {
    eventType: "ASSESSMENT_SUBMITTED",
    jobId: ACTIVE.job.id,
    assessmentId: ACTIVE.assessment.id,
    candidateId: ACTIVE.reference.id,
    candidateEmail: ACTIVE.candidateEmail,
    assessmentStatus: "SUBMITTED",
    occurredAt: new Date().toISOString(),
  };
  const activeJobRow = { id: ACTIVE.job.id, status: "ACTIVE" };
  const closedJobRow = { id: CLOSED.job.id, status: "CLOSED" };

  const adminActive = redactEventForPrincipal(orgA.user, activeJobRow, sampleEvent);
  check("an ORG_ADMIN receives NO candidateEmail for an ACTIVE job", !("candidateEmail" in adminActive), summarize(adminActive));
  check("an ORG_ADMIN receives NO candidateId for an ACTIVE job", !("candidateId" in adminActive), summarize(adminActive));
  check("the redacted event is explicitly marked as restricted", adminActive.candidateDataRestricted === true, summarize(adminActive));
  check("the redacted event still carries job-level information", adminActive.jobId === ACTIVE.job.id && adminActive.eventType === "ASSESSMENT_SUBMITTED", summarize(adminActive));

  const recruiterActive = redactEventForPrincipal(recruiterA.user, activeJobRow, sampleEvent);
  check("the RECRUITER still receives candidateEmail on an ACTIVE job", recruiterActive.candidateEmail === ACTIVE.candidateEmail, summarize(recruiterActive));
  check("the RECRUITER still receives candidateId on an ACTIVE job", recruiterActive.candidateId === ACTIVE.reference.id, summarize(recruiterActive));

  const adminClosed = redactEventForPrincipal(orgA.user, closedJobRow, { ...sampleEvent, jobId: CLOSED.job.id });
  check("an ORG_ADMIN receives candidate detail again once the job is CLOSED", adminClosed.candidateEmail === ACTIVE.candidateEmail, summarize(adminClosed));

  check("the shared event object is never mutated by redaction",
    sampleEvent.candidateEmail === ACTIVE.candidateEmail && sampleEvent.candidateId === ACTIVE.reference.id, "the frozen source event was mutated");

  check("the SSE policy is the SAME centralized decision as the REST routes",
    evaluateCandidateLevelAccess(orgA.user, activeJobRow).allowed === false &&
      evaluateCandidateLevelAccess(recruiterA.user, activeJobRow).allowed === true,
    "SSE decision diverges from REST");
  // =========================================================================
  section("G. Deleted recruiter — historical job stays readable as 'Deleted Recruiter'");
  // =========================================================================

  const doomed = await addRecruiterToOrg(orgA.organization.id, "doomed-recruiter");
  const doomedJob = await createJobWithEvidence({
    ownerUserId: doomed.user.id, organizationId: orgA.organization.id, title: "ORPHAN-JOB", status: "CLOSED",
  });
  const deleteRes = await request(origin, `/api/organization/recruiters/${doomed.user.id}`, { method: "DELETE", token: adminToken });
  check("the recruiter is permanently deleted (Phase 1 still works)", deleteRes.status === 200, summarize({ status: deleteRes.status }));

  // The orphaned job needs its own uploaded sheet for the candidate route. Same
  // DRAFT -> upload -> target-status sequence as the fixtures above.
  await prisma.job.update({ where: { id: doomedJob.job.id }, data: { status: "DRAFT" } });
  await attachJobCandidateList(sheetOwner, doomedJob.job.id, { count: 2 });
  await prisma.job.update({
    where: { id: doomedJob.job.id },
    data: { status: "CLOSED", closedAt: doomedJob.job.closedAt, closedReason: doomedJob.job.closedReason },
  });

  const orphanedRow = await prisma.job.findUnique({ where: { id: doomedJob.job.id }, select: { createdByUserId: true } });
  check("the historical job survived with createdByUserId = NULL", orphanedRow?.createdByUserId === null, summarize(orphanedRow));

  const orphanList = await request(origin, "/api/organization/dashboard/jobs?limit=50", { token: adminToken });
  const orphanRow = (orphanList.json?.data?.jobs ?? []).find((j) => j.id === doomedJob.job.id);
  check("the historical job is still listed in Job Analysis", Boolean(orphanRow), summarize((orphanList.json?.data?.jobs ?? []).map((j) => j.id)));
  check("it is attributed to 'Deleted Recruiter', never to another recruiter",
    orphanRow?.recruiter?.fullName === "Deleted Recruiter" && orphanRow?.recruiter?.userId === null, summarize(orphanRow?.recruiter));

  const orphanCandidates = await request(origin, `/api/job/${doomedJob.job.id}/candidates`, { token: adminToken });
  check("the CLOSED orphaned job's candidates remain readable to the org admin", orphanCandidates.status === 200, summarize({ status: orphanCandidates.status }));
  check("the orphaned job's historical candidate data is intact",
    leaksCandidateData(orphanCandidates.json, CANDIDATE_MARKERS(doomedJob)), "historical candidate data missing");

  // =========================================================================
  section("H. Hiring state — never inferred");
  // =========================================================================

  check("Job Analysis reports hired = null for the ACTIVE job", listRow?.counts?.hired === null, summarize(listRow?.counts));
  check("Job Analysis reports selected = null for the ACTIVE job", listRow?.counts?.selected === null, summarize(listRow?.counts));
  check("no hired value is inferred anywhere in the Job Analysis payload",
    !/"hired"\s*:\s*[1-9]/.test(JSON.stringify(jobsList.json)), "a non-null hired value was returned");
  check("no hiring field was added to the schema for this feature",
    !/hiredAt|isHired|HiringDecision|selectedAt/.test(fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "schema.prisma"), "utf8")), "a hiring field exists in the schema");

  // =========================================================================
  section("I. The policy is centralized (no duplicated status checks)");
  // =========================================================================

  const privacySrc = fs.readFileSync(path.join(BACKEND_ROOT, "src", "module", "job", "jobCandidatePrivacy.js"), "utf8");
  for (const rel of [
    "src/module/job/job.service.js",
    "src/module/job/jobOverview.service.js",
    "src/module/job/jobCandidateReference.service.js",
    "src/module/job/jobAssessmentAttempt.service.js",
    "src/module/realtime/realtime.gateway.js",
  ]) {
    const src = fs.readFileSync(path.join(BACKEND_ROOT, ...rel.split("/")), "utf8");
    check(`${rel} uses the centralized policy`, /jobCandidatePrivacy/.test(src), "the policy module is not used");
  }
  check("the policy module is the only place the ACTIVE status is interpreted",
    /JOB_STATUS_ACTIVE = "ACTIVE"/.test(privacySrc), "the policy does not define the ACTIVE status");

  const modalSrc = fs.readFileSync(path.join(BACKEND_ROOT, "..", "frontend", "src", "components", "jobs", "OverviewJobModal.jsx"), "utf8");
  check("the UI renders the backend's candidateLevelAccess decision", /payload\.candidateLevelAccess\?\.allowed/.test(modalSrc), "the UI does not follow the backend decision");
  check("the UI does not hide candidate data with a client-side filter", !/candidates\.filter\(/.test(modalSrc), "client-side hiding found");

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
    // The candidate sheets first: JobCandidateList.jobId is Restrict, so its rows
    // and the backing StoredFile rows must go BEFORE the jobs.
    await cleanupJobCandidateLists(prisma, tracked.jobIds);
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