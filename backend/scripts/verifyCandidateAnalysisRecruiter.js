/* eslint-disable no-console */
// Phase 7 Step 5 focused verifier: recruiter candidate-analysis READ/API contract
// (authorization, version-aware retrieval, sanitized results, private resume access)
// and the existing recruiter candidate UI contract. Analysis is no longer
// recruiter-initiated: the SYSTEM starts it from the authoritative terminal
// assessment lifecycle, so this gate also asserts that boundary — the analyze route,
// its controller handler, its validation schema, the service function, and any
// frontend trigger must all be absent. FastAPI/worker execution is covered
// separately by verify:candidate-analysis-pipeline.
require("dotenv").config();

const http = require("node:http");
const path = require("node:path");
const XLSX = require("xlsx");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
process.env.AI_QUEUE_PREFIX = `candidate-recruiter-${SUFFIX}`;

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const referenceService = require("../src/module/job/jobCandidateReference.service");
const aiJobRepository = require("../src/module/ai-job/aiJob.repository");
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const generateAccessToken = require("../src/utils/generateAccessToken");
const {
  removeStoredFileContent,
  removeEmptyStoredFileDirectory,
} = require("../src/module/storage/storage.service");
const {
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "frontend");
const results = [];
const tracked = {
  userIds: [], planIds: [], subscriptionIds: [], organizationIds: [], jobIds: [],
};
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
const candidateEmail = (label) => `step5-${label}-${SUFFIX}@example.test`;

const startHttpServer = () => new Promise((resolve, reject) => {
  const app = require("../src/app");
  const server = http.createServer(app);
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve({
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
  }));
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
    fullName: `Step 5 ${label}`, email: `step5-${label}-${SUFFIX}@example.test`,
    provider: "LOCAL", emailVerified: true, status: "ACTIVE",
  }});
  const role = await prisma.role.upsert({ where: { name: "RECRUITER" }, update: {},
    create: { name: "RECRUITER", description: "Recruiter role" } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const plan = await prisma.subscriptionPlan.create({ data: {
    name: `Step 5 Plan ${label} ${SUFFIX}`, type: "RECRUITER", price: 0,
    billingCycle: "MONTHLY", jobPostingLimit: 20,
  }});
  const subscription = await prisma.subscription.create({ data: {
    planId: plan.id, userId: user.id, status: "ACTIVE", startDate: new Date(),
    expiryDate: new Date(Date.now() + 30 * DAY_IN_MS),
  }});
  tracked.userIds.push(user.id); tracked.planIds.push(plan.id); tracked.subscriptionIds.push(subscription.id);
  return { user: { id: user.id, role: "RECRUITER" }, subscription };
};

const createOrganizationFixture = async (label, role = "RECRUITER") => {
  const owner = await createRecruiter(`org-${label}-${role.toLowerCase()}`);
  const organization = await prisma.organization.create({ data: {
    name: `Step 5 ${label} ${SUFFIX}`, ownerId: owner.user.id, status: "ACTIVE",
  }});
  await prisma.organizationMembership.create({ data: {
    userId: owner.user.id, organizationId: organization.id, role, status: "ACTIVE",
  }});
  if (role === "ORG_ADMIN") {
    const adminRole = await prisma.role.upsert({ where: { name: "ORG_ADMIN" }, update: {},
      create: { name: "ORG_ADMIN", description: "Organization administrator role" } });
    await prisma.userRole.create({ data: { userId: owner.user.id, roleId: adminRole.id } });
  }
  await prisma.subscription.update({ where: { id: owner.subscription.id }, data: { userId: null, organizationId: organization.id } });
  tracked.organizationIds.push(organization.id);
  return { ...owner, user: { ...owner.user, organizationId: organization.id }, organization };
};

const addOrganizationMember = async (organizationId, label, role) => {
  const user = await prisma.user.create({ data: {
    fullName: `Step 5 ${label}`, email: `step5-${label}-${SUFFIX}@example.test`,
    provider: "LOCAL", emailVerified: true, status: "ACTIVE",
  }});
  const roleRow = await prisma.role.upsert({ where: { name: role }, update: {},
    create: { name: role, description: `${role} role` } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
  await prisma.organizationMembership.create({ data: {
    userId: user.id, organizationId, role, status: "ACTIVE",
  }});
  tracked.userIds.push(user.id);
  return { user: { id: user.id, role, organizationId } };
};

const buildWorkbook = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Email", "LinkedIn", "GitHub", "Preferred Role", "Skills", "Skill Notes"],
    ...rows,
  ]);
  return XLSX.write({ SheetNames: ["Candidates"], Sheets: { Candidates: sheet } }, { type: "buffer", bookType: "xlsx" });
};

const JOB_PAYLOAD = {
  title: "Step 5 Backend Engineer",
  yearsExperience: 5,
  description: "Build reliable backend services with Node.js and PostgreSQL for recruiter candidates.",
  analysisDays: 3,
  skills: [{ name: "Node.js", weight: 60 }, { name: "PostgreSQL", weight: 40 }],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe one production reliability decision you owned." }],
};

