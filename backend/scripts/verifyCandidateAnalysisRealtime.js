/* eslint-disable no-console */
// Phase 7 Step 6 focused verifier: candidate-analysis after-commit events through
// the existing PostgreSQL -> Redis Pub/Sub -> authorized Express SSE architecture.
// The real processAiJob transition path is exercised with a deterministic AI
// response/error only; FastAPI/Gemini execution remains covered by Step 4.
require("dotenv").config();

// Keep verification deterministic and prevent the repository's module-level
// mail transporter from retaining this process after all checks complete.
process.env.SMTP_HOST = "";
process.env.SMTP_PORT = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASSWORD = "";
process.env.EMAIL_FROM = "";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const XLSX = require("xlsx");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
process.env.REALTIME_REDIS_CHANNEL = `platform:realtime:candidate-status:step6-${SUFFIX}`;
process.env.AI_QUEUE_PREFIX = `candidate-realtime-${SUFFIX}`;
process.env.AI_JOB_MAX_ATTEMPTS = "2";

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const referenceService = require("../src/module/job/jobCandidateReference.service");
const aiJobRepository = require("../src/module/ai-job/aiJob.repository");
const aiJobValidation = require("../src/module/ai-job/aiJob.validation");
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const { AiServiceError } = require("../src/module/ai-job/aiJob.client");
const { processAiJob } = require("../src/ai-worker");
const realtimeGateway = require("../src/module/realtime/realtime.gateway");
const realtimePublisher = require("../src/module/job/jobAssessmentRealtime.publisher");
const {
  REALTIME_EVENT_TYPES,
  PERSISTED_CANDIDATE_ANALYSIS_STATUSES,
  buildCandidateAnalysisStatusEvent,
  sanitizeCandidateStatusEvent,
} = require("../src/module/job/jobAssessmentRealtime.events");
const {
  closeRealtimePubSub,
  getRealtimePubSubStats,
  subscribeRealtimeEvents,
} = require("../src/config/redis.pubsub");
const generateAccessToken = require("../src/utils/generateAccessToken");
const {
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "frontend");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const results = [];
const tracked = {
  userIds: [], planIds: [], subscriptionIds: [], organizationIds: [], jobIds: [], aiJobIds: [],
};
let httpServer = null;
let recorderSubscription = null;
const recorded = [];
const openHttpStreams = new Set();

const section = (title) => console.log(`\n${title}`);
const summarize = (value) => JSON.stringify(value ?? null);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n        -> ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (labelOrProbe, probeOrTimeout, maybeTimeout = 6000) => {
  const probe = typeof labelOrProbe === "function" ? labelOrProbe : probeOrTimeout;
  const timeoutMs = typeof labelOrProbe === "function"
    ? (typeof probeOrTimeout === "number" ? probeOrTimeout : maybeTimeout)
    : maybeTimeout;
  if (typeof probe !== "function") throw new Error("waitFor requires a probe function");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${typeof labelOrProbe === "string" ? labelOrProbe : "condition"}`);
    }
    await sleep(25);
  }
};
const candidateEvents = () => recorded.filter(
  (event) => event.eventType === REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED
);
const tokenFor = (user) => generateAccessToken({ userId: user.id, role: user.role });

const startRecorder = async () => {
  recorded.length = 0;
  recorderSubscription = await subscribeRealtimeEvents((event) => {
    const clean = sanitizeCandidateStatusEvent(event);
    if (clean) recorded.push({ ...clean, receivedAt: Date.now() });
  });
};

const startHttpServer = () => new Promise((resolve, reject) => {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  delete process.env.EMAIL_FROM;
  const app = require("../src/app");
  const server = http.createServer(app);
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve({
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
  }));
});

const parseFrames = (buffer, onFrame) => {
  let remaining = buffer;
  let boundary = remaining.indexOf("\n\n");
  while (boundary !== -1) {
    const raw = remaining.slice(0, boundary).replace(/\r/g, "");
    remaining = remaining.slice(boundary + 2);
    const eventName = raw.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = raw.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (data) {
      try { onFrame({ event: eventName, data: JSON.parse(data) }); } catch {}
    }
    boundary = remaining.indexOf("\n\n");
  }
  return remaining;
};

const openSse = async ({ origin, token, jobId }) => {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/realtime/candidates/${jobId}/events`, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } : { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    controller.abort();
    return { status: response.status, text, events: [], close: () => {} };
  }
  const events = [];
  let buffer = "";
  let closed = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = parseFrames(buffer + decoder.decode(value, { stream: true }), (frame) => events.push(frame));
      }
    } catch (error) {
      if (!closed && error?.name !== "AbortError") console.error(`[step6:sse] ${error.message}`);
    }
  })();
  const stream = {
    status: response.status,
    headers: response.headers,
    events,
    close: () => { closed = true; openHttpStreams.delete(stream); controller.abort(); },
  };
  openHttpStreams.add(stream);
  return stream;
};


