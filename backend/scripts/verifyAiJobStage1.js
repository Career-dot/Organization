/* eslint-disable no-console */
// Stage 1 verification harness: durable AiJob foundation for Job Start.
//
// Run with:  node scripts/verifyAiJobStage1.js
//
// Proves the Stage 1 contract:
//   Job Start → Job ACTIVE + quota consumed exactly once + one AiJob PENDING,
//   all three committed by a single PostgreSQL transaction (or none of them).
//
// Convention: manual, one-off script under scripts/ (see bootstrapSuperAdmin.js)
// — CommonJS, the application's own Prisma client, process.exitCode on failure.
//
// Safety: creates its own throwaway RECRUITER + plan + subscription + jobs with
// a unique suffix, and deletes exactly what it created (tracked by id, FK order)
// in a finally block. It never resets, truncates or migrates the database, and
// it prints the platform row totals before/after for the record.
//
// Stage 1 has no queue and no worker, so the AiJob is expected to stay PENDING
// forever: nothing may set it to COMPLETED and nothing may write a result.
require("dotenv").config();

const assert = require("node:assert/strict");
const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const jobValidation = require("../src/module/job/job.validation");
const { AI_JOB_OPERATION, AI_JOB_STATUS } = require("../src/module/ai-job/aiJob.repository");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Start now delivers through Redis; isolate these regression deliveries from workers.
process.env.AI_QUEUE_PREFIX = `stage1-${SUFFIX}`;
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const {
  attachJobCandidateList,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

// --- reporting -------------------------------------------------------------

const results = [];

const section = (title) => console.log(`\n${title}`);

const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  console.log(!ok && detail ? `${line}\n        -> ${detail}` : line);
};

// deepStrictEqual ignores object key order (PostgreSQL jsonb reorders keys when
// it stores the payload) but still enforces array order, which is what we want:
// the snapshot must reproduce skills/tools/questions in their sort order.
const jsonEqual = (actual, expected) => {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
};

const summarize = (value) => JSON.stringify(value ?? null);

// Asserts that `fn()` rejects with the given HTTP status and returns the error.
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

// --- fixtures --------------------------------------------------------------

// A payload that satisfies every readiness rule in
// job.service.assertJobReadyToStart (description length, >= 1 skill weighing
// exactly 100 in total, >= 1 tool, >= 1 question, analysisDays 1-10).
// Phase 2: the structured metadata is required on NEW jobs (createdAt >= cutoff).
const READY_PAYLOAD = {
  title: "Senior Backend Engineer",
  yearsExperience: 7,
  description: "Own the billing platform end to end, including ledger correctness and payment integrations.",
  employmentType: "FULL_TIME",
  workMode: "REMOTE",
  location: "Warsaw, Poland",
  analysisDays: 4,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }, { name: "GitHub Actions" }],
  questions: [
    { question: "Describe the most complex database transaction you have designed." },
    { question: "How do you investigate a slow production query?" },
  ],
};

// The exact snapshot the AiJob must hold after starting READY_PAYLOAD.
// Deliberately absent: analysisDays (analysis-window input, not an AI input),
// ownership ids, subscription/quota data and any credential material.
const expectedPayload = () => ({
  operation: AI_JOB_OPERATION.JOB_ANALYSIS,
  input: {
    title: READY_PAYLOAD.title,
    yearsExperience: READY_PAYLOAD.yearsExperience,
    description: READY_PAYLOAD.description,
    skills: READY_PAYLOAD.skills.map((skill) => ({ name: skill.name, weight: skill.weight })),
    tools: READY_PAYLOAD.tools.map((tool) => tool.name),
    questions: READY_PAYLOAD.questions.map((item) => item.question),
  },
});

const tracked = { userIds: [], planIds: [], subscriptionIds: [], jobIds: [] };