const createJob = async (owner, rows, { start = true, title = "Step 5 Job" } = {}) => {
  const draft = await jobService.createDraft(owner.user, { ...JOB_PAYLOAD, title: `${title} ${SUFFIX}` });
  tracked.jobIds.push(draft.id);
  const buffer = buildWorkbook(rows);
  await jobService.uploadCandidateList(owner.user, draft.id, {
    originalname: `step5-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
  const references = await referenceService.listCandidateReferences(owner.user, draft.id);
  let startAiJobId = null;
  if (start) ({ aiJob: { id: startAiJobId } } = await jobService.startJob(owner.user, draft.id));
  return { jobId: draft.id, references, startAiJobId };
};

const getReference = (context, email) => context.references.find((row) => row.candidateEmail === email);
const analysisPath = (jobId, referenceId, suffix = "analysis") =>
  `/api/job/${jobId}/candidate-references/${referenceId}/${suffix}`;

const RESULT = {
  jobFitSummary: "Evidence indicates relevant backend experience.",
  assessmentPerformance: {
    status: "SUBMITTED", score: 8, maxScore: 10, scorePercentage: 80,
    summary: "The assessment evidence is reported separately from qualitative fit.",
    strengths: ["Clear production reasoning"], gaps: [], unanswered: 0,
  },
  skillAlignment: [
    { skill: "Node.js", status: "SUPPORTED", rationale: "Assessment evidence supports this skill.", evidence: ["Explained a reliability decision"] },
    { skill: "PostgreSQL", status: "NOT_EVIDENCED", rationale: "No supplied evidence demonstrates PostgreSQL.", evidence: [] },
  ],
  resumeEvidence: { status: "AVAILABLE", summary: "Resume evidence was supplied.", details: ["Backend experience"] },
  linkedinEvidence: { status: "UNAVAILABLE", summary: "A reference exists without analyzed text.", details: [] },
  githubEvidence: { status: "NOT_PROVIDED", summary: "No GitHub evidence was supplied.", details: [] },
  preferredRoleAlignment: { status: "SUPPORTED", summary: "Preferred role aligns with the job.", rationale: "Based on supplied role evidence." },
  strengths: ["Relevant backend experience"],
  skillGaps: ["No supplied PostgreSQL evidence"],
  missingRequirements: ["Docker evidence was not supplied"],
  conflicts: [],
  concerns: [],
  finalRecruiterReview: "Review the supplied evidence and make the hiring decision.",
};

const materializeCompleted = async (aiJobId, result = RESULT) => {
  const claimed = await aiJobRepository.claimAiJobForProcessing({ aiJobId, workerId: `step5-${SUFFIX}` });
  await aiJobRepository.completeCandidateAnalysis({
    aiJobId, workerId: claimed.workerId, attempts: claimed.attempts,
    analysis: result, provider: "gemini", model: "step5-deterministic",
  });
};

const materializeFailed = async (aiJobId, code = "AI_PROVIDER_UNAVAILABLE") => {
  const claimed = await aiJobRepository.claimAiJobForProcessing({ aiJobId, workerId: `step5-${SUFFIX}` });
  await aiJobRepository.markAiJobFailed({
    aiJobId, workerId: claimed.workerId, attempts: claimed.attempts, lastError: code,
  });
};


// --- Terminal assessment lifecycle fixtures ------------------------------------
// A job owns exactly one assessment (JobAssessment.jobId is unique) and one attempt
// per candidate (@@unique([assessmentId, email])), so the assessment and its question
// are created once per job and reused by every candidate analysed under it.
const ensureAssessment = async (jobId) => {
  const existing = await prisma.jobAssessment.findUnique({ where: { jobId } });
  if (existing) return existing;
  const assessment = await prisma.jobAssessment.create({
    data: {
      jobId,
      title: "Step 5 recruiter assessment",
      description: "Authoritative assessment evidence.",
      status: "FINALIZED",
      publicId: `step5-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
      durationSeconds: 600,
    },
  });
  await prisma.jobAssessmentQuestion.create({
    data: {
      assessmentId: assessment.id,
      section: "REQUIRED_SKILLS",
      sortOrder: 0,
      prompt: "Explain how you would migrate a production PostgreSQL schema safely.",
      questionType: "SHORT_ANSWER",
      points: 10,
    },
  });
  return assessment;
};

// Commits an attempt the way the assessment lifecycle commits it: a terminal status
// with its authoritative score (SUBMITTED) or without one (TIMED_UP / CHEATED).
// This committed row is the ONLY input the automatic analysis trigger ever receives.
const createAttempt = async ({ jobId, email, status = "SUBMITTED", assessmentId, answerText }) => {
  const assessment = await (assessmentId
    ? Promise.resolve({ id: assessmentId })
    : ensureAssessment(jobId));
  const invitation = await prisma.jobAssessmentInvitation.create({
    data: {
      jobId,
      assessmentId: assessment.id,
      email,
      expiresAt: new Date(Date.now() + DAY_IN_MS),
      status: "EMAIL_VERIFIED",
      emailVerifiedAt: new Date(),
    },
  });
  const now = new Date();
  const attempt = await prisma.jobAssessmentAttempt.create({
    data: {
      jobId,
      assessmentId: assessment.id,
      invitationId: invitation.id,
      email,
      status,
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      deadlineAt: new Date(Date.now() + DAY_IN_MS),
      submittedAt: status === "SUBMITTED" ? now : null,
      timedOutAt: status === "TIMED_UP" ? now : null,
      cheatedAt: status === "CHEATED" ? now : null,
      ...(status === "SUBMITTED" ? { score: 8, maxScore: 10, scorePercentage: 80 } : {}),
    },
  });
  const question = await prisma.jobAssessmentQuestion.findFirst({ where: { assessmentId: assessment.id } });
  if (question) {
    await prisma.jobAssessmentAttemptAnswer.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        answer: { text: answerText ?? `Authoritative answer for ${email}.` },
      },
    });
  }
  return attempt;
};