const candidateEmail = (label) => `step6-${label}-${SUFFIX}@example.test`;
const uniqueEmail = candidateEmail;
const buildWorkbook = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Email", "LinkedIn", "GitHub", "Preferred Role", "Skills", "Skill Notes"],
    ...rows,
  ]);
  return XLSX.write({ SheetNames: ["Candidates"], Sheets: { Candidates: sheet } }, { type: "buffer", bookType: "xlsx" });
};

const JOB_PAYLOAD = {
  title: "Step 6 Backend Engineer",
  yearsExperience: 5,
  description: "Build reliable backend services with Node.js and PostgreSQL.",
  analysisDays: 3,
  skills: [{ name: "Node.js", weight: 60 }, { name: "PostgreSQL", weight: 40 }],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe one production reliability decision you owned." }],
};

const createRecruiter = async (label) => {
  const user = await prisma.user.create({ data: {
    fullName: `Step 6 ${label}`, email: `step6-${label}-${SUFFIX}@example.test`,
    provider: "LOCAL", emailVerified: true, status: "ACTIVE",
  }});
  const role = await prisma.role.upsert({ where: { name: "RECRUITER" }, update: {},
    create: { name: "RECRUITER", description: "Recruiter role" } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const plan = await prisma.subscriptionPlan.create({ data: {
    name: `Step 6 Plan ${label} ${SUFFIX}`, type: "RECRUITER", price: 0,
    billingCycle: "MONTHLY", jobPostingLimit: 20,
  }});
  const subscription = await prisma.subscription.create({ data: {
    planId: plan.id, userId: user.id, status: "ACTIVE", startDate: new Date(),
    expiryDate: new Date(Date.now() + 30 * DAY_IN_MS),
  }});
  tracked.userIds.push(user.id); tracked.planIds.push(plan.id); tracked.subscriptionIds.push(subscription.id);
  return { user: { id: user.id, role: "RECRUITER" }, subscription };
};

const createOrganizationFixture = async (label) => {
  const owner = await createRecruiter(`org-${label}`);
  const organization = await prisma.organization.create({ data: {
    name: `Step 6 ${label} ${SUFFIX}`, ownerId: owner.user.id, status: "ACTIVE",
  }});
  await prisma.organizationMembership.create({ data: {
    userId: owner.user.id, organizationId: organization.id, role: "RECRUITER", status: "ACTIVE",
  }});
  await prisma.subscription.update({ where: { id: owner.subscription.id }, data: {
    userId: null, organizationId: organization.id,
  }});
  tracked.organizationIds.push(organization.id);
  return { ...owner, organization, user: { ...owner.user, organizationId: organization.id } };
};

const createActiveJob = async (recruiter, rows, title) => {
  const draft = await jobService.createDraft(recruiter.user, { ...JOB_PAYLOAD, title: `${title} ${SUFFIX}` });
  tracked.jobIds.push(draft.id);
  const buffer = buildWorkbook(rows);
  await jobService.uploadCandidateList(recruiter.user, draft.id, {
    originalname: `step6-${title}-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
  const references = await referenceService.listCandidateReferences(recruiter.user, draft.id);
  const started = await jobService.startJob(recruiter.user, draft.id);
  tracked.aiJobIds.push(started.aiJob.id);
  return { jobId: draft.id, references, startAiJobId: started.aiJob.id };
};

// --- Automatic-analysis fixture -----------------------------------------------
// A job owns exactly one assessment (JobAssessment.jobId is unique) and one attempt
// per candidate, so the assessment and its question are created once per job and
// reused by every candidate analyzed in it.
const ensureAssessment = async (jobId) => {
  const existing = await prisma.jobAssessment.findUnique({ where: { jobId } });
  if (existing) return existing;
  const assessment = await prisma.jobAssessment.create({
    data: {
      jobId,
      title: "Step 6 realtime assessment",
      description: "Authoritative assessment evidence.",
      status: "FINALIZED",
      publicId: `step6-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
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

// Commits the terminal attempt the assessment lifecycle would have committed, then
// lets the SYSTEM start the analysis. This is the only entry point that exists now:
// the recruiter has no trigger, so every realtime scenario below drives the real
// automatic funnel instead of the removed recruiter route. The recruiter is still
// used, to resolve the candidate email through the authorized reference listing.
const requestAnalysis = async (recruiter, jobId, referenceId) => {
  const reference = (await referenceService.listCandidateReferences(recruiter.user, jobId))
    .find((row) => row.id === referenceId);
  if (!reference) throw new Error(`Reference ${referenceId} does not belong to job ${jobId}`);
  const assessment = await ensureAssessment(jobId);
  const invitation = await prisma.jobAssessmentInvitation.create({
    data: {
      jobId,
      assessmentId: assessment.id,
      email: reference.candidateEmail,
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
      email: reference.candidateEmail,
      status: "SUBMITTED",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      deadlineAt: new Date(Date.now() + DAY_IN_MS),
      submittedAt: now,
      score: 8,
      maxScore: 10,
      scorePercentage: 80,
    },
  });
  const question = await prisma.jobAssessmentQuestion.findFirst({ where: { assessmentId: assessment.id } });
  await prisma.jobAssessmentAttemptAnswer.create({
    data: {
      attemptId: attempt.id,
      questionId: question.id,
      answer: { text: "Authoritative candidate answer committed with the attempt." },
    },
  });
  const result = await referenceService.runAutomaticCandidateAnalysis({
    id: attempt.id,
    jobId: attempt.jobId,
    assessmentId: attempt.assessmentId,
    email: attempt.email,
    status: attempt.status,
  });
  if (!result.triggered) throw new Error(`Automatic candidate analysis did not trigger: ${result.reason}`);
  tracked.aiJobIds.push(result.aiJob.id);
  return result;
};

const candidateResult = (request) => ({
  jobFitSummary: "Evidence indicates relevant backend experience.",
  assessmentPerformance: {
    status: "NOT_STARTED", score: null, maxScore: null, scorePercentage: null,
    summary: "No assessment evidence was supplied.", strengths: [], gaps: [], unanswered: 0,
  },
  skillAlignment: request.job.skills.map((skill) => ({
    skill: skill.name,
    status: skill.name === "Node.js" ? "SUPPORTED" : "NOT_EVIDENCED",
    rationale: skill.name === "Node.js" ? "Assessment evidence supports this skill." : "No supplied evidence demonstrates this skill.",
    evidence: skill.name === "Node.js" ? ["Explained a reliability decision"] : [],
  })),
  resumeEvidence: { status: "AVAILABLE", summary: "Resume evidence was supplied.", details: ["Backend experience"] },
  linkedinEvidence: { status: "AVAILABLE", summary: "LinkedIn text was supplied.", details: ["Backend profile"] },
  githubEvidence: { status: "UNAVAILABLE", summary: "A reference exists without analyzed text.", details: [] },
  preferredRoleAlignment: { status: "SUPPORTED", summary: "Preferred role aligns with the job.", rationale: "Based on supplied role evidence." },
  strengths: ["Relevant backend experience"],
  skillGaps: ["No supplied PostgreSQL evidence"],
  missingRequirements: ["Docker evidence was not supplied"],
  conflicts: [], concerns: [],
  finalRecruiterReview: "Review the supplied evidence and make the hiring decision.",
});

const deterministicAnalyze = async (row) => {
  const request = aiJobValidation.buildRequest(row);
  return {
    schemaVersion: "1", aiJobId: row.id, operation: "CANDIDATE_ANALYSIS",
    provider: "gemini", model: "step6-deterministic", analysis: candidateResult(request),
  };
};


const scenarioEventModel = () => {
  section("A. Event contract — separate status vocabulary and strict privacy");
  check("candidate-analysis event type exists", REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED === "CANDIDATE_ANALYSIS_UPDATED");
  check("status vocabulary is exactly PENDING / PROCESSING / COMPLETED / FAILED", summarize(PERSISTED_CANDIDATE_ANALYSIS_STATUSES) === summarize(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]));
  const hostile = {
    eventType: REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED,
    jobId: "job-1", referenceId: "reference-1", analysisId: "analysis-1",
    analysisVersion: 2, status: "PROCESSING", updatedAt: new Date().toISOString(),
    candidateEmail: "private@example.test", candidateName: "Private Name",
    resumeText: "private resume", linkedinText: "private linkedin", githubText: "private github",
    result: { secret: true }, requestPayload: {}, snapshotHash: "hash", correctAnswer: "A",
    answer: "private answer", integrity: {}, verificationToken: "token", storagePath: "C:/resume",
    apiKey: "key", prompt: "prompt", overallScore: 99,
  };
  const clean = sanitizeCandidateStatusEvent(hostile);
  const expectedKeys = ["analysisId", "analysisVersion", "eventType", "jobId", "referenceId", "status", "updatedAt"];
  check("the exact sanitized event contains only the seven whitelisted keys", summarize(Object.keys(clean).sort()) === summarize(expectedKeys), summarize(clean));
  const serialized = JSON.stringify(clean);
  check("serialized SSE notification excludes email, evidence, result, answer, integrity, token, hash, path, key, prompt, and score", !/candidateEmail|candidateName|resumeText|linkedinText|githubText|result|requestPayload|snapshotHash|correctAnswer|answer|integrity|token|storagePath|apiKey|prompt|overallScore/i.test(serialized), serialized);
  check("malformed status/version/date/reference events are rejected", sanitizeCandidateStatusEvent({ ...hostile, status: "CANCELLED" }) === null && sanitizeCandidateStatusEvent({ ...hostile, analysisVersion: 0 }) === null && sanitizeCandidateStatusEvent({ ...hostile, updatedAt: "bad" }) === null && sanitizeCandidateStatusEvent({ ...hostile, referenceId: "" }) === null);
};

const runToCompletion = async (recruiter, jobId, referenceId, label) => {
  const requested = await requestAnalysis(recruiter, jobId, referenceId);
  const pending = await waitForEvent((event) => event.analysisId === requested.analysis.id && event.status === "PENDING");
  const completed = await processAiJob(queueDelivery(requested.aiJob.id), `step6-${label}`, deterministicAnalyze);
  const completedEvent = await waitForEvent((event) => event.analysisId === requested.analysis.id && event.status === "COMPLETED");
  return { requested, pending, completed, completedEvent };
};

const scenarioAfterCommit = async (recruiter, job) => {
  section("B. Real committed PROCESSING / COMPLETED transitions and after-commit ordering");
  const ref = job.references[0];
  const beforeCount = candidateEvents().filter((event) => event.referenceId === ref.id).length;
  const run = await runToCompletion(recruiter, job.jobId, ref.id, "complete");
  const own = candidateEvents().filter((event) => event.referenceId === ref.id);
  check("PENDING is published after the committed analysis/AiJob creation", run.pending.status === "PENDING" && run.pending.jobId === job.jobId, summarize(run.pending));
  check("the worker publishes PROCESSING and COMPLETED for the same opaque reference", summarize(own.map((event) => event.status)) === summarize(["PENDING", "PROCESSING", "COMPLETED"]), summarize(own));
  check("all events carry the same analysis id and deterministic version", own.every((event) => event.analysisId === run.requested.analysis.id && event.analysisVersion === run.requested.analysis.analysisVersion));
  check("the worker returns COMPLETED only after durable persistence", run.completed.status === "COMPLETED" && Boolean(run.completedEvent));
  check("exactly three state notifications exist for PENDING -> PROCESSING -> COMPLETED", own.length - beforeCount === 3, summarize(own.length - beforeCount));
  const row = await prisma.aiJob.findUnique({ where: { id: run.requested.aiJob.id } });
  const analysis = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: row.id } });
  check("the terminal event corresponds to committed PostgreSQL state", row.status === "COMPLETED" && analysis.completedAt !== null, summarize({ aiJob: row.status, completed: Boolean(analysis.completedAt) }));
  check("the event transport never contains the persisted analysis result", !JSON.stringify(own).includes("Evidence indicates relevant backend experience"));

  const rollbackRef = job.references[1];
  const rollback = await requestAnalysis(recruiter, job.jobId, rollbackRef.id);
  const claim = await aiJobRepository.claimAiJobForProcessing({ aiJobId: rollback.aiJob.id, workerId: "step6-rollback" });
  const failingClient = { $transaction: async () => { throw new Error("INJECTED_ROLLBACK"); } };
  const beforeRollbackEvents = candidateEvents().filter((event) => event.analysisId === rollback.analysis.id).length;
  let rollbackError = null;
  try {
    await aiJobRepository.completeCandidateAnalysis({
      aiJobId: rollback.aiJob.id, workerId: claim.workerId, attempts: claim.attempts,
      analysis: candidateResult(aiJobValidation.buildRequest(claim)), provider: "gemini", model: "step6", client: failingClient,
    });
  } catch (error) { rollbackError = error; }
  await sleep(150);
  const rolledBack = await prisma.aiJob.findUnique({ where: { id: rollback.aiJob.id } });
  check("an injected transaction rollback throws and leaves PROCESSING durable state", rollbackError?.message === "INJECTED_ROLLBACK" && rolledBack.status === "PROCESSING");
  check("a rolled-back transaction emits no terminal candidate-analysis event", candidateEvents().filter((event) => event.analysisId === rollback.analysis.id).length === beforeRollbackEvents);
  return {
    ref,
    run,
    rollback,
    requested: run.requested,
    completedEvent: run.completedEvent,
  };
};

const scenarioSseAuthorization = async ({ origin, recruiterA, recruiterB, jobA, jobB }) => {
  section("C. Authorized Express SSE delivery and job/organization isolation");
  const unauthenticated = await openSse({ origin, jobId: jobA.jobId });
  const forbidden = await openSse({ origin, token: tokenFor(recruiterB.user), jobId: jobA.jobId });
  check("SSE requires authentication", unauthenticated.status === 401, summarize(unauthenticated.status));
  check("another recruiter cannot open another job's SSE stream", forbidden.status === 403, summarize(forbidden.status));

  const streamA = await openSse({ origin, token: tokenFor(recruiterA.user), jobId: jobA.jobId });
  const streamB = await openSse({ origin, token: tokenFor(recruiterB.user), jobId: jobB.jobId });
  await waitFor(() => streamA.events.some((frame) => frame.event === "ready") && streamB.events.some((frame) => frame.event === "ready"));
  check("both authorized job streams receive the SSE ready handshake", streamA.status === 200 && streamB.status === 200);
  check("one shared Redis subscription serves both Express SSE clients", getRealtimePubSubStats().listenerCount === 2, summarize(getRealtimePubSubStats()));

  const runB = await runToCompletion(recruiterB, jobB.jobId, jobB.references[0].id, "isolation-b");
  await waitFor(() => streamB.events.some((frame) => frame.event === "candidate-status" && frame.data.analysisId === runB.requested.analysis.id));
  check("the authorized Job B recruiter receives Job B's candidate-analysis event", streamB.events.some((frame) => frame.data.analysisId === runB.requested.analysis.id));
  check("Job A's stream never receives Job B's event", !streamA.events.some((frame) => frame.data.analysisId === runB.requested.analysis.id), summarize(streamA.events));

  const eventB = candidateEvents().find((event) => event.analysisId === runB.requested.analysis.id);
  check("same normalized email in two jobs keeps distinct references and event identities", jobA.references[0].candidateEmail === jobB.references[0].candidateEmail && jobA.references[0].id !== jobB.references[0].id && eventB.referenceId === jobB.references[0].id);
  check("event identity is jobId + opaque referenceId, never email", eventB.jobId === jobB.jobId && eventB.referenceId !== eventB.candidateEmail && !("candidateEmail" in eventB));

  streamA.close(); streamB.close();
  await waitFor(() => realtimeGateway.getGatewayStats().connectedClients === 0);
  check("closing both clients releases their Express gateway clients", realtimeGateway.getGatewayStats().connectedClients === 0);
  return { streamA, streamB, runB };
};

const scenarioCrossOrganization = async ({ origin, orgA, orgB }) => {
  section("D. Cross-organization SSE isolation");
  const orgAJob = await createActiveJob(orgA, [["Org A", uniqueEmail("org-a")]], "Organization A");
  const orgBJob = await createActiveJob(orgB, [["Org B", uniqueEmail("org-b")]], "Organization B");
  const forbiddenA = await openSse({ origin, token: tokenFor(orgB.user), jobId: orgAJob.jobId });
  check("Organization B cannot open Organization A's SSE stream", forbiddenA.status === 403, summarize(forbiddenA.status));
  const streamA = await openSse({ origin, token: tokenFor(orgA.user), jobId: orgAJob.jobId });
  await runToCompletion(orgA, orgAJob.jobId, orgAJob.references[0].id, "org-a");
  await waitFor(() => streamA.events.some((frame) => frame.data.eventType === REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED));
  check("Organization A receives only its own authorized job event", streamA.events.some((frame) => frame.data.jobId === orgAJob.jobId) && !streamA.events.some((frame) => frame.data.jobId === orgBJob.jobId));
  streamA.close();
  return { orgAJob, orgBJob };
};

const scenarioFailureAndRetry = async (recruiter, job) => {
  section("E. FAILED terminal event and retry-release PENDING event");
  const ref = job.references[2];
  const requested = await requestAnalysis(recruiter, job.jobId, ref.id);
  const failAnalyze = async () => { throw new AiServiceError("AI_PROVIDER_UNAVAILABLE", true); };
  let firstError = null;
  try { await processAiJob(queueDelivery(requested.aiJob.id, 2), "step6-retry", failAnalyze); }
  catch (error) { firstError = error; }
  const processing = await waitForEvent((event) => event.analysisId === requested.analysis.id && event.status === "PROCESSING");
  const pendingAgain = await waitForEvent((event) => event.analysisId === requested.analysis.id && event.status === "PENDING" && event.updatedAt !== processing.updatedAt);
  const afterRetry = await prisma.aiJob.findUnique({ where: { id: requested.aiJob.id } });
  check("a retryable failure commits PROCESSING -> PENDING and emits both states", firstError?.code === "AI_PROVIDER_UNAVAILABLE" && afterRetry.status === "PENDING" && processing && pendingAgain, summarize({ code: firstError?.code, status: afterRetry.status }));

  const terminalAnalyze = async () => { throw new AiServiceError("AI_PROVIDER_SAFETY_BLOCKED", false); };
  let terminalError = null;
  try { await processAiJob(queueDelivery(requested.aiJob.id, 2), "step6-terminal", terminalAnalyze); }
  catch (error) { terminalError = error; }
  const failedEvent = await waitForEvent((event) => event.analysisId === requested.analysis.id && event.status === "FAILED");
  const failedRow = await prisma.aiJob.findUnique({ where: { id: requested.aiJob.id } });
  check("a non-retryable failure commits FAILED and emits one sanitized FAILED event", terminalError?.message === "AI_PROVIDER_SAFETY_BLOCKED" && failedRow.status === "FAILED" && failedEvent.status === "FAILED");
  const failureEvents = candidateEvents().filter((event) => event.analysisId === requested.analysis.id);
  check("the failed lifecycle is PENDING -> PROCESSING -> PENDING -> PROCESSING -> FAILED", summarize(failureEvents.map((event) => event.status)) === summarize(["PENDING", "PROCESSING", "PENDING", "PROCESSING", "FAILED"]), summarize(failureEvents));
  check("FAILED event carries no provider error body or error code", !/AI_PROVIDER|SAFETY|message|lastError/i.test(JSON.stringify(failedEvent)));
  return { requested, failedEvent };
};

const requestJson = async (origin, pathname, token) => {
  const response = await fetch(`${origin}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, json: await response.json() };
};

const analysisPath = (jobId, referenceId) =>
  `/api/job/${jobId}/candidate-references/${referenceId}/analysis`;

const scenarioDuplicateOutOfOrderAndReconnect = async ({ origin, recruiter, job, completedRun }) => {
  section("F. Duplicate/out-of-order safety, reconnect refetch, and one-candidate reconciliation");
  const completedEvent = candidateEvents().find((event) => event.analysisId === completedRun.requested.analysis.id && event.status === "COMPLETED");
  await realtimePublisher.publishCandidateAnalysisUpdatedEvent(completedEvent);
  await realtimePublisher.publishCandidateAnalysisUpdatedEvent(completedEvent);
  await realtimePublisher.publishCandidateAnalysisUpdatedEvent({ ...completedEvent, status: "PROCESSING", updatedAt: new Date(Date.now() - 1000) });
  await sleep(200);
  const authoritative = await requestJson(origin, analysisPath(job.jobId, completedRun.ref.id), tokenFor(recruiter.user));
  check("duplicate and stale out-of-order notifications leave exactly one persisted analysis", await prisma.jobCandidateAnalysis.count({ where: { aiJobId: completedRun.requested.aiJob.id } }) === 1);
  check("a stale PROCESSING notification cannot regress authoritative COMPLETED API state", authoritative.status === 200 && authoritative.json?.data?.latest?.status === "COMPLETED", summarize(authoritative.json));

  const reconnectRef = job.references[3];
  const firstStream = await openSse({ origin, token: tokenFor(recruiter.user), jobId: job.jobId });
  await waitFor(() => firstStream.events.some((frame) => frame.event === "ready"));
  const missed = await requestAnalysis(recruiter, job.jobId, reconnectRef.id);
  await waitFor(() => firstStream.events.some((frame) => frame.data.analysisId === missed.analysis.id));
  firstStream.close();
  await waitFor(() => realtimeGateway.getGatewayStats().connectedClients === 0);
  await processAiJob(queueDelivery(missed.aiJob.id), "step6-reconnect", deterministicAnalyze);
  const missedEventsWhileClosed = await waitFor(() => {
    const events = candidateEvents().filter((event) => event.analysisId === missed.analysis.id);
    return events.at(-1)?.status === "COMPLETED" ? events : null;
  });
  check("the completion transition commits while the recruiter stream is disconnected", missedEventsWhileClosed.at(-1)?.status === "COMPLETED");
  const reconnected = await openSse({ origin, token: tokenFor(recruiter.user), jobId: job.jobId });
  await waitFor(() => reconnected.events.some((frame) => frame.event === "ready"));
  const recovered = await requestJson(origin, analysisPath(job.jobId, reconnectRef.id), tokenFor(recruiter.user));
  check("SSE reconnect handshake triggers an authoritative refetch path", reconnected.status === 200 && recovered.json?.data?.latest?.status === "COMPLETED", summarize(recovered.json?.data?.latest));
  reconnected.close();
  await waitFor(() => realtimeGateway.getGatewayStats().connectedClients === 0);
  return { missed, reconnected };
};

const scenarioRedisFailure = async ({ completedRun }) => {
  section("G. Redis Pub/Sub outage never rolls back PostgreSQL");
  await realtimeGateway.closeAllStreams();
  const originalUrl = process.env.REDIS_URL;
  const originalTimeout = process.env.REALTIME_PUBLISH_TIMEOUT_MS;
  let delivery = null;
  try {
    await closeRealtimePubSub();
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    process.env.REALTIME_PUBLISH_TIMEOUT_MS = "100";
    delivery = await realtimePublisher.publishCandidateAnalysisUpdatedEvent({
      ...completedRun.completedEvent, updatedAt: new Date(),
    });
  } finally {
    process.env.REDIS_URL = originalUrl;
    if (originalTimeout === undefined) delete process.env.REALTIME_PUBLISH_TIMEOUT_MS;
    else process.env.REALTIME_PUBLISH_TIMEOUT_MS = originalTimeout;
    await closeRealtimePubSub();
  }
  const row = await prisma.aiJob.findUnique({ where: { id: completedRun.requested.aiJob.id } });
  const analysis = await prisma.jobCandidateAnalysis.findUnique({ where: { aiJobId: row.id } });
  check("Redis publication failure resolves safely instead of rejecting business state", delivery?.published === false, summarize(delivery));
  check("PostgreSQL remains COMPLETED and materialized after Redis failure", row.status === "COMPLETED" && analysis.completedAt !== null);
};

const scenarioExistingAssessmentAndFrontend = async ({ origin, recruiter, job }) => {
  section("H. Existing Phase 4 events and Step 6 frontend guards");
  const stream = await openSse({ origin, token: tokenFor(recruiter.user), jobId: job.jobId });
  await waitFor(() => stream.events.some((frame) => frame.event === "ready"));
  await realtimePublisher.publishInvitationEvent({
    jobId: job.jobId, assessmentId: "legacy-assessment", candidateId: 1,
    candidateEmail: candidateEmail("legacy-event"),
  });
  await waitFor(() => stream.events.some((frame) => frame.data.eventType === "ASSESSMENT_INVITED"));
  check("existing ASSESSMENT_* events still use the same candidate-status SSE frame", stream.events.some((frame) => frame.event === "candidate-status" && frame.data.eventType === "ASSESSMENT_INVITED"));
  stream.close();

  const hook = fs.readFileSync(path.join(FRONTEND_ROOT, "src/hooks/useJobCandidateRealtime.js"), "utf8");
  const list = fs.readFileSync(path.join(FRONTEND_ROOT, "src/components/jobs/CandidateWorkflowList.jsx"), "utf8");
  const panel = fs.readFileSync(path.join(FRONTEND_ROOT, "src/components/jobs/CandidateAnalysisPanel.jsx"), "utf8");
  const service = fs.readFileSync(path.join(FRONTEND_ROOT, "src/services/realtimeService.js"), "utf8");
  const frontend = `${hook}\n${list}\n${panel}\n${service}`;
  check("candidate-analysis polling is completely removed", !/POLL_INTERVAL_MS|POLL_LIMIT_MS|setInterval\([\s\S]{0,200}getCandidateAnalysis|every three seconds/i.test(frontend));
  check("only the existing shared hook opens the recruiter SSE client", (frontend.match(/openCandidateStatusStream\(/g) || []).length === 1 && service.includes("export const openCandidateStatusStream"));
  check("candidate events debounce per reference and clear every timer on cleanup", hook.includes("candidateAnalysisTimers.current.has(referenceId)") && hook.includes("candidateTimers.clear()"));
  check("candidate events match jobId + referenceId and call the existing authenticated analysis API", hook.includes("event.jobId !== jobId") && list.includes("getCandidateAnalysis(jobId, event.referenceId)"));
  check("event status/version is never rendered or copied into React state", !/event\.status|event\.analysisVersion/.test(list));
  check("an open analysis panel exposes targeted latest reconciliation", panel.includes("reconcileLatest") && list.includes("analysisPanelRef.current?.reconcileLatest()"));
  check("one candidate event causes one targeted API reconciliation, not a full-list reload", list.includes("current.candidates.map") && !list.slice(list.indexOf("const reconcileCandidateAnalysis"), list.indexOf("const reconcileOpenAnalysisPanel")).includes("load({ background: true })"));
  check("reconnect invokes both list and open-panel authoritative reconciliation", hook.includes("scheduleReconcile();") && hook.includes("candidateReconnectRef.current?.()"));
  check("frontend adds no browser storage, bulk route, external URL fetch, or Gemini credential", !/localStorage|sessionStorage/.test(`${hook}\n${list}\n${panel}`) && !/analyze-all|bulk-analy|@google\/genai|GEMINI_API_KEY|linkedin\.com\/.*fetch|github\.com\/.*fetch/i.test(frontend));
};

const queueDelivery = (aiJobId, attempts = 2) => ({
  data: { aiJobId }, attemptsMade: 0, opts: { attempts },
});

const waitForEvent = (predicate, timeoutMs = 6000) => waitFor(
  "candidate-analysis SSE event",
  () => candidateEvents().find(predicate) ?? null,
  timeoutMs
);

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  organization: await prisma.organization.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
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
    removed.analysis = (await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: ids } })).count;
    removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: ids } })).count;
    removed.quota = (await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: ids } })).count;
    Object.assign(removed, await cleanupJobCandidateLists(prisma, tracked.jobIds));
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: tracked.jobIds } } })).count;
  }
  if (tracked.organizationIds.length) removed.organization = (await prisma.organization.deleteMany({ where: { id: { in: tracked.organizationIds } } })).count;
  if (tracked.subscriptionIds.length) removed.subscription = (await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } })).count;
  if (tracked.userIds.length) removed.user = (await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } })).count;
  if (tracked.planIds.length) removed.plan = (await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } })).count;
  return removed;
};

const countLeftovers = async () => {
  const ids = { in: tracked.jobIds };
  const counts = await Promise.all([
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
    prisma.organization.count({ where: { id: { in: tracked.organizationIds } } }),
    prisma.job.count({ where: { id: ids } }),
    prisma.aiJob.count({ where: { jobId: ids } }),
    prisma.jobCandidateAnalysis.count({ where: { jobId: ids } }),
    prisma.jobAssessment.count({ where: { jobId: ids } }),
    prisma.jobAssessmentAttempt.count({ where: { jobId: ids } }),
    prisma.jobAssessmentInvitation.count({ where: { jobId: ids } }),
    countCandidateListLeftovers(prisma, tracked.jobIds),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
};

const finish = async (before) => {
  section("Cleanup — closing streams/Redis and removing every fixture");
  await realtimeGateway.closeAllStreams();
  for (const stream of openHttpStreams) stream.close();
  openHttpStreams.clear();
  if (recorderSubscription) {
    await recorderSubscription.unsubscribe().catch(() => {});
    recorderSubscription = null;
  }
  await closeRealtimePubSub();
  check("Express gateway, shared Redis subscription, and recorder are closed", realtimeGateway.getGatewayStats().connectedClients === 0 && getRealtimePubSubStats().listenerCount === 0);
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  check("ephemeral Express server stopped", !httpServer || !httpServer.listening);
  try { console.log(`  queue records checked: ${await removeQueueJobs()}`); }
  catch (error) { check("queue cleanup succeeds", false, error.message); }
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
    failed.forEach((entry) => console.log(`  FAIL ${entry.label}`));
    process.exitCode = 1;
    return;
  }
  console.log("Phase 7 Step 6 verified: after-commit candidate-analysis notifications use the existing Redis/SSE architecture and PostgreSQL remains authoritative.");
};

const run = async () => {
  console.log("Candidate analysis realtime verification harness — Phase 7 Step 6");
  console.log(`run id: ${SUFFIX}`);
  const before = await snapshotTotals();
  try {
    await startRecorder();
    scenarioEventModel();
    const recruiterA = await createRecruiter("a");
    const recruiterB = await createRecruiter("b");
    const sharedEmail = candidateEmail("same-email");
    const rows = [
      ["Candidate A", sharedEmail, "https://linkedin.com/in/a", "github.com/a", "Backend Engineer", "Node.js, PostgreSQL", "Evidence A"],
      ["Candidate B", candidateEmail("b"), "", "", "Platform Engineer", "Docker", "Evidence B"],
      ["Candidate C", candidateEmail("c"), "", "", "Backend Engineer", "Node.js", "Evidence C"],
      ["Candidate D", candidateEmail("d"), "", "", "Backend Engineer", "PostgreSQL", "Evidence D"],
    ];
    const jobA = await createActiveJob(recruiterA, rows, "Realtime A");
    const jobB = await createActiveJob(recruiterB, [["Candidate A", sharedEmail, "", "", "Backend Engineer", "Node.js", "Different job evidence"]], "Realtime B");
    const completedRun = await scenarioAfterCommit(recruiterA, jobA);
    const started = await startHttpServer();
    httpServer = started.server;
    await scenarioSseAuthorization({ origin: started.origin, recruiterA, recruiterB, jobA, jobB });
    const orgA = await createOrganizationFixture("a");
    const orgB = await createOrganizationFixture("b");
    await scenarioCrossOrganization({ origin: started.origin, orgA, orgB });
    await scenarioFailureAndRetry(recruiterA, jobA);
    await scenarioDuplicateOutOfOrderAndReconnect({ origin: started.origin, recruiter: recruiterA, job: jobA, completedRun });
    await scenarioExistingAssessmentAndFrontend({ origin: started.origin, recruiter: recruiterA, job: jobA });
    await scenarioRedisFailure({ completedRun });
  } catch (error) {
    console.error("\nUNEXPECTED harness error:", error);
    check("every Step 6 scenario ran without an unexpected error", false, error.message);
  } finally {
    await finish(before);
  }
};

run()
  .catch((error) => { console.error("Harness failed:", error); process.exitCode = 1; })
  .finally(async () => {
    await aiJobQueue.closeAiJobQueue().catch(() => {});
    await closeRealtimePubSub().catch(() => {});
    await prisma.$disconnect();
  });