// The job service only ever reads user.id and user.role from the authenticated
// principal (resolveSubscriptionAccess), so a role literal is sufficient — no
// UserRole row is needed to exercise this path.
const createRecruiterFixture = async (label, jobPostingLimit) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Stage1 Harness ${label}`,
      email: `stage1-aijob-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Stage1 Harness Plan ${label} ${SUFFIX}`,
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

const createDraftFixture = async (recruiter, payload = READY_PAYLOAD) => {
  const draft = await jobService.createDraft(recruiter.user, payload);
  tracked.jobIds.push(draft.id);
  return draft;
};

const countAiJobs = (jobId) => prisma.aiJob.count({ where: { jobId } });
const countConsumptions = (jobId) => prisma.jobQuotaConsumption.count({ where: { jobId } });
const countConsumptionsBySubscription = (subscriptionId) =>
  prisma.jobQuotaConsumption.count({ where: { subscriptionId } });

// --- scenario 1: successful Start (the Stage 1 contract) -------------------

const scenarioSuccessfulStart = async (recruiter) => {
  section("1. Successful Start — Job ACTIVE + quota consumed once + one AiJob PENDING");

  const draft = await createDraftFixture(recruiter);
  // Start now REQUIRES a candidate Excel sheet; attach one through the
  // production upload path so the Start contract below is unchanged.
  await attachJobCandidateList(recruiter, draft.id);
  const callStartedAt = new Date();
  const started = await jobService.startJob(recruiter.user, draft.id);

  check(
    "Start still returns { job, limits } and adds { aiJob }",
    Boolean(started.job && started.aiJob && started.limits),
    summarize({ job: started.job?.id, aiJob: started.aiJob, limits: started.limits })
  );
  check(
    "the exposed aiJob is exactly { id, operation, status } (requestPayload never reaches the client)",
    jsonEqual(Object.keys(started.aiJob ?? {}).sort(), ["id", "operation", "status"]),
    `keys=${summarize(Object.keys(started.aiJob ?? {}))}`
  );
  check(
    "Start reports the aiJob as JOB_ANALYSIS / PENDING",
    started.aiJob?.operation === AI_JOB_OPERATION.JOB_ANALYSIS && started.aiJob?.status === AI_JOB_STATUS.PENDING,
    summarize(started.aiJob)
  );

  const jobRow = await prisma.job.findUnique({ where: { id: draft.id } });
  check("Job is ACTIVE", jobRow?.status === "ACTIVE", `status=${jobRow?.status}`);
  check(
    "Job.startedAt was set by this call",
    jobRow?.startedAt instanceof Date && jobRow.startedAt >= callStartedAt,
    `startedAt=${jobRow?.startedAt?.toISOString()}`
  );
  const windowMs =
    jobRow?.startedAt && jobRow?.analysisEndsAt
      ? jobRow.analysisEndsAt.getTime() - jobRow.startedAt.getTime()
      : null;
  check(
    `Job.analysisEndsAt = startedAt + ${READY_PAYLOAD.analysisDays} days`,
    windowMs === READY_PAYLOAD.analysisDays * DAY_IN_MS,
    `window=${windowMs} ms`
  );

  check("exactly one JobQuotaConsumption row for the job", (await countConsumptions(draft.id)) === 1);
  const consumption = await prisma.jobQuotaConsumption.findUnique({ where: { jobId: draft.id } });
  check(
    "the consumption row is charged to the seller's subscription",
    consumption?.subscriptionId === recruiter.subscription.id,
    `consumption.subscriptionId=${consumption?.subscriptionId}`
  );
  check(
    "the subscription's used count is 1",
    (await countConsumptionsBySubscription(recruiter.subscription.id)) === 1
  );

  check("exactly one AiJob row for the job", (await countAiJobs(draft.id)) === 1);
  const aiJob = await prisma.aiJob.findFirst({ where: { jobId: draft.id } });
  check("the AiJob id matches the id Start returned", aiJob?.id === started.aiJob?.id, `${aiJob?.id} vs ${started.aiJob?.id}`);
  check("AiJob.operation = JOB_ANALYSIS", aiJob?.operation === AI_JOB_OPERATION.JOB_ANALYSIS, aiJob?.operation);
  check("AiJob.status = PENDING", aiJob?.status === AI_JOB_STATUS.PENDING, aiJob?.status);
  check(
    "AiJob is untouched by any worker (no result/attempts/worker/timestamps — no fake COMPLETED)",
    aiJob?.result === null &&
      aiJob?.attempts === 0 &&
      aiJob?.startedAt === null &&
      aiJob?.completedAt === null &&
      aiJob?.workerId === null &&
      aiJob?.lastError === null &&
      aiJob?.provider === null &&
      aiJob?.lastEnqueuedAt === null,
    summarize({
      result: aiJob?.result,
      attempts: aiJob?.attempts,
      startedAt: aiJob?.startedAt,
      completedAt: aiJob?.completedAt,
      workerId: aiJob?.workerId,
      lastError: aiJob?.lastError,
      provider: aiJob?.provider,
      lastEnqueuedAt: aiJob?.lastEnqueuedAt,
    })
  );

  check(
    "AiJob.requestPayload is the expected Job snapshot",
    jsonEqual(aiJob?.requestPayload, expectedPayload()),
    `got ${summarize(aiJob?.requestPayload)}`
  );

  const payloadText = JSON.stringify(aiJob?.requestPayload ?? {});
  const forbidden = ["analysisDays", "recruiterId", "organizationId", "createdByUserId", "subscription", "quota", "password", "token", "startedAt"];
  const leaked = forbidden.filter((key) => payloadText.includes(key));
  check(
    "requestPayload excludes analysisDays, ownership, subscription/quota and credential data",
    leaked.length === 0,
    `leaked: ${leaked.join(", ")}`
  );

  check(
    "structured metadata persisted on the job (employmentType/workMode/location)",
    jobRow?.employmentType === READY_PAYLOAD.employmentType &&
      jobRow?.workMode === READY_PAYLOAD.workMode &&
      jobRow?.location === READY_PAYLOAD.location,
    `employmentType=${jobRow?.employmentType}, workMode=${jobRow?.workMode}, location=${jobRow?.location}`
  );

  return { draft, aiJob };
};

// --- scenario 2: the snapshot is historical, not a live reference -----------

const scenarioPayloadImmutability = async (draft) => {
  section("2. Payload snapshot — editing the Job afterwards must not change requestPayload");

  await prisma.job.update({
    where: { id: draft.id },
    data: {
      title: "Renamed After Start",
      description: "Rewritten after the job had already been started.",
      yearsExperience: 12,
    },
  });
  await prisma.jobSkill.deleteMany({ where: { jobId: draft.id } });
  await prisma.jobSkill.create({ data: { jobId: draft.id, name: "Rust", weight: 100, sortOrder: 0 } });

  const editedJob = await prisma.job.findUnique({ where: { id: draft.id }, include: { skills: true } });
  check(
    "the post-Start edit really changed the Job (title + skills)",
    editedJob?.title === "Renamed After Start" &&
      editedJob.skills.length === 1 &&
      editedJob.skills[0].name === "Rust",
    summarize({ title: editedJob?.title, skills: editedJob?.skills.map((skill) => skill.name) })
  );

  const aiJob = await prisma.aiJob.findFirst({ where: { jobId: draft.id } });
  check(
    "AiJob.requestPayload still deep-equals the pre-edit snapshot",
    jsonEqual(aiJob?.requestPayload, expectedPayload()),
    `got ${summarize(aiJob?.requestPayload)}`
  );
  check(
    "the snapshot still names the original title and skills",
    aiJob?.requestPayload?.input?.title === READY_PAYLOAD.title &&
      jsonEqual(aiJob?.requestPayload?.input?.skills, expectedPayload().input.skills),
    summarize({
      title: aiJob?.requestPayload?.input?.title,
      skills: aiJob?.requestPayload?.input?.skills,
    })
  );
};

// --- scenario 3: a rejected Start leaves nothing behind --------------------

const scenarioStartRejectedNotReady = async (recruiter) => {
  section("3. Failed Start (job not ready) — no activation, no quota consumed, no AiJob");

  const draft = await createDraftFixture(recruiter, {
    title: "Incomplete Draft",
    yearsExperience: 3,
    description: "Too short",
    analysisDays: 2,
    skills: [{ name: "Node.js", weight: 100 }],
    tools: [],
    questions: [],
  });

  await expectRejection(
    "an incomplete draft is rejected with 400",
    () => jobService.startJob(recruiter.user, draft.id),
    400
  );

  const jobRow = await prisma.job.findUnique({ where: { id: draft.id } });
  check("the job is still DRAFT", jobRow?.status === "DRAFT", `status=${jobRow?.status}`);
  check("the job has no startedAt / analysisEndsAt", jobRow?.startedAt === null && jobRow?.analysisEndsAt === null);
  check("no JobQuotaConsumption row was created", (await countConsumptions(draft.id)) === 0);
  check("no AiJob row was created", (await countAiJobs(draft.id)) === 0);
};

// --- scenario 4: quota exhaustion is also all-or-nothing -------------------

const scenarioQuotaExhausted = async () => {
  section("4. Failed Start (quota exhausted) — second job stays DRAFT, no AiJob");

  const recruiter = await createRecruiterFixture("quota", 1);

  const first = await createDraftFixture(recruiter);
  await attachJobCandidateList(recruiter, first.id);
  await jobService.startJob(recruiter.user, first.id);
  check(
    "the plan's single quota unit is consumed by the first start",
    (await countConsumptionsBySubscription(recruiter.subscription.id)) === 1
  );

  const second = await createDraftFixture(recruiter);
  // Candidate validation runs BEFORE quota: the 403 below proves the second
  // draft passes the candidate gate and fails on quota only.
  await attachJobCandidateList(recruiter, second.id);
  await expectRejection(
    "starting a second job is rejected with 403",
    () => jobService.startJob(recruiter.user, second.id),
    403
  );

  const jobRow = await prisma.job.findUnique({ where: { id: second.id } });
  check("the second job is still DRAFT", jobRow?.status === "DRAFT", `status=${jobRow?.status}`);
  check("the second job has no consumption row", (await countConsumptions(second.id)) === 0);
  check("the second job has no AiJob", (await countAiJobs(second.id)) === 0);
  check("the first job still has exactly one AiJob", (await countAiJobs(first.id)) === 1);
  check(
    "the subscription still shows exactly one consumption",
    (await countConsumptionsBySubscription(recruiter.subscription.id)) === 1
  );
};

// --- scenario 5: two simultaneous Starts for the same draft -----------------

const scenarioConcurrentStart = async (recruiter) => {
  section("5. Duplicate concurrent Start — one success, one 409, one consumption, one AiJob");

  // The plan limit is loose enough that the loser is stopped by the
  // DRAFT→ACTIVE compare-and-swap (409), not by the quota check (403).
  const draft = await createDraftFixture(recruiter);
  await attachJobCandidateList(recruiter, draft.id);

  const outcomes = await Promise.allSettled([
    jobService.startJob(recruiter.user, draft.id),
    jobService.startJob(recruiter.user, draft.id),
  ]);

  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

  check(
    "exactly one of the two simultaneous starts succeeds",
    fulfilled.length === 1 && rejected.length === 1,
    summarize(outcomes.map((outcome) => outcome.status))
  );
  check(
    "the loser fails with the existing 409 conflict behavior",
    rejected[0]?.reason?.status === 409,
    `${rejected[0]?.reason?.status}: ${rejected[0]?.reason?.message}`
  );
  check(
    "the winner reports an ACTIVE job with a PENDING AiJob",
    fulfilled[0]?.value?.job?.status === "ACTIVE" && fulfilled[0]?.value?.aiJob?.status === "PENDING",
    summarize({ job: fulfilled[0]?.value?.job?.status, aiJob: fulfilled[0]?.value?.aiJob })
  );

  const jobRow = await prisma.job.findUnique({ where: { id: draft.id } });
  check("the job is ACTIVE exactly once", jobRow?.status === "ACTIVE", `status=${jobRow?.status}`);
  check("exactly one JobQuotaConsumption row exists", (await countConsumptions(draft.id)) === 1);
  check("exactly one AiJob row exists", (await countAiJobs(draft.id)) === 1);

  const aiJob = await prisma.aiJob.findFirst({ where: { jobId: draft.id } });
  check(
    "the surviving AiJob is PENDING and holds the correct snapshot",
    aiJob?.status === AI_JOB_STATUS.PENDING && jsonEqual(aiJob?.requestPayload, expectedPayload()),
    summarize({ status: aiJob?.status, operation: aiJob?.operation })
  );
};

// --- scenario 6: an AiJob failure rolls the WHOLE transaction back ----------

const scenarioAiJobFailureRollsBack = async (recruiter) => {
  section("6. Injected AiJob failure — no Job activation, no quota consumption, no real AiJob");

  const draft = await createDraftFixture(recruiter);
  await attachJobCandidateList(recruiter, draft.id);

  // Simulates the one thing that can make the AiJob insert fail: a row already
  // holding @@unique([jobId, operation]) for this job. The database — not a
  // JavaScript check — is what rejects the duplicate.
  const injected = await prisma.aiJob.create({
    data: {
      jobId: draft.id,
      operation: AI_JOB_OPERATION.JOB_ANALYSIS,
      status: AI_JOB_STATUS.PENDING,
      requestPayload: { injectedByHarness: true },
    },
  });

  await expectRejection(
    "Start is rejected with 409 because the AiJob slot is already taken",
    () => jobService.startJob(recruiter.user, draft.id),
    409
  );

  const jobRow = await prisma.job.findUnique({ where: { id: draft.id } });
  check("the DRAFT → ACTIVE transition was rolled back", jobRow?.status === "DRAFT", `status=${jobRow?.status}`);
  check(
    "the startedAt / analysisEndsAt writes were rolled back",
    jobRow?.startedAt === null && jobRow?.analysisEndsAt === null,
    summarize({ startedAt: jobRow?.startedAt, analysisEndsAt: jobRow?.analysisEndsAt })
  );
  check("the quota consumption was rolled back", (await countConsumptions(draft.id)) === 0);
  check("no real AiJob was committed alongside the injected one", (await countAiJobs(draft.id)) === 1);

  const remaining = await prisma.aiJob.findFirst({ where: { jobId: draft.id } });
  check(
    "the only remaining row is the injected one, still PENDING",
    remaining?.id === injected.id && remaining?.status === AI_JOB_STATUS.PENDING,
    summarize({ id: remaining?.id, status: remaining?.status })
  );
};

// ---------------------------------------------------------------------------
// Phase 2 — structured-job Start rules (new jobs, createdAt >= cutoff)
// ---------------------------------------------------------------------------

// Clone READY_PAYLOAD with one scalar field removed (undefined -> cleared in DB).
const withoutField = (payload, field) => {
  const rest = { ...payload };
  delete rest[field];
  return rest;
};

// A DRAFT that satisfies every OLD readiness rule but lacks the required
// structured metadata: it is a NEW job, so Start must now reject it.
const missingStructuredDraft = (field) => withoutField(READY_PAYLOAD, field);

const scenarioStructuredRulesMissingEmploymentType = async (recruiter) => {
  section("7a. NEW job missing employmentType is rejected");
  const draft = await createDraftFixture(recruiter, missingStructuredDraft("employmentType"));
  await attachJobCandidateList(recruiter, draft.id);
  await expectRejection(
    "start is rejected with 400",
    () => jobService.startJob(recruiter.user, draft.id),
    400
  );
};

const scenarioStructuredRulesMissingWorkMode = async (recruiter) => {
  section("7b. NEW job missing workMode is rejected");
  const draft = await createDraftFixture(recruiter, missingStructuredDraft("workMode"));
  await attachJobCandidateList(recruiter, draft.id);
  await expectRejection(
    "start is rejected with 400",
    () => jobService.startJob(recruiter.user, draft.id),
    400
  );
};

const scenarioStructuredRulesHybridNoLocation = async (recruiter) => {
  section("7c. NEW job with HYBRID and no location is rejected");
  const draft = await createDraftFixture(recruiter, {
    ...READY_PAYLOAD,
    workMode: "HYBRID",
    location: undefined,
  });
  await attachJobCandidateList(recruiter, draft.id);
  await expectRejection(
    "start is rejected with 400",
    () => jobService.startJob(recruiter.user, draft.id),
    400
  );
};

const scenarioStructuredRulesOnSiteNoLocation = async (recruiter) => {
  section("7d. NEW job with ON_SITE and no location is rejected");
  const draft = await createDraftFixture(recruiter, {
    ...READY_PAYLOAD,
    workMode: "ON_SITE",
    location: undefined,
  });
  await attachJobCandidateList(recruiter, draft.id);
  await expectRejection(
    "start is rejected with 400",
    () => jobService.startJob(recruiter.user, draft.id),
    400
  );
};

const scenarioStructuredRulesRemoteNoLocationAllowed = async (recruiter) => {
  section("7e. NEW job with REMOTE and no location is allowed to start");
  const draft = await createDraftFixture(recruiter, withoutField(READY_PAYLOAD, "location"));
  // Start also REQUIRES a candidate Excel sheet: attach one through the
  // production upload path, same as the existing Start contract.
  await attachJobCandidateList(recruiter, draft.id);
  const started = await jobService.startJob(recruiter.user, draft.id);
  check(
    "start returns { job, limits } and adds { aiJob }",
    Boolean(started.job && started.aiJob && started.limits),
    summarize({ job: started.job?.id, aiJob: started.aiJob, limits: started.limits })
  );
  check(
    "structured REMOTE metadata is persisted (workMode REMOTE, location NULL)",
    started.job?.workMode === "REMOTE" && started.job?.location === null,
    summarize({ workMode: started.job?.workMode, location: started.job?.location })
  );
};

const scenarioLegacyJobStartsWithNulls = async (recruiter) => {
  section("8. LEGACY job (createdAt < cutoff) with NULL structured fields still starts");
  const draft = await createDraftFixture(recruiter, {
    ...READY_PAYLOAD,
    employmentType: null,
    workMode: null,
    location: null,
  });
  // Backdate to a pre-cutoff createdAt: under the old rules this job must start
  // even though every structured field is NULL.
  await prisma.job.update({
    where: { id: draft.id },
    data: { createdAt: new Date("2026-09-01T00:00:00.000Z") },
  });
  // Legacy jobs still need a candidate list to start (existing rule).
  await attachJobCandidateList(recruiter, draft.id);
  const started = await jobService.startJob(recruiter.user, draft.id);
  check(
    "legacy job with NULL structured fields starts successfully",
    Boolean(started.job && started.aiJob),
    summarize({ job: started.job?.id, aiJob: started.aiJob })
  );
};

const scenarioDraftValidationRules = async () => {
  section("9. Draft validation — structured scalar fields");
  check(
    "invalid employmentType rejected by zod",
    jobValidation.createDraftSchema.safeParse({
      ...READY_PAYLOAD,
      employmentType: "BAILING",
    }).success === false
  );
  check(
    "invalid workMode rejected by zod",
    jobValidation.createDraftSchema.safeParse({
      ...READY_PAYLOAD,
      workMode: "UNKNOWN",
    }).success === false
  );
  check(
    "location longer than 200 characters rejected by zod",
    jobValidation.createDraftSchema.safeParse({
      ...READY_PAYLOAD,
      location: "x".repeat(201),
    }).success === false
  );
  // REMOTE jobs may omit location: the draft schema stays permissive.
  check(
    "REMOTE job without location accepted by zod",
    jobValidation.createDraftSchema.safeParse({
      ...READY_PAYLOAD,
      workMode: "REMOTE",
      location: undefined,
    }).success === true
  );
};

const scenarioStructuredJobCRUDAndRegression = async (recruiter) => {
  section("10. Structured-job CRUD + child-collection coexistence regression");

  const draft = await createDraftFixture(recruiter, {
    ...READY_PAYLOAD,
    employmentType: "PART_TIME",
    workMode: "HYBRID",
    location: "Warsaw, Poland",
    responsibilities: [
      { text: "Qualify new sales leads" },
      { text: "Manage customer relationships" },
    ],
    educationRequirements: [
      { text: "Bachelor's degree in Business" },
    ],
  });
  const loaded = await jobService.getJobForUser(recruiter.user, draft.id);
  check(
    "responsibilities persisted in detail read",
    Array.isArray(loaded.responsibilities) && loaded.responsibilities.length === 2,
    summarize(loaded.responsibilities)
  );
  check(
    "educationRequirements persisted in detail read",
    Array.isArray(loaded.educationRequirements) && loaded.educationRequirements.length === 1,
    summarize(loaded.educationRequirements)
  );
  check(
    "scalar structured fields persisted in detail read",
    loaded.employmentType === "PART_TIME" &&
      loaded.workMode === "HYBRID" &&
      loaded.location === "Warsaw, Poland",
    summarize({ employmentType: loaded.employmentType, workMode: loaded.workMode, location: loaded.location })
  );

  // Replace responsibilities: skills/tools/questions must NOT change.
  const updated = await jobService.updateDraft(recruiter.user, draft.id, {
    responsibilities: [{ text: "Run weekly pipeline reviews" }],
  });
  check(
    "responsibilities replaced on update",
    Array.isArray(updated.responsibilities) &&
      updated.responsibilities.length === 1 &&
      updated.responsibilities[0].text === "Run weekly pipeline reviews",
    summarize(updated.responsibilities)
  );
  check(
    "skills unchanged after responsibility replace",
    Array.isArray(loaded.skills) && loaded.skills.length === 2,
    summarize(loaded.skills.map((s) => s.name))
  );
  check(
    "tools unchanged after responsibility replace",
    Array.isArray(loaded.tools) && loaded.tools.length === 2,
    summarize(loaded.tools.map((t) => t.name))
  );
  check(
    "questions unchanged after responsibility replace",
    Array.isArray(loaded.questions) && loaded.questions.length === 2,
    summarize(loaded.questions.map((q) => q.question))
  );

  // Empty array clears responsibilities.
  const cleared = await jobService.updateDraft(recruiter.user, draft.id, { responsibilities: [] });
  check(
    "responsibilities cleared by empty array",
    Array.isArray(cleared.responsibilities) && cleared.responsibilities.length === 0,
    summarize(cleared.responsibilities)
  );
  check(
    "skills untouched after responsibilities cleared",
    Array.isArray(cleared.skills) && cleared.skills.length === 2,
    summarize(cleared.skills.map((s) => s.name))
  );

  // Replace educationRequirements.
  const eduUpdated = await jobService.updateDraft(recruiter.user, draft.id, {
    educationRequirements: [
      { text: "Master's degree preferred" },
      { text: "3+ years experience" },
    ],
  });
  check(
    "educationRequirements replaced on update",
    Array.isArray(eduUpdated.educationRequirements) &&
      eduUpdated.educationRequirements.length === 2,
    summarize(eduUpdated.educationRequirements.map((e) => e.text))
  );

  // Empty array clears educationRequirements.
  const eduCleared = await jobService.updateDraft(recruiter.user, draft.id, {
    educationRequirements: [],
  });
  check(
    "educationRequirements cleared by empty array",
    Array.isArray(eduCleared.educationRequirements) &&
      eduCleared.educationRequirements.length === 0,
    summarize(eduCleared.educationRequirements)
  );

  // Final read: responsibilities and educationRequirements remain empty,
  // structures coexist with skills/tools/questions, and DRAFT persists.
  const finalLoaded = await jobService.getJobForUser(recruiter.user, draft.id);
  check(
    "job still DRAFT after structured edits",
    finalLoaded.status === "DRAFT",
    `status=${finalLoaded.status}`
  );
  check(
    "responsibilities still empty after clear",
    Array.isArray(finalLoaded.responsibilities) && finalLoaded.responsibilities.length === 0,
    summarize(finalLoaded.responsibilities)
  );
  check(
    "educationRequirements still empty after clear",
    Array.isArray(finalLoaded.educationRequirements) &&
      finalLoaded.educationRequirements.length === 0,
    summarize(finalLoaded.educationRequirements)
  );
  check(
    "skills/tools/questions still present after responsibility education edit",
    Array.isArray(finalLoaded.skills) &&
      finalLoaded.skills.length === 2 &&
      Array.isArray(finalLoaded.tools) &&
      finalLoaded.tools.length === 2 &&
      Array.isArray(finalLoaded.questions) &&
      finalLoaded.questions.length === 2,
    summarize({
      skills: finalLoaded.skills.map((s) => s.name),
      tools: finalLoaded.tools.map((t) => t.name),
      questions: finalLoaded.questions.map((q) => q.question),
    })
  );
};


// ---------------------------------------------------------------------------
// cleanup & report
// ---------------------------------------------------------------------------

// --- cleanup & report -------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
});

// Deletes exactly what this harness created, in FK-safe order: AiJob and
// JobQuotaConsumption reference Job with onDelete: Restrict, and Job references
// User with Restrict, so children go first (JobSkill/JobTool/JobQuestion cascade
// from Job). Every statement is scoped to a tracked id, so pre-existing rows are
// out of reach by construction — this script cannot reset or wipe the database.
const cleanup = async () => {
  const removed = {};

  if (tracked.jobIds.length > 0) {
    // Candidate lists (JobCandidateList + StoredFile + disk content) must be
    // removed BEFORE job rows: the candidateList.jobId FK is Restrict.
    Object.assign(removed, await cleanupJobCandidateLists(prisma, tracked.jobIds));
    const rows = await prisma.aiJob.findMany({ where: { jobId: { in: tracked.jobIds } }, select: { id: true } });
    for (const row of rows) {
      const delivery = await aiJobQueue.findQueuedAiJob(row.id);
      if (delivery) await delivery.remove();
    }
    removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: { in: tracked.jobIds } } })).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
    ).count;
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: tracked.jobIds } } })).count;
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
  if (tracked.userIds.length > 0) {
    removed.user = (await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } })).count;
  }

  return removed;
};

const countLeftovers = async () => {
  const [jobs, aiJobs, consumptions, subscriptions, plans, users] = await Promise.all([
    prisma.job.count({ where: { id: { in: tracked.jobIds } } }),
    prisma.aiJob.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.jobQuotaConsumption.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.subscription.count({ where: { id: { in: tracked.subscriptionIds } } }),
    prisma.subscriptionPlan.count({ where: { id: { in: tracked.planIds } } }),
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
  ]);

  return (
    jobs + aiJobs + consumptions + subscriptions + plans + users +
    (await countCandidateListLeftovers(prisma, tracked.jobIds))
  );
};

const finish = async (before) => {
  section("Cleanup — deleting every row this harness created");

  try {
    console.log(`  deleted: ${summarize(await cleanup())}`);
    check("no harness fixture row is left behind", (await countLeftovers()) === 0);
  } catch (error) {
    check("no harness fixture row is left behind", false, error.message);
  }

  const after = await snapshotTotals();
  console.log(`\nplatform totals at start: ${summarize(before)}`);
  console.log(`platform totals at end:   ${summarize(after)}`);
  check(
    "the database was not reset (every pre-existing row count held or grew)",
    Object.keys(before).every((table) => after[table] >= before[table]),
    summarize({ before, after })
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.log("FAILED CHECKS:");
    failed.forEach((entry) => console.log(`  - ${entry.label}`));
    process.exitCode = 1;
    return;
  }

  console.log("Stage 1 AiJob contract verified: Job ACTIVE + quota consumed once + AiJob PENDING, all in one transaction.");
};

const run = async () => {
  console.log("Stage 1 AiJob verification harness");
  console.log(`run id: ${SUFFIX}`);
  console.log("contract: Job Start → Job ACTIVE + quota consumed exactly once + one AiJob PENDING");
  console.log("scope:    PostgreSQL only — no Redis, no BullMQ, no worker, no AI provider");

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);

  try {
    const recruiter = await createRecruiterFixture("main", 5);
    const { draft } = await scenarioSuccessfulStart(recruiter);
    await scenarioPayloadImmutability(draft);
    await scenarioStartRejectedNotReady(recruiter);
    await scenarioQuotaExhausted();
    await scenarioConcurrentStart(recruiter);
    await scenarioAiJobFailureRollsBack(recruiter);
    await scenarioStructuredRulesMissingEmploymentType(recruiter);
    await scenarioStructuredRulesMissingWorkMode(recruiter);
    await scenarioStructuredRulesHybridNoLocation(recruiter);
    await scenarioStructuredRulesOnSiteNoLocation(recruiter);
    await scenarioStructuredRulesRemoteNoLocationAllowed(recruiter);
    await scenarioLegacyJobStartsWithNulls(recruiter);
    await scenarioDraftValidationRules();
    await scenarioStructuredJobCRUDAndRegression(recruiter);
  } catch (error) {
    console.error("\nUNEXPECTED harness error:", error);
    check("every scenario ran without an unexpected error", false, error.message);
  } finally {
    await finish(before);
  }
};

run()
  .catch((error) => {
    console.error("Harness failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await aiJobQueue.closeAiJobQueue();
    await prisma.$disconnect();
  });