// The one and only entry point that may start candidate analysis: the SYSTEM funnel
// the assessment lifecycle invokes once it has COMMITTED a terminal attempt.
const runAutomaticAnalysis = async (attempt) =>
  referenceService.runAutomaticCandidateAnalysis({
    id: attempt.id,
    jobId: attempt.jobId,
    assessmentId: attempt.assessmentId,
    email: attempt.email,
    status: attempt.status,
  });

const scenarioAutomaticTriggerAndStatus = async ({ origin, owner, other, job, otherJob, otherReference, draftJob, draftEmail, emailA, emailB }) => {
  section("A. The removed recruiter trigger, the automatic terminal-attempt trigger, and status retrieval");
  const token = tokenFor(owner.user);
  const otherToken = tokenFor(other.user);
  const reference = job.references[0];
  const trigger = analysisPath(job.jobId, reference.id, "analyze");
  const status = analysisPath(job.jobId, reference.id);

  // The recruiter-initiated trigger is gone: the route itself no longer exists for
  // anyone, so there is no authorization surface, no request body, and no 202 to await.
  const anonymousTrigger = await request(origin, trigger, { method: "POST", body: {} });
  check("the removed analyze route is never reachable: an anonymous request is rejected by the auth layer first", anonymousTrigger.status === 401, summarize(anonymousTrigger.json));
  const recruiterTrigger = await request(origin, trigger, { method: "POST", token, body: {} });
  check("an authenticated recruiter cannot start candidate analysis over HTTP", recruiterTrigger.status === 404, summarize(recruiterTrigger.json));
  const otherTrigger = await request(origin, trigger, { method: "POST", token: otherToken, body: {} });
  check("no analyze route exists for a recruiter without access to the job either", otherTrigger.status === 404, summarize(otherTrigger.json));
  const forgedTrigger = await request(origin, trigger, { method: "POST", token, body: { email: candidateEmail("forged"), organizationId: "forged" } });
  check("no analyze route accepts a body, so candidate identity is never client-supplied", forgedTrigger.status === 404, summarize(forgedTrigger.json));

  // Reading is unchanged: same authentication, authorization, and empty-state contract.
  const unauthenticatedRead = await request(origin, status);
  check("reading candidate analysis still requires authentication", unauthenticatedRead.status === 401, summarize(unauthenticatedRead.json));
  const initial = await request(origin, status, { token });
  check("GET returns an explicit no-analysis state before the assessment is terminal", initial.status === 200 && initial.json?.data?.latest === null, summarize(initial.json));
  const invalidVersion = await request(origin, `${status}?version=abc`, { token });
  check("invalid selected version returns 422", invalidVersion.status === 422, summarize(invalidVersion.json));

  // The SYSTEM trigger: a committed terminal attempt is the only way analysis starts.
  const premature = await createAttempt({ jobId: job.jobId, email: candidateEmail("in-progress"), status: "IN_PROGRESS" });
  const prematureResult = await runAutomaticAnalysis(premature);
  check("a non-terminal attempt never starts an analysis", prematureResult.triggered === false && prematureResult.reason === "NOT_TERMINAL" && (await prisma.jobCandidateAnalysis.count({ where: { jobId: job.jobId } })) === 0, summarize(prematureResult));

  const draftAttempt = await createAttempt({ jobId: draftJob.jobId, email: draftEmail });
  const draftResult = await runAutomaticAnalysis(draftAttempt);
  check("a non-ACTIVE job never starts an analysis: the Step 4 lifecycle gate now lives inside the trigger", draftResult.triggered === false && draftResult.reason === "JOB_NOT_ACTIVE" && (await prisma.jobCandidateAnalysis.count({ where: { jobId: draftJob.jobId } })) === 0, summarize(draftResult));

  const staleAssessment = await ensureAssessment(otherJob.jobId);
  const staleAttempt = await createAttempt({ jobId: job.jobId, email: candidateEmail("stale"), assessmentId: staleAssessment.id });
  const staleResult = await runAutomaticAnalysis(staleAttempt);
  check("an attempt that does not belong to the job's current assessment is skipped", staleResult.triggered === false && staleResult.reason === "JOB_ASSESSMENT_CHANGED", summarize(staleResult));

  const attempt = await createAttempt({ jobId: job.jobId, email: emailA, answerText: "Additive migrations, verified reads, then the old column." });
  const created = await runAutomaticAnalysis(attempt);
  check("a committed terminal attempt starts exactly one PENDING analysis with authoritative tracking fields", created.triggered === true && created.aiJob?.operation === "CANDIDATE_ANALYSIS" && created.aiJob?.status === "PENDING" && created.analysis?.analysisVersion === 1 && Boolean(created.analysis?.id), summarize(created));
  const firstAiJobId = created.aiJob.id;
  const queued = await aiJobQueue.findQueuedAiJob(firstAiJobId);
  check("the automatic trigger commits first and enqueues the existing BullMQ AiJob id", Boolean(queued) && queued.data.aiJobId === firstAiJobId, summarize({ firstAiJobId, queued: queued?.data }));
  const committed = await prisma.aiJob.findUnique({ where: { id: firstAiJobId } });
  check("the automatic trigger persists the existing CANDIDATE_ANALYSIS AiJob operation", committed?.operation === "CANDIDATE_ANALYSIS" && committed.status === "PENDING", summarize({ operation: committed?.operation, status: committed?.status }));

  // Idempotency: the automatic workflow runs exactly once per terminal attempt, and a
  // concurrent duplicate loses the race instead of surfacing an error to its caller.
  const replay = await runAutomaticAnalysis(attempt);
  check("a repeated terminal lifecycle event re-analyses nothing", replay.triggered === false && replay.reason === "ALREADY_ANALYZED" && (await prisma.jobCandidateAnalysis.count({ where: { jobId: job.jobId, referenceId: reference.id } })) === 1, summarize(replay));

  const freshAttempt = await createAttempt({ jobId: job.jobId, email: emailB });
  const freshParallel = await Promise.all([runAutomaticAnalysis(freshAttempt), runAutomaticAnalysis(freshAttempt)]);
  check("simultaneous lifecycle events for one attempt create exactly one analysis and never surface the losing 409", freshParallel.filter((entry) => entry.triggered).length === 1 && freshParallel.filter((entry) => !entry.triggered).every((entry) => entry.reason === "ALREADY_ANALYZED") && (await prisma.jobCandidateAnalysis.count({ where: { jobId: job.jobId, referenceId: job.references[1].id } })) === 1, summarize(freshParallel.map((entry) => entry.reason ?? "TRIGGERED")));

  const orphanAttempt = await createAttempt({ jobId: job.jobId, email: candidateEmail("no-reference") });
  const orphan = await runAutomaticAnalysis(orphanAttempt);
  check("an attempt without a matching candidate reference is skipped without creating an analysis", orphan.triggered === false && orphan.reason === "NO_CANDIDATE_REFERENCE" && (await prisma.jobCandidateAnalysis.count({ where: { jobId: job.jobId } })) === 2, summarize(orphan));

  const crossJob = await request(origin, analysisPath(job.jobId, otherReference.id, "analyze"), { method: "POST", token, body: {} });
  check("another job's reference is not analyzable through this job's URL", crossJob.status === 404, summarize(crossJob.json));
  const crossRead = await request(origin, status, { token: otherToken });
  check("a recruiter from another job cannot read this analysis", crossRead.status === 403, summarize(crossRead.json));
  const crossJobRead = await request(origin, analysisPath(job.jobId, otherReference.id), { token });
  check("another job's reference cannot be read through this job's analysis URL either", crossJobRead.status === 404, summarize(crossJobRead.json));
  return { token, firstAiJobId, attempt, secondAiJobId: freshParallel.find((entry) => entry.triggered).aiJob.id, freshAttempt };
};


const scenarioResultsVersions = async ({ origin, token, job, reference, firstAiJobId, attempt, secondAiJobId, freshAttempt }) => {
  section("B. Completed result sanitizer, one automatic analysis per terminal attempt, and safe failure reporting");
  const status = analysisPath(job.jobId, reference.id);
  await materializeCompleted(firstAiJobId);
  const completed = await request(origin, status, { token });
  const data = completed.json?.data;
  const candidateList = await request(origin, `/api/job/${job.jobId}/candidates`, { token });
  const listedCandidate = candidateList.json?.data?.candidates?.find((entry) => entry.referenceId === reference.id);
  check("candidate list reconstructs the server-authoritative COMPLETED status after refresh", listedCandidate?.analysis?.status === "COMPLETED" && listedCandidate?.analysis?.analysisVersion === 1, summarize(listedCandidate));
  const keys = collectKeys(data);
  check("completed analysis is returned from the persisted JobCandidateAnalysis", completed.status === 200 && data?.latest?.status === "COMPLETED" && data?.selected?.analysisVersion === 1, summarize(completed.json));
  check("result DTO excludes raw email, request payload, snapshot hash, storage path, answer keys, and integrity metadata", ["candidateEmail", "email", "requestPayload", "snapshotHash", "storagePath", "correctAnswer", "answerKey", "integrityEvents", "verificationTokenHash"].every((key) => !keys.has(key)), summarize([...keys].filter((key) => /email|payload|snapshot|storage|answer|integrity|token/i.test(key))));
  check("result DTO has no overall/combined/ranking/hiring-decision score", !/overallScore|combinedScore|candidateScore|fitPercentage|weightedOverallScore|rankingScore|hiringDecision/i.test(JSON.stringify(data)), summarize(data));
  check("required qualitative sections are present", data?.selected?.result && ["jobFitSummary", "assessmentPerformance", "skillAlignment", "resumeEvidence", "linkedinEvidence", "githubEvidence", "preferredRoleAlignment", "strengths", "skillGaps", "missingRequirements", "conflicts", "concerns", "finalRecruiterReview"].every((key) => key in data.selected.result), summarize(Object.keys(data?.selected?.result ?? {})));
  check("assessment score remains a separate factual field", data.selected.result.assessmentPerformance.score === 8 && data.selected.result.assessmentPerformance.maxScore === 10 && data.selected.result.assessmentPerformance.scorePercentage === 80, summarize(data.selected.result.assessmentPerformance));
  check("provider/model are safe completed metadata", data.selected.provider === "gemini" && data.selected.model === "step5-deterministic", summarize({ provider: data.selected.provider, model: data.selected.model }));

  // There is no second version to ask for any more: the analysis belongs to the terminal
  // attempt, so the only "run again" that exists is the automatic workflow declining to
  // re-run for an attempt it has already analyzed.
  const beforeSecond = structuredClone(await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: firstAiJobId } }));
  const retrigger = await request(origin, analysisPath(job.jobId, reference.id, "analyze"), { method: "POST", token, body: {} });
  check("no HTTP request can ask for another analysis version", retrigger.status === 404, summarize(retrigger.json));
  const stored = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: firstAiJobId } });
  check("the automatic analysis for one terminal attempt stays exactly one row at version 1", (await prisma.jobCandidateAnalysis.count({ where: { jobId: job.jobId, referenceId: reference.id } })) === 1 && stored.analysisVersion === 1, summarize({ analysisVersion: stored.analysisVersion }));
  const replayed = await runAutomaticAnalysis(attempt);
  check("a terminal attempt is never re-analyzed after completion either", replayed.triggered === false && replayed.reason === "ALREADY_ANALYZED", summarize(replayed));
  const afterSecond = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: firstAiJobId } });
  check("the completed persisted row is unchanged by the re-trigger attempts", JSON.stringify(beforeSecond.result) === JSON.stringify(afterSecond.result) && beforeSecond.analysisVersion === afterSecond.analysisVersion, summarize({ before: beforeSecond.result, after: afterSecond.result }));
  const v1 = await request(origin, `${status}?version=1`, { token });
  check("explicit version retrieval still returns the stored result", v1.json?.data?.selected?.analysisVersion === 1 && v1.json?.data?.selected?.result?.jobFitSummary === RESULT.jobFitSummary, summarize(v1.json));
  const unknownVersion = await request(origin, `${status}?version=999`, { token });
  check("unknown analysis version returns safe 404", unknownVersion.status === 404, summarize(unknownVersion.json));

  // A failed automatic analysis is still surfaced safely, and still offers no retry route.
  const failedReference = job.references[1];
  await materializeFailed(secondAiJobId);
  const failed = await request(origin, analysisPath(job.jobId, failedReference.id), { token });
  check("a failed automatic analysis is reported safely with no result and no completed fallback", failed.json?.data?.latest?.status === "FAILED" && failed.json?.data?.latest?.result === null && failed.json?.data?.latestCompleted === null, summarize(failed.json));
  const failedRetry = await request(origin, analysisPath(job.jobId, failedReference.id, "analyze"), { method: "POST", token, body: {} });
  check("a failed analysis exposes no recruiter retry endpoint", failedRetry.status === 404, summarize(failedRetry.json));
  const failedReplay = await runAutomaticAnalysis(freshAttempt);
  check("a failed terminal attempt is not silently re-analyzed either", failedReplay.triggered === false && failedReplay.reason === "ALREADY_ANALYZED" && (await prisma.jobCandidateAnalysis.count({ where: { referenceId: failedReference.id } })) === 1, summarize(failedReplay));
  return { failedAiJobId: secondAiJobId };
};


const scenarioOrganizationAndResume = async ({ origin, orgA, orgAAdmin, orgBAdmin, jobA, jobAOther, referenceA, missingResumeReference }) => {
  section("C. Organization authorization, safe reference projection, and private resume");
  const adminRead = await request(origin, analysisPath(jobA.jobId, referenceA.id), { token: tokenFor(orgAAdmin.user) });
  check("own-organization ORG_ADMIN can read candidate analysis", adminRead.status === 200, summarize(adminRead.json));
  const adminWrite = await request(origin, analysisPath(jobA.jobId, referenceA.id, "analyze"), { method: "POST", token: tokenFor(orgAAdmin.user), body: {} });
  check("no analysis trigger exists for ORG_ADMIN either, because no trigger exists at all", adminWrite.status === 404, summarize(adminWrite.json));
  const foreign = await request(origin, analysisPath(jobA.jobId, referenceA.id), { token: tokenFor(orgBAdmin.user) });
  check("other-organization ORG_ADMIN cannot read candidate analysis", foreign.status === 403, summarize(foreign.json));
  const foreignWrite = await request(origin, analysisPath(jobA.jobId, referenceA.id, "analyze"), { method: "POST", token: tokenFor(orgBAdmin.user), body: {} });
  check("other-organization ORG_ADMIN finds no analysis trigger either", foreignWrite.status === 404, summarize(foreignWrite.json));

  const projection = await request(origin, `/api/job/${jobA.jobId}/candidate-references?projection=analysis`, { token: tokenFor(orgA.user) });
  const projectionKeys = collectKeys(projection.json?.data);
  check("analysis reference projection contains only opaque identity/job/resume metadata", projection.status === 200 && projection.json.data.every((row) => Object.keys(row).sort().join(",") === "hasResume,jobId,referenceId") && !projectionKeys.has("email"), summarize(projection.json));
  const normalProjection = await request(origin, `/api/job/${jobA.jobId}/candidate-references`, { token: tokenFor(orgA.user) });
  check("the accepted full Step 2 reference projection remains backward compatible", normalProjection.status === 200 && normalProjection.json.data.some((row) => row.candidateEmail), summarize({ status: normalProjection.status, count: normalProjection.json?.data?.length }));

  const resumeBuffer = Buffer.from("Private candidate resume text");
  await referenceService.uploadCandidateResume(orgA.user, jobA.jobId, referenceA.id, {
    originalname: "private-resume.txt", mimetype: "text/plain", size: resumeBuffer.byteLength,
    buffer: resumeBuffer,
  });
  const resume = await request(origin, analysisPath(jobA.jobId, referenceA.id, "resume"), { token: tokenFor(orgA.user) });
  check("authorized recruiter can view the existing private resume", resume.status === 200 && resume.buffer.toString() === "Private candidate resume text" && resume.headers.get("content-disposition")?.startsWith("inline"), summarize({ status: resume.status, type: resume.headers.get("content-type"), disposition: resume.headers.get("content-disposition") }));
  const crossJobResume = await request(origin, analysisPath(jobA.jobId, jobAOther.references[0].id, "resume"), { token: tokenFor(orgA.user) });
  check("same-organization cross-job reference cannot expose the resume", crossJobResume.status === 404, summarize(crossJobResume.json));
  const crossOrgResume = await request(origin, analysisPath(jobA.jobId, referenceA.id, "resume"), { token: tokenFor(orgBAdmin.user) });
  check("cross-organization resume view is denied", crossOrgResume.status === 403, summarize(crossOrgResume.json));
  const missingResume = await request(origin, analysisPath(jobA.jobId, missingResumeReference.id, "resume"), { token: tokenFor(orgA.user) });
  check("resume-less candidate reference returns safe 404", missingResume.status === 404, summarize(missingResume.json));
  const public = await request(origin, "/uploads/recruiters/private-resume.txt", { token: tokenFor(orgA.user) });
  check("no public /uploads resume route exists", public.status === 404, summarize(public.json));
  const noPath = !JSON.stringify(resume.json ?? {}).includes("storagePath") && !JSON.stringify(resume.buffer.toString()).includes("storagePath");
  check("private resume response exposes no storage path", noPath);
};


const jobCandidateReferenceControllerHasDirectInfrastructureCall = (source) =>
  /fetch\s*\(|@google\/genai|GEMINI_API_KEY|getAiServiceConfig|enqueueAiJob|new Queue\s*\(|ioredis|bullmq/i.test(source);

const scenarioStaticScope = () => {
  section("D. Static boundaries — the recruiter surface is read-only and the terminal assessment lifecycle owns analysis");
  const fs = require("node:fs");
  const hook = fs.readFileSync(path.join(FRONTEND_ROOT, "src/hooks/useJobCandidateRealtime.js"), "utf8");
  const panel = fs.readFileSync(path.join(FRONTEND_ROOT, "src/components/jobs/CandidateAnalysisPanel.jsx"), "utf8");
  const list = fs.readFileSync(path.join(FRONTEND_ROOT, "src/components/jobs/CandidateWorkflowList.jsx"), "utf8");
  const detail = fs.readFileSync(path.join(FRONTEND_ROOT, "src/pages/dashboard/RecruiterJobDetail.jsx"), "utf8");
  const service = fs.readFileSync(path.join(FRONTEND_ROOT, "src/services/jobService.js"), "utf8");
  const route = fs.readFileSync(path.join(BACKEND_ROOT, "src/module/job/job.routes.js"), "utf8");
  const controller = fs.readFileSync(path.join(BACKEND_ROOT, "src/module/job/jobCandidateReference.controller.js"), "utf8");
  const validation = fs.readFileSync(path.join(BACKEND_ROOT, "src/module/job/job.validation.js"), "utf8");
  const referenceService = fs.readFileSync(path.join(BACKEND_ROOT, "src/module/job/jobCandidateReference.service.js"), "utf8");
  const attemptService = fs.readFileSync(path.join(BACKEND_ROOT, "src/module/job/jobAssessmentAttempt.service.js"), "utf8");
  const allStep5 = `${hook}\n${panel}\n${list}\n${detail}\n${service}\n${route}\n${controller}`;
  const frontend = `${hook}\n${panel}\n${list}\n${detail}\n${service}`;

  check("no recruiter-initiated analysis call remains anywhere in the frontend", !/requestCandidateAnalysis/.test(frontend) && !/candidate-references\/\$\{[^}]*\}\/analyze["'`)]/.test(frontend));
  check("the panel explains that analysis starts automatically and offers no trigger button", panel.includes("Analysis starts automatically") && panel.includes("no action is needed here") && !/Analyze Candidate|Analyze Again|Retry Analysis/.test(panel));
  check("no analyze route, controller handler, or request schema survives on the backend", !route.includes("/:jobId/candidate-references/:referenceId/analyze") && !/requestCandidateAnalysis|candidateAnalysisRequestSchema/.test(`${controller}\n${validation}`) && !/requestCandidateAnalysis/.test(referenceService));
  check("the reference service exposes exactly one analysis entry point: the automatic one", /runAutomaticCandidateAnalysis/.test(referenceService) && !/assertAiWorkflowAvailable\s*\(/.test(referenceService));
  check("GET uses the dedicated job/reference status endpoint", service.includes("/candidate-references/${referenceId}/analysis") && panel.includes("getCandidateAnalysis(jobId, candidate.referenceId"));
  check("no email is used in Step 5 API URLs or frontend identity logic", !/candidate-references\/\$\{[^}]*email|candidates\/\$\{[^}]*email/i.test(`${service}\n${panel}`));
  check("Step 5 candidate-analysis polling is removed and the existing shared SSE stream owns updates", !/POLL_INTERVAL_MS|POLL_LIMIT_MS|every three seconds/.test(panel) && hook.includes("CANDIDATE_ANALYSIS_UPDATED"));
  check("candidate status updates target the matching job/reference and reconcile through the API", hook.includes("event.jobId !== jobId") && list.includes("getCandidateAnalysis(jobId, event.referenceId)"));
  check("result UI renders every required evidence/alignment/list section", ["Job Fit Summary", "Assessment Performance", "Skill Alignment", "Resume Evidence", "LinkedIn Evidence", "GitHub Evidence", "Preferred Role Alignment", "Strengths", "Skill Gaps", "Missing Requirements", "Conflicts", "Concerns", "Final Recruiter Review"].every((label) => panel.includes(label)));
  check("assessment score is displayed separately and no overall/combined score is created", panel.includes("Assessment score:") && !/overallScore|combinedScore|candidateScore|fitPercentage|weightedOverallScore|rankingScore/i.test(allStep5));
  check("View Resume uses the private authenticated blob endpoint and object URL cleanup", service.includes("getCandidateResumeBlob") && service.includes("responseType: \"blob\"") && panel.includes("URL.revokeObjectURL"));
  check("no localStorage/sessionStorage is introduced for candidate analysis", !/localStorage|sessionStorage/.test(allStep5));
  check("no external LinkedIn/GitHub URL fetching is introduced", !/fetch\s*\(\s*["']https?:\/\/(?:www\.)?(?:linkedin|github)|axios\.(get|post)\s*\(\s*["']https?:\/\/(?:www\.)?(?:linkedin|github)/i.test(allStep5));
  check("no Gemini SDK/key enters Node or frontend Step 5 code", !/@google\/genai|GEMINI_API_KEY|gemini_api_key/i.test(allStep5));
  check("candidate-analysis status uses the existing shared SSE stream without a second connection", /CANDIDATE_ANALYSIS_UPDATED/.test(allStep5) && (allStep5.match(/openCandidateStatusStream\(/g) || []).length === 1);
  check("no bulk analyze route or UI exists", !/analyze-all|bulk-analy|candidate-analysis\/bulk/i.test(allStep5));
  check("the terminal assessment lifecycle is the automatic analysis trigger", attemptService.includes("runAutomaticCandidateAnalysis") && /AUTOMATIC_ANALYSIS_STATUSES = new Set\(\["SUBMITTED", "TIMED_UP", "CHEATED"\]\)/.test(attemptService) && /triggerAutomaticCandidateAnalysis\(/.test(attemptService));
  check("the trigger runs after the attempt is committed and swallows its own errors", /void Promise\.resolve\(\)/.test(attemptService) && /\.catch\(\(error\)/.test(attemptService) && /triggerAutomaticCandidateAnalysis\(attempt, ("SUBMITTED"|[a-zA-Z]+)\)/.test(attemptService));
  check("the automatic trigger enforces the job gate itself instead of a recruiter-facing one", referenceService.includes("JOB_NOT_ACTIVE") && referenceService.includes("ALREADY_ANALYZED") && referenceService.includes("TERMINAL_ATTEMPT_STATUSES"));
  check("no production Express route calls FastAPI, Gemini, Redis, or BullMQ directly", !jobCandidateReferenceControllerHasDirectInfrastructureCall(controller));
  check("active job detail reuses CandidateWorkflowList; draft detail still uses DraftJobForm", detail.includes("analysisEnabled={isActive}") && detail.includes("<DraftJobForm") && detail.includes("<CandidateWorkflowList"));
};


const snapshotTotals = async () => ({
  user: await prisma.user.count(), organization: await prisma.organization.count(),
  job: await prisma.job.count(), aiJob: await prisma.aiJob.count(),
  jobCandidateAnalysis: await prisma.jobCandidateAnalysis.count(),
  storedFile: await prisma.storedFile.count(),
});

const removeQueueJobs = async () => {
  const rows = await prisma.aiJob.findMany({ where: { jobId: { in: tracked.jobIds } }, select: { id: true } });
  for (const row of rows) {
    const delivery = await aiJobQueue.findQueuedAiJob(row.id);
    if (delivery) await delivery.remove();
  }
  return rows.length;
};

const cleanup = async () => {
  const removed = {};
  if (tracked.jobIds.length) {
    const ids = { in: tracked.jobIds };
    // JobCandidateAnalysis -> AiJob is RESTRICT: always delete analyses first.
    removed.analysis = (await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: ids } })).count;
    removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: ids } })).count;
    removed.quota = (await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: ids } })).count;
    Object.assign(removed, await cleanupJobCandidateLists(prisma, tracked.jobIds));
    const files = await prisma.storedFile.findMany({
      where: { ownerId: { in: tracked.userIds }, category: { in: ["JOB_CANDIDATE_LIST", "JOB_CANDIDATE_RESUME"] } },
      select: { id: true, storagePath: true },
    });
    removed.additionalStoredFile = (await prisma.storedFile.deleteMany({ where: { id: { in: files.map((file) => file.id) } } })).count;
    for (const file of files) {
      await removeStoredFileContent(file.storagePath);
      await removeEmptyStoredFileDirectory(file.storagePath);
    }
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: tracked.jobIds } } })).count;
  }
  if (tracked.subscriptionIds.length) removed.subscription = (await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } })).count;
  if (tracked.organizationIds.length) removed.organization = (await prisma.organization.deleteMany({ where: { id: { in: tracked.organizationIds } } })).count;
  if (tracked.userIds.length) removed.user = (await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } })).count;
  if (tracked.planIds.length) removed.plan = (await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } })).count;
  return removed;
};

const countLeftovers = async () => {
  const ids = { in: tracked.jobIds };
  return (await Promise.all([
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
    prisma.job.count({ where: { id: ids } }),
    prisma.aiJob.count({ where: { jobId: ids } }),
    prisma.jobCandidateAnalysis.count({ where: { jobId: ids } }),
    prisma.organization.count({ where: { id: { in: tracked.organizationIds } } }),
    countCandidateListLeftovers(prisma, tracked.jobIds),
  ])).reduce((sum, count) => sum + count, 0);
};

const finish = async (before) => {
  section("Cleanup — stopping HTTP and removing every harness fixture");
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  check("ephemeral Express server stopped", !httpServer || !httpServer.listening);
  try { console.log(`  queue records checked: ${await removeQueueJobs()}`); } catch (error) { check("queue cleanup succeeds", false, error.message); }
  await aiJobQueue.closeAiJobQueue();
  try {
    console.log(`  deleted rows: ${summarize(await cleanup())}`);
    check("no verifier fixture rows/files remain", (await countLeftovers()) === 0);
  } catch (error) {
    check("no verifier fixture rows/files remain", false, error.message);
  }
  const after = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);
  console.log(`platform totals at end:   ${summarize(after)}`);
  check("pre-existing database counts held or grew", Object.keys(before).every((table) => after[table] >= before[table]), summarize({ before, after }));
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED CHECKS:");
    failed.forEach((entry) => console.log(`  - ${entry.label}`));
    process.exitCode = 1;
    return;
  }
  console.log("Phase 7 Step 5 recruiter read-only API/UI contract verified: no recruiter-initiated analysis exists anywhere, and the terminal assessment lifecycle is the single automatic trigger. Step 6 SSE reconciliation is enabled; no bulk, FastAPI change, or worker execution change was added.");
};


const run = async () => {
  console.log("Candidate analysis recruiter verification harness — Phase 7 Step 5");
  console.log(`run id: ${SUFFIX}`);
  const before = await snapshotTotals();
  try {
    const owner = await createRecruiter("owner");
    const other = await createRecruiter("other");
    const emailA = candidateEmail("a");
    const emailB = candidateEmail("b");
    const job = await createJob(owner, [
      ["Candidate A", emailA, "https://linkedin.com/in/a", "github.com/a", "Backend Engineer", "Node.js, PostgreSQL", "Production backend"],
      ["Candidate B", emailB, null, null, "Platform Engineer", "Docker", "Infrastructure"],
    ], { title: "Step 5 Main" });
    const otherJob = await createJob(other, [["Other Candidate", candidateEmail("other-job")]], { title: "Step 5 Other" });
    const draft = await createJob(owner, [["Draft Candidate", candidateEmail("draft")]], { start: false, title: "Step 5 Draft" });
    const reference = getReference(job, emailA);
    const otherReference = otherJob.references[0];

    const started = await startHttpServer();
    httpServer = started.server;
    const automatic = await scenarioAutomaticTriggerAndStatus({
      origin: started.origin, owner, other, job, otherJob, otherReference,
      draftJob: draft, draftEmail: candidateEmail("draft"), emailA, emailB,
    });
    await scenarioResultsVersions({
      origin: started.origin, token: automatic.token, job, reference,
      firstAiJobId: automatic.firstAiJobId, attempt: automatic.attempt,
      secondAiJobId: automatic.secondAiJobId, freshAttempt: automatic.freshAttempt,
    });

    const orgA = await createOrganizationFixture("org-a");
    const orgAAdmin = await addOrganizationMember(orgA.organization.id, "org-a-admin", "ORG_ADMIN");
    const orgBAdmin = await createOrganizationFixture("org-b", "ORG_ADMIN");
    const orgJob = await createJob(orgA, [
      ["Org Candidate", candidateEmail("org"), "https://linkedin.com/in/org", "github.com/org", "Backend Engineer", "Node.js", "Org evidence"],
      ["Org Missing Resume", candidateEmail("org-missing"), null, null, null, null, null],
    ], { title: "Step 5 Organization" });
    const orgJobOther = await createJob(orgA, [["Org Other Job Candidate", candidateEmail("org-other-job")]], { title: "Step 5 Organization Other" });
    await scenarioOrganizationAndResume({
      origin: started.origin, orgA, orgAAdmin, orgBAdmin,
      jobA: orgJob, jobAOther: orgJobOther, referenceA: orgJob.references[0], missingResumeReference: orgJob.references[1],
    });
    scenarioStaticScope();
  } catch (error) {
    console.error("\nUNEXPECTED harness error:", error);
    check("every Step 5 scenario ran without an unexpected error", false, error.message);
  } finally {
    await finish(before);
  }
};

run()
  .catch((error) => { console.error("Harness failed:", error); process.exitCode = 1; })
  .finally(async () => {
    await aiJobQueue.closeAiJobQueue().catch(() => {});
    await prisma.$disconnect();
  });

