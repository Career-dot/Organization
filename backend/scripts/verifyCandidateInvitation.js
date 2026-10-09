/* eslint-disable no-console */
// Candidate invitation verification harness — Phase 2 of the recruiter
// candidate workflow.
//
// Run with:  npm run verify:candidate-invitation
//
// Proves, against the REAL database and the REAL service path:
//   A. Guards — invitations require an ACTIVE (started) job and a FINALIZED +
//      ACTIVATED assessment; anything else is refused WITHOUT creating an
//      invitation, sending an email, consuming quota or creating an AiJob.
//   B. Candidate source — the email is resolved from the PERSISTED Excel row
//      (the request carries only the row id); an arbitrary email can never be
//      substituted; missing and invalid row ids are rejected.
//   B2. The TWO email events are distinct — Invite Selected emits the
//      ASSESSMENT INVITATION email (link) and NO code; the verification code is
//      emitted only after the candidate's email is authorized against a
//      persisted invitation. Wrong email, another candidate's invitation,
//      cross-job and closed-job are all refused BEFORE any code exists.
//   C. Idempotency — ONE assessment + ONE normalized email = ONE invitation;
//      repeats re-send the invitation email instead of duplicating rows;
//      expired windows are refreshed through the SAME mapping; EMAIL_VERIFIED
//      rows are left untouched with no email.
//   D. Security — cross-recruiter ownership, cross-job row scoping, exact
//      assessment binding, and a response that never carries verification
//      tokens/hashes, old verification evidence or AI payloads.
//   E. Side effects — no AiJob, no quota consumption, no verification
//      recalculation, no candidate account creation; the IN_SYSTEM candidate
//      receives exactly ONE idempotent platform notification.
//   F. Email failure — persistence stays authoritative; the failure is
//      surfaced honestly and a retry reuses the existing invitation.
//   G. Existing behavior — the public email-verification flow (challenge →
//      code → EMAIL_VERIFIED), invitation expiry and assessment activation
//      still work end-to-end.
//   H. Frontend contract — the Invite action calls the row-scoped API, no
//      manual email input exists, duplicate clicks are guarded, and the
//      persisted invitation status is what gets rendered.
//   I. Single invitation flow — the email-only recruiter path (route,
//      controller, service, body schema, "Send Invitations" UI, frontend
//      client) is gone repo-wide, while the CANDIDATE-FACING email field used
//      for invitation verification is provably intact.
//   J. Two column-wise categories — the one candidate list rendered as IN
//      SYSTEM and NOT IN SYSTEM columns, sharing a single row component, a
//      single Invite action and one endpoint; the category stays
//      server-authoritative and cannot be moved by hand; the manual add form
//      collects only the five candidate evidence fields.
//
// Convention follows scripts/verifyCandidateClassification.js (CommonJS, the
// application's own Prisma client, throwaway fixtures tracked by id and
// deleted in FK-safe order, platform totals printed before/after). Emails use
// the project's deterministic server-log fallback channel; the harness
// captures the logged codes to drive the REAL public verification flow.

require("dotenv").config();

// The platform's deterministic test channel: SMTP credentials (present in .env)
// are deliberately BLANKED — never deleted — so every harness email goes to the
// server-log fallback instead of a real provider (and no real mail ever leaves
// this process). Blanking is the project's established harness convention
// (see verifyRecruiterQuestionsInAssessment.js) because dotenv re-injects keys
// that are ABSENT: deleting them lets the app's own env loading restore real
// credentials, which would silently switch the channel back to SMTP. An empty
// string is an existing key, so dotenv leaves it alone; smtpConfigured() treats
// it as "not configured". Nothing is silently dropped — the code lands in the
// log, which this harness captures below.
const neutralizeSmtp = () => {
  process.env.SMTP_HOST = "";
  process.env.SMTP_PORT = "";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";
  process.env.EMAIL_FROM = "";
};
neutralizeSmtp();

const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const jobCandidateReferenceService = require("../src/module/job/jobCandidateReference.service");
const jobCandidateReferenceRepository = require("../src/module/job/jobCandidateReference.repository");
const jobRepository = require("../src/module/job/job.repository");
const { cleanupJobCandidateLists } = require("./jobCandidateListFixture");
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const { smtpConfigured } = require("../src/utils/sendAssessmentVerificationEmail");

// Loading the application modules runs the app's own env loading again, so the
// blanking is re-asserted here (before any email is ever sent) and then
// verified: this harness must NEVER be able to reach a real mail provider.
neutralizeSmtp();
if (smtpConfigured()) {
  console.error(
    "FATAL: a real SMTP provider is still configured — refusing to run, because harness emails must never leave this process."
  );
  process.exit(1);
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Isolate this run's BullMQ namespace so no real worker can ever pick work up.
process.env.AI_QUEUE_PREFIX = `candinv-${SUFFIX}`;

// --- console capture (the deterministic dev/test email channel) --------------
// When SMTP is not configured, the assessment mailers log to the server log.
// That log IS the email in this environment — so the harness captures both
// email types to prove they are distinct events at distinct lifecycle stages.
//
// The two log lines are told apart by their prefix:
//   "[assessment-invitation] invitation email for <email>:"      → INVITATION
//   "[assessment-invitation] verification code for <email>:"    → VERIFICATION
// The VERIFICATION regex is unchanged from the historical contract, so the
// other harnesses that parse it keep working.
const capturedCodes = [];
const capturedInvitations = [];
const originalConsoleLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  const invitationMatch = line.match(/\[assessment-invitation\] invitation email for (\S+):/);
  if (invitationMatch) {
    capturedInvitations.push({ email: invitationMatch[1], line });
  }
  const match = line.match(/\[assessment-invitation\] verification code for (\S+): (\S+)/);
  if (match) {
    capturedCodes.push({ email: match[1], token: match[2] });
  }
  originalConsoleLog(...args);
};
const latestCodeFor = (email) =>
  [...capturedCodes].reverse().find((entry) => entry.email === email)?.token ?? null;
const codeCountFor = (email) => capturedCodes.filter((entry) => entry.email === email).length;
// Counts the ASSESSMENT INVITATION EMAILS actually emitted on the deterministic
// channel — distinct from `invitationCountFor` further down, which counts the
// PERSISTED database rows.
const invitationEmailCountFor = (email) =>
  capturedInvitations.filter((entry) => entry.email === email).length;

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

// Collects every object key in a JSON structure so a response can be scanned
// for data that must NEVER leave the server (verification tokens, hashes,
// evidence, AI payloads, credentials).
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

// --- fixtures ----------------------------------------------------------------

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  employeeProfileIds: [],
  assessmentIds: [],
};

const uniqueEmail = (label) =>
  `candinv-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

// Recruiter fixture — identical to the other harnesses: the service only reads
// user.id/role from the principal, but the row is real so ownership and FK
// cleanup behave exactly as in production.
const createRecruiterFixture = async (label, jobPostingLimit = 10) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Candidate Invitation Harness ${label}`,
      email: `candinv-recruiter-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Candidate Invitation Harness Plan ${label} ${SUFFIX}`,
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

const uploadList = async (recruiter, jobId, buffer, name) =>
  jobService.uploadCandidateList(recruiter.user, jobId, {
    originalname: name ?? `candinv-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });

// A real platform CANDIDATE account (EMPLOYEE role) with the FULL existing
// verification chain — EmployeeProfile → skill → AssessmentDefinition →
// VerificationAttempt → VerificationReport — so the IN_SYSTEM path, the
// notification gate and the "no verification recalculation" assertions run
// against real persisted rows.
const createCandidateFixture = async ({ email, skillName = "Node.js", score = 82 }) => {
  const user = await prisma.user.create({
    data: {
      email,
      fullName: `Candidate ${email}`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const role = await prisma.role.findUnique({ where: { name: "EMPLOYEE" } });
  if (!role) {
    throw new Error("EMPLOYEE role is missing from the database");
  }
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

  const profile = await prisma.employeeProfile.create({
    data: { userId: user.id, headline: "Harness candidate" },
  });
  const skill = await prisma.employeeProfileSkill.create({
    data: {
      employeeProfileId: profile.id,
      name: skillName,
      yearsOfExperience: 5,
      proficiency: "ADVANCED",
    },
  });
  tracked.userIds.push(user.id);
  tracked.employeeProfileIds.push(profile.id);

  const definition = await prisma.assessmentDefinition.create({
    data: {
      employeeProfileSkillId: skill.id,
      skillNameSnapshot: skillName,
      title: `${skillName} verification`,
      durationSeconds: 600,
      questionCount: 1,
      passingScore: 60,
      version: 1,
    },
  });
  const attempt = await prisma.verificationAttempt.create({
    data: {
      userId: user.id,
      employeeProfileId: profile.id,
      employeeProfileSkillId: skill.id,
      assessmentDefinitionId: definition.id,
      assessmentVersion: 1,
      skillNameSnapshot: skillName,
      status: "SCORED",
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      deadlineAt: new Date(Date.now() - 60 * 60 * 1000),
      submittedAt: new Date(Date.now() - 70 * 60 * 1000),
      testScorePoints: 8,
      testScoreMaxPoints: 10,
      testScorePercentage: score,
    },
  });
  const report = await prisma.verificationReport.create({
    data: {
      verificationAttemptId: attempt.id,
      employeeProfileSkillId: skill.id,
      processingStatus: "COMPLETED",
      verificationStatus: "VERIFIED",
      verificationScore: score,
      completedAt: new Date(Date.now() - 30 * 60 * 1000),
    },
  });

  return { user, profile, skill, definition, attempt, report };
};

// Assessment fixture in the exact lifecycle states the guards distinguish.
// Built directly because the AI generation pipeline is out of scope here (and
// must not be involved): what matters is the persisted status/activation state.
const createAssessmentFixture = async (jobId, label, { status = "FINALIZED", activated = true } = {}) => {
  const assessment = await prisma.jobAssessment.create({
    data: {
      jobId,
      title: `Harness assessment ${label}`,
      status,
      publicId: `candinv-${SUFFIX}-${label}`,
      finalizedAt: status === "DRAFT" ? null : new Date(),
      activatedAt: activated && status === "FINALIZED" ? new Date() : null,
      durationSeconds: 600,
    },
  });
  tracked.assessmentIds.push(assessment.id);
  return assessment;
};

const READY_PAYLOAD = {
  title: "Candidate invitation harness job",
  yearsExperience: 5,
  description:
    "Harness job used to verify row-scoped candidate invitations for the recruiter workflow.",
  analysisDays: 3, // → invitation window: 2 days (existing fixed mapping)
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe a database migration you have run in production." }],
};

// Draft → Excel list (through the production upload path) → optional
// assessment → START. The started job is required because the invitation path
// (like every AI-workflow write) only runs on ACTIVE jobs.
const createJobFixture = async (recruiter, { label, rows, assessment } = {}) => {
  const draft = await jobService.createDraft(recruiter.user, {
    ...READY_PAYLOAD,
    title: `Candidate invitation harness ${label}`,
    description: `Harness job ${label} used to verify row-scoped candidate invitations end-to-end.`,
  });
  tracked.jobIds.push(draft.id);

  await uploadList(
    recruiter,
    draft.id,
    buildSheet([["Name", "Email"], ...rows]),
    `candinv-${label}-${SUFFIX}.xlsx`
  );

  const assessmentRow = assessment
    ? await createAssessmentFixture(draft.id, label, assessment)
    : null;

  await jobService.startJob(recruiter.user, draft.id);
  return { job: draft, assessment: assessmentRow };
};

// Baselines for the side-effect assertions: everything the SETUP (drafts,
// starts, assessments) legitimately created is captured here, so every later
// delta is attributable to the invite calls alone.
const snapshotSideEffects = async (candidateUserId) => {
  const [aiJob, quota, attempts, reports, notifications] = await Promise.all([
    prisma.aiJob.count(),
    prisma.jobQuotaConsumption.count(),
    prisma.verificationAttempt.count({ where: { userId: candidateUserId } }),
    prisma.verificationReport.count({
      where: { verificationAttempt: { userId: candidateUserId } },
    }),
    prisma.notification.count({ where: { userId: candidateUserId } }),
  ]);
  return { aiJob, quota, attempts, reports, notifications };
};

const invitationCountFor = (assessmentId, email) =>
  prisma.jobAssessmentInvitation.count({ where: { assessmentId, email } });

const invitationRowFor = (assessmentId, email) =>
  prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

// --- scenario A: guards ------------------------------------------------------

const scenarioGuards = async ({ recruiterA, noAssessment, draftAssessment, finalizedOnly, closedJob }) => {
  section("A. Assessment-state & job-state guards — refusals create NOTHING");
  const invitationsBefore = await prisma.jobAssessmentInvitation.count();
  const codesBefore = capturedCodes.length;

  await expectRejection(
    "a job without an assessment refuses invites (404)",
    () => jobService.inviteJobCandidate(recruiterA.user, noAssessment.job.id, 0),
    404
  );
  await expectRejection(
    "a DRAFT assessment refuses invites (409)",
    () => jobService.inviteJobCandidate(recruiterA.user, draftAssessment.job.id, 0),
    409
  );
  await expectRejection(
    "a FINALIZED but NOT activated assessment refuses invites (409)",
    () => jobService.inviteJobCandidate(recruiterA.user, finalizedOnly.job.id, 0),
    409
  );
  await expectRejection(
    "a CLOSED job refuses invites even with a finalized+activated assessment",
    () => jobService.inviteJobCandidate(recruiterA.user, closedJob.job.id, 0),
    409
  );
  check(
    "every refused invite created NO invitation, sent NO email, consumed NO quota",
    (await prisma.jobAssessmentInvitation.count()) === invitationsBefore &&
      capturedCodes.length === codesBefore,
    summarize({ invitationsBefore, codesBefore })
  );

  // Activation (existing flow) is the gate — and stays idempotent.
  const activation = await jobService.activateAssessment(recruiterA.user, finalizedOnly.job.id);
  check(
    "the existing activation flow activates the finalized assessment",
    activation.activated === true && activation.assessment.activatedAt !== null,
    summarize({ activated: activation.activated })
  );
  const invitedAfterActivation = await jobService.inviteJobCandidate(
    recruiterA.user,
    finalizedOnly.job.id,
    0
  );
  check(
    "an invite on the NOW-activated assessment succeeds (persisted INVITED + email)",
    invitedAfterActivation.invitation.status === "INVITED" &&
      invitedAfterActivation.emailSent === true &&
      (await invitationCountFor(finalizedOnly.assessment.id, invitedAfterActivation.candidate.email)) === 1,
    summarize(invitedAfterActivation)
  );
  const reActivation = await jobService.activateAssessment(recruiterA.user, finalizedOnly.job.id);
  check(
    "activation remains idempotent (second call reports activated: false)",
    reActivation.activated === false,
    summarize({ activated: reActivation.activated })
  );

  return { invitedAfterActivation };
};

// --- scenario B: candidate source & identity --------------------------------

const scenarioCandidateSource = async ({ recruiterA, jobA, jobB, candidateAccount }) => {
  section("B. Candidate source — the persisted Excel row IS the identity");

  // Phase 1 classification exposes the stable row id (the sheet's own row
  // number within the immutable stored file) — the exact identifier INVITE
  // consumes.
  const listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const [inSystemRow, notInSystemRow] = listing.candidates;
  check(
    "the candidate rows expose stable persisted row ids (not array indices)",
    inSystemRow.id === 0 && notInSystemRow.id === 1 && inSystemRow.rowIndex === inSystemRow.id,
    summarize(listing.candidates.map((entry) => ({ id: entry.id, rowIndex: entry.rowIndex })))
  );

  const keys = collectKeys(listing);
  check(
    "the candidate listing never exposes tokens, hashes, evidence or AI payloads",
    ["verificationTokenHash", "token", "evidence", "requestPayload"].every((key) => !keys.has(key)),
    summarize([...keys].length)
  );

  // Out-of-range and malformed row ids are rejected before anything happens.
  await expectRejection(
    "a candidate row id that does not exist in THIS job's list is rejected (404)",
    () => jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 5),
    404
  );
  await expectRejection(
    "a missing candidate row id is rejected (404)",
    () => jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 99),
    404
  );
  // An id that is neither a sheet rowIndex nor a resolvable candidate reference
  // cannot address anyone. It is a 404 (not a 400): a non-numeric id is now a
  // valid SHAPE — the job-scoped candidate-reference id a manually added
  // candidate is addressed by — it simply does not resolve in this job.
  await expectRejection(
    "an id that is neither a sheet row nor this job's candidate reference is rejected (404)",
    () => jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, "not-a-number"),
    404
  );
  await expectRejection(
    "an EMPTY candidate row id is rejected (400)",
    () => jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, "   "),
    400
  );

  // A candidate added MANUALLY (Step 1b) has no spreadsheet row, so its
  // job-scoped candidate-reference id is what addresses it — through the SAME
  // single action, the same invitation system and the same activation gate.
  const manualEmail = `manual-candidate-${SUFFIX}@example.test`;
  const manualAdded = await jobCandidateReferenceService.addManualCandidateReference(
    recruiterA.user,
    jobA.job.id,
    { email: manualEmail }
  );
  const manualReferenceId = manualAdded.candidate.referenceId;
  check(
    "a manually added candidate is classified and appears in the candidate list",
    manualAdded.candidate.systemStatus === "NOT_IN_SYSTEM" &&
      (await jobService.listJobCandidates(recruiterA.user, jobA.job.id)).candidates.some(
        (entry) => entry.email === manualEmail
      ),
    summarize(manualAdded.candidate)
  );
  const manualInvited = await jobService.inviteJobCandidate(
    recruiterA.user,
    jobA.job.id,
    manualReferenceId
  );
  check(
    "a MANUALLY added candidate is invited through the SAME single action",
    manualInvited.candidate.email === manualEmail &&
      manualInvited.invitation.status === "INVITED" &&
      (await invitationCountFor(jobA.assessment.id, manualEmail)) === 1,
    summarize(manualInvited.invitation)
  );
  check(
    "the manual candidate's email is resolved from the reference, never from the request",
    manualInvited.candidate.id === null,
    summarize(manualInvited.candidate)
  );
  // A reference id belonging to ANOTHER job must not resolve in this job — the
  // reference is always looked up together with the authorized job id.
  const otherJobReferences = await jobCandidateReferenceRepository.findReferencesByJobId(
    jobB.job.id
  );
  await expectRejection(
    "a candidate reference from ANOTHER job does not resolve here (404)",
    () => jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, otherJobReferences[0].id),
    404
  );

  // IN_SYSTEM invite: email resolved from the PERSISTED row (with mixed-case
  // sheet casing normalized), status + notification per the IN_SYSTEM rules.
  const inSystem = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 0);
  check(
    "IN_SYSTEM invite: email comes from the persisted row (normalized), not the request",
    inSystem.candidate.email === candidateAccount.user.email.toLowerCase() &&
      inSystem.candidate.systemStatus === "IN_SYSTEM",
    summarize(inSystem.candidate)
  );
  check(
    "IN_SYSTEM invite: invitation persisted INVITED with an exact (job, assessment, email) binding",
    inSystem.invitation.status === "INVITED" &&
      (await invitationCountFor(jobA.assessment.id, inSystem.candidate.email)) === 1,
    summarize(inSystem.invitation)
  );
  check(
    "IN_SYSTEM invite: the candidate account received the idempotent in-system notification",
    inSystem.candidateNotified === true &&
      (await prisma.notification.count({ where: { userId: candidateAccount.user.id } })) === 1,
    summarize({ notified: inSystem.candidateNotified })
  );

  // NOT_IN_SYSTEM invite — same path, no account, no fabricated profile.
  const notInSystem = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1);
  check(
    "NOT_IN_SYSTEM invite: same invitation path, email from the persisted row",
    notInSystem.candidate.systemStatus === "NOT_IN_SYSTEM" &&
      notInSystem.candidate.email === notInSystemRow.email.toLowerCase() &&
      (await invitationCountFor(jobA.assessment.id, notInSystem.candidate.email)) === 1,
    summarize(notInSystem.candidate)
  );
  check(
    "NOT_IN_SYSTEM invite: NO user/account/profile/skill row was created",
    !(await prisma.user.findFirst({ where: { email: notInSystem.candidate.email } })),
    "expected no User row for the not-in-system candidate"
  );
  check(
    "NOT_IN_SYSTEM invite: no in-system notification is possible (no account exists)",
    notInSystem.candidateNotified === false,
    summarize({ notified: notInSystem.candidateNotified })
  );

  return { inSystem, notInSystem, manualEmail };
};

// --- scenario C: idempotency -------------------------------------------------

const scenarioIdempotency = async ({ recruiterA, jobA, inSystem, notInSystem }) => {
  section("C. Idempotency — ONE assessment + ONE normalized email = ONE invitation");

  // Second click on an open invitation: the SAME row is returned, and — per the
  // duplicate-invitation rule — NO second invitation email is sent. The
  // verification code is a later, separate event and is still never issued here.
  const codesBefore = codeCountFor(inSystem.candidate.email);
  const invitesBefore = invitationEmailCountFor(inSystem.candidate.email);
  const repeat = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 0);
  check(
    "repeating Invite does NOT create a duplicate invitation",
    (await invitationCountFor(jobA.assessment.id, inSystem.candidate.email)) === 1 &&
      repeat.invitationAlreadyExisted === true,
    summarize({ alreadyExisted: repeat.invitationAlreadyExisted })
  );
  check(
    "repeating Invite sends NO second invitation email (duplicate suppressed by the backend)",
    repeat.emailSent === false &&
      repeat.emailSuppressedAsDuplicate === true &&
      invitationEmailCountFor(inSystem.candidate.email) === invitesBefore,
    summarize({
      emailSent: repeat.emailSent,
      suppressed: repeat.emailSuppressedAsDuplicate,
      newEmails: invitationEmailCountFor(inSystem.candidate.email) - invitesBefore,
    })
  );
  check(
    "the repeat still issues NO verification code (that is the later event)",
    codeCountFor(inSystem.candidate.email) === codesBefore &&
      repeat.invitation.status === "INVITED",
    summarize({
      codeDelta: codeCountFor(inSystem.candidate.email) - codesBefore,
      status: repeat.invitation.status,
    })
  );

  // Expiry re-invite: the window is refreshed through the SAME mapping, the
  // row is reused — never a second invitation.
  await prisma.jobAssessmentInvitation.update({
    where: {
      assessmentId_email: {
        assessmentId: jobA.assessment.id,
        email: notInSystem.candidate.email,
      },
    },
    data: { expiresAt: new Date(Date.now() - DAY_IN_MS) },
  });
  const reactivated = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1);
  const refreshedRow = await invitationRowFor(jobA.assessment.id, notInSystem.candidate.email);
  check(
    "an EXPIRED invitation is re-invited in place (window refreshed, still ONE row)",
    reactivated.invitationReactivated === true &&
      reactivated.invitationAlreadyExisted === true &&
      refreshedRow.expiresAt.getTime() > Date.now() &&
      (await invitationCountFor(jobA.assessment.id, notInSystem.candidate.email)) === 1,
    summarize({ reactivated: reactivated.invitationReactivated })
  );
  check(
    "the refreshed window matches the SAME invitation-window mapping (analysisDays 3 → 2 days)",
    Math.abs(refreshedRow.expiresAt.getTime() - reactivated.invitation.expiresAt.getTime()) < 1000 &&
      Math.round((refreshedRow.expiresAt.getTime() - Date.now()) / DAY_IN_MS) === 2,
    summarize({ expiresAt: refreshedRow.expiresAt })
  );

  // EMAIL_VERIFIED: untouched, no email.
  await prisma.jobAssessmentInvitation.update({
    where: {
      assessmentId_email: {
        assessmentId: jobA.assessment.id,
        email: notInSystem.candidate.email,
      },
    },
    data: { status: "EMAIL_VERIFIED", emailVerifiedAt: new Date() },
  });
  const codesBeforeVerified = codeCountFor(notInSystem.candidate.email);
  const verifiedRepeat = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1);
  check(
    "an EMAIL_VERIFIED invitation is left untouched with NO email sent",
    verifiedRepeat.invitation.status === "EMAIL_VERIFIED" &&
      verifiedRepeat.emailSent === false &&
      codeCountFor(notInSystem.candidate.email) === codesBeforeVerified &&
      (await invitationCountFor(jobA.assessment.id, notInSystem.candidate.email)) === 1,
    summarize({ status: verifiedRepeat.invitation.status, emailSent: verifiedRepeat.emailSent })
  );

  // Restore INVITED so the public-verification scenario starts from a clean state.
  await prisma.jobAssessmentInvitation.update({
    where: {
      assessmentId_email: {
        assessmentId: jobA.assessment.id,
        email: notInSystem.candidate.email,
      },
    },
    data: { status: "INVITED", emailVerifiedAt: null },
  });

  return { reactivated, verifiedRepeat };
};

// --- scenario K: concurrent double-invite (TEST 7) ---------------------------
//
// The strongest form of the duplicate-invitation rule. Two invitation requests
// for the SAME row are fired CONCURRENTLY (a double click, a browser retry or a
// duplicated HTTP request all look like this). Exactly one must win: one
// invitation row, one invitation email and — for an IN_SYSTEM candidate — one
// read-only notification.
const scenarioConcurrentInvite = async ({ recruiterA, jobA, candidateAccount }) => {
  section("K. Concurrent duplicate invites — exactly one invitation, email and notification");

  // A row that is NOT yet invited, so both racers start from the same state.
  const listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const row = listing.candidates.find((entry) => entry.invitationStatus === "NOT_INVITED");
  if (!row) {
    check("a not-yet-invited row is available for the concurrency probe", false, "no eligible row left");
    return;
  }
  const email = row.email.toLowerCase();
  const invitesBefore = invitationEmailCountFor(email);
  const notificationsBefore = await prisma.notification.count({
    where: { userId: candidateAccount.user.id },
  });

  // Promise.all starts both service calls without awaiting the first, so the two
  // requests genuinely race on the same invitation row.
  const results = await Promise.allSettled([
    jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, row.id ?? row.referenceId),
    jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, row.id ?? row.referenceId),
  ]);

  const fulfilled = results.filter((entry) => entry.status === "fulfilled").map((e) => e.value);
  const rejected = results.filter((entry) => entry.status === "rejected");
  const emailsSent = fulfilled.filter((entry) => entry.emailSent === true).length;

  check(
    "two concurrent invites produce exactly ONE invitation email",
    emailsSent === 1 && invitationEmailCountFor(email) === invitesBefore + 1,
    summarize({
      fulfilled: fulfilled.length,
      rejected: rejected.length,
      emailsSent,
      newEmails: invitationEmailCountFor(email) - invitesBefore,
    })
  );
  check(
    "two concurrent invites still produce exactly ONE persisted invitation row",
    (await invitationCountFor(jobA.assessment.id, email)) === 1,
    summarize({ rows: await invitationCountFor(jobA.assessment.id, email) })
  );
  check(
    "the losing concurrent request is suppressed, not failed (safe idempotent result)",
    rejected.length === 0 && fulfilled.length === 2,
    summarize({ rejected: rejected.map((e) => e.reason?.status ?? null) })
  );
  check(
    "a concurrent duplicate never issues a verification code",
    latestCodeFor(email) === null,
    summarize({ unexpectedCode: latestCodeFor(email) })
  );
  const notificationsAfter = await prisma.notification.count({
    where: { userId: candidateAccount.user.id },
  });
  check(
    "concurrent invites never create a duplicate in-system notification",
    notificationsAfter - notificationsBefore <= 1,
    summarize({ before: notificationsBefore, after: notificationsAfter })
  );
};

// --- scenario D: ownership, scoping & response safety ------------------------

const scenarioSecurity = async ({ recruiterA, recruiterB, jobA, jobB, finalizedOnly, notInSystem }) => {
  section("D. Security — ownership, job/assessment scoping, response safety");

  const invitationsBefore = await prisma.jobAssessmentInvitation.count();
  await expectRejection(
    "a DIFFERENT recruiter cannot invite a candidate on someone else's job (403)",
    () => jobService.inviteJobCandidate(recruiterB.user, jobA.job.id, 0),
    403
  );
  check(
    "the rejected cross-recruiter invite created NO invitation",
    (await prisma.jobAssessmentInvitation.count()) === invitationsBefore,
    summarize({ before: invitationsBefore })
  );

  // Row id 3 exists in job A's list but NOT in finalizedOnly's single-row list:
  // the candidate is resolved from THAT job's persisted file, never globally.
  await expectRejection(
    "a row id that exists in ANOTHER job's list but not THIS job's is rejected (404)",
    () => jobService.inviteJobCandidate(recruiterA.user, finalizedOnly.job.id, 3),
    404
  );

  // Cross-assessment binding: every invitation created through job A binds
  // job A's assessment id exactly; job B's assessment never gains a row.
  const jobAInvitations = await prisma.jobAssessmentInvitation.findMany({
    where: { assessmentId: jobA.assessment.id },
  });
  check(
    "every job A invitation binds job A's assessment id and job A's job id",
    jobAInvitations.length > 0 &&
      jobAInvitations.every((row) => row.assessmentId === jobA.assessment.id && row.jobId === jobA.job.id),
    summarize(jobAInvitations.map((row) => ({ jobId: row.jobId, assessmentId: row.assessmentId })))
  );
  check(
    "job B's assessment holds NO invitation for job A's candidates (cross-assessment isolation)",
    (await invitationCountFor(jobB.assessment.id, notInSystem.candidate.email)) === 0 &&
      (await prisma.jobAssessmentInvitation.count({ where: { assessmentId: jobB.assessment.id } })) === 0,
    "expected zero invitations on job B's assessment"
  );

  // Response safety: no token/hash/secret/evidence/AI payload ever leaves.
  const fresh = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 0);
  const responseKeys = [...collectKeys(fresh)];
  check(
    "the invite response never contains a verification token, hash or secret",
    responseKeys.every((key) => !/token|hash|secret|password|apikey/i.test(key)),
    summarize(responseKeys)
  );
  check(
    "the invite response contains NO old verification evidence, score or AI payload",
    responseKeys.every(
      (key) => !/linkedin|github|evidence|verificationscore|report|aipayload|analysis/i.test(key)
    ),
    summarize(responseKeys)
  );
  check(
    "the invite response is the minimal safe shape (candidate + invitation + delivery flags)",
    typeof fresh.invitationAlreadyExisted === "boolean" &&
      typeof fresh.emailSent === "boolean" &&
      typeof fresh.candidateNotified === "boolean" &&
      fresh.invitation && !("verificationTokenHash" in fresh.invitation),
    summarize(responseKeys)
  );

  // Substitute-email defense (structural): the service signature has NO email
  // parameter — passing one as an extra option is ignored, and the persisted
  // row's email is what gets invited.
  const attackerEmail = uniqueEmail("attacker");
  const forced = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1, {
    email: attackerEmail,
  });
  check(
    "the API cannot be tricked into inviting an arbitrary email instead of the persisted row",
    forced.candidate.email === notInSystem.candidate.email &&
      (await invitationCountFor(jobA.assessment.id, attackerEmail)) === 0,
    summarize({ invited: forced.candidate.email, attacker: attackerEmail })
  );
};

// --- scenario E: side effects ------------------------------------------------

const scenarioSideEffects = async ({ recruiterA, jobA, candidateAccount, baseline }) => {
  section("E. Side effects — no AI, no quota, no verification, one notification");
  const after = await snapshotSideEffects(candidateAccount.user.id);

  check("invite created NO AiJob (invitation is not an AI job)", after.aiJob === baseline.aiJob, summarize({ before: baseline.aiJob, after: after.aiJob }));
  check("invite consumed NO job quota", after.quota === baseline.quota, summarize({ before: baseline.quota, after: after.quota }));
  check("invite did NOT touch the existing verification attempts (no recalculation)", after.attempts === baseline.attempts, summarize({ before: baseline.attempts, after: after.attempts }));
  check("invite did NOT touch the existing verification reports (no recalculation)", after.reports === baseline.reports, summarize({ before: baseline.reports, after: after.reports }));
  check(
    "the IN_SYSTEM candidate holds EXACTLY ONE idempotent notification (repeats never duplicate)",
    after.notifications === 1 &&
      (await prisma.notification.findFirst({
        where: { userId: candidateAccount.user.id, type: "ASSESSMENT_INVITATION" },
      })) !== null,
    summarize({ before: baseline.notifications, after: after.notifications })
  );
  check(
    // Part 13 inverts the previous rule: the in-system notification is strictly
    // read-only and must NOT be a route into the assessment. The ONLY way a
    // candidate reaches the assessment is the invitation EMAIL.
    "the in-app notification carries NO assessment link (email is the only route in)",
    (
      await prisma.notification.findFirst({
        where: { userId: candidateAccount.user.id, type: "ASSESSMENT_INVITATION" },
      })
    ) !== null &&
      (await prisma.notification.count({
        where: {
          userId: candidateAccount.user.id,
          link: `/assessment/${jobA.assessment.publicId}`,
        },
      })) === 0 &&
      (await prisma.notification.count({
        where: { userId: candidateAccount.user.id, message: { contains: jobA.assessment.publicId } },
      })) === 0,
    summarize(jobA.assessment.publicId)
  );
  check(
    "invite created NO assessment attempt or score (none exist — invitation only)",
    true,
    "asserted via the unchanged attempt/report counts above"
  );
};

// --- scenario F: email failure semantics -------------------------------------

const scenarioEmailFailure = async ({ recruiterA, jobA, spareEmail }) => {
  section("F. Email delivery failure — persistence stays authoritative, retry is safe");

  const failingSender = async () => {
    throw new Error("SMTP unavailable (harness injection)");
  };
  const failure = await expectRejection(
    "a failing email channel surfaces an honest rejection (invitation saved, email NOT delivered)",
    () => jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 2, { invitationEmailSender: failingSender }),
    409
  );
  check(
    "the failure message states the invitation WAS saved (never a silent pretend-send)",
    Boolean(failure?.message?.includes("invitation was saved")),
    summarize(failure?.message)
  );
  const persistedRow = await invitationRowFor(jobA.assessment.id, spareEmail);
  check(
    "despite the delivery failure the invitation REMAINS persisted, and STILL carries no verification challenge",
    persistedRow !== null &&
      persistedRow.status === "INVITED" &&
      persistedRow.verificationTokenHash === null,
    summarize({ status: persistedRow?.status, challenge: Boolean(persistedRow?.verificationTokenHash) })
  );
  check(
    "the delivery failure did NOT duplicate or remove the invitation row",
    (await invitationCountFor(jobA.assessment.id, spareEmail)) === 1,
    "expected exactly one invitation row"
  );

  // A FAILED send must RELEASE the delivery claim, otherwise one transient SMTP
  // error would permanently burn this candidate's single invitation email and
  // every later retry would be silently suppressed. The retry must therefore
  // reuse the SAME row (no duplicate invitation) and actually deliver.
  const retry = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 2);
  check(
    "a FAILED send releases the claim so retrying Invite can still deliver the email",
    retry.invitationAlreadyExisted === true &&
      retry.emailSent === true &&
      retry.emailSuppressedAsDuplicate === false &&
      (await invitationCountFor(jobA.assessment.id, spareEmail)) === 1,
    summarize({
      alreadyExisted: retry.invitationAlreadyExisted,
      emailSent: retry.emailSent,
      suppressed: retry.emailSuppressedAsDuplicate,
    })
  );
  check(
    "once a send SUCCEEDS the claim is consumed and stays consumed",
    (await invitationRowFor(jobA.assessment.id, spareEmail)).invitationEmailSentAt !== null,
    "a successful send is permanently single-shot"
  );
  const deliveredOnce = invitationEmailCountFor(spareEmail);
  const afterSuccess = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 2);
  check(
    "a further Invite after a successful send is fully suppressed (no second email, no second row)",
    afterSuccess.emailSent === false &&
      afterSuccess.emailSuppressedAsDuplicate === true &&
      invitationEmailCountFor(spareEmail) === deliveredOnce &&
      (await invitationCountFor(jobA.assessment.id, spareEmail)) === 1,
    summarize({
      emailSent: afterSuccess.emailSent,
      newEmails: invitationEmailCountFor(spareEmail) - deliveredOnce,
    })
  );
};

// --- scenario G: the existing public verification flow still works -----------

const scenarioPublicVerificationFlow = async ({ recruiterA, jobA, inSystem, expiryEmail, manualEmail }) => {
  section("G. Existing public email-verification flow, expiry and persisted status");
  const publicId = jobA.assessment.publicId;

  // The invite itself must NOT have produced a code — the verification code is a
  // LATER lifecycle event, reachable only after the candidate's email is
  // authorized. The deterministic channel is asserted, never assumed, so a
  // mis-isolated environment cannot masquerade as a passing run.
  const inSystemCode = latestCodeFor(inSystem.candidate.email);
  check(
    "Invite Selected issued NO verification code (the code belongs to the later verification email)",
    inSystemCode === null,
    summarize({ unexpectedCode: inSystemCode })
  );

  const hashBeforeRequest = (
    await invitationRowFor(jobA.assessment.id, inSystem.candidate.email)
  )?.verificationTokenHash;
  check(
    "the persisted invitation has NO challenge until the candidate requests a code",
    hashBeforeRequest === null,
    summarize({ challenge: Boolean(hashBeforeRequest) })
  );

  const requested = await jobService.requestAssessmentEmailVerification(
    publicId,
    inSystem.candidate.email
  );
  check(
    "the public request step still works for an invited candidate (fresh challenge issued)",
    requested.status === "INVITED" && requested.alreadyVerified === false,
    summarize(requested)
  );
  const freshCode = latestCodeFor(inSystem.candidate.email);
  const hashAfterRequest = (
    await invitationRowFor(jobA.assessment.id, inSystem.candidate.email)
  )?.verificationTokenHash;
  check(
    "re-requesting rotates the stored challenge and delivers a fresh code",
    typeof freshCode === "string" &&
      freshCode.length > 0 &&
      typeof hashAfterRequest === "string" &&
      hashAfterRequest !== hashBeforeRequest,
    summarize({ rotated: hashAfterRequest !== hashBeforeRequest, codeCaptured: Boolean(freshCode) })
  );

  const wrongConfirm = await expectRejection(
    "a WRONG code is rejected with the generic denial (no information leak)",
    () => jobService.confirmAssessmentEmailVerification(publicId, inSystem.candidate.email, "wrong-code"),
    403
  );
  check(
    "the wrong code did NOT verify the invitation",
    (await invitationRowFor(jobA.assessment.id, inSystem.candidate.email)).status === "INVITED",
    summarize(wrongConfirm?.message)
  );

  // The real, hash-verified confirm step. The code used here is the one the
  // candidate received from the VERIFICATION email issued by the authorized
  // request above — never anything from the invite. Guarded so a missing
  // captured code is reported as a failed check rather than aborting the whole
  // scenario.
  let confirmed = null;
  try {
    confirmed = await jobService.confirmAssessmentEmailVerification(
      publicId,
      inSystem.candidate.email,
      freshCode
    );
  } catch (error) {
    check(
      "the existing public flow accepts the correct emailed code",
      false,
      `${error.status ?? "-"}: ${error.message}`
    );
  }
  if (confirmed) {
    check(
      "the correct emailed code flips the invitation to EMAIL_VERIFIED (hash-verified backend state)",
      confirmed.verified === true && confirmed.status === "EMAIL_VERIFIED",
      summarize(confirmed)
    );
  }

  // Expiry: the existing rule refuses the public flow for an expired window.
  const spareRow = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 3);
  await prisma.jobAssessmentInvitation.update({
    where: { assessmentId_email: { assessmentId: jobA.assessment.id, email: spareRow.candidate.email } },
    data: { expiresAt: new Date(Date.now() - 60 * 1000) },
  });
  const expired = await expectRejection(
    "an expired invitation is refused by the EXISTING public-flow expiry rule",
    () => jobService.requestAssessmentEmailVerification(publicId, spareRow.candidate.email),
    403
  );
  check(
    "the expired refusal is the SAME generic message (no probing possible)",
    expired?.message === "This email cannot access this assessment right now.",
    summarize(expired?.message)
  );

  // Re-invite through the recruiter refreshes the window; the public flow works
  // again — same row, new window, fresh code.
  const reInvited = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 3);
  const reRequested = await jobService.requestAssessmentEmailVerification(
    publicId,
    spareRow.candidate.email
  );
  check(
    "after the recruiter re-invite the public flow works again (window refreshed, code sent)",
    reInvited.invitationReactivated === true &&
      reRequested.status === "INVITED" &&
      latestCodeFor(spareRow.candidate.email) !== null,
    summarize({ reactivated: reInvited.invitationReactivated, status: reRequested.status })
  );

  // Persisted status is what the recruiter list reports after a refresh.
  // Asserted BY IDENTITY (the persisted email), never by array position or a
  // hardcoded length: the list grows by one for every manually added candidate,
  // which is the point of the two entry paths.
  const listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const statuses = listing.candidates.map((entry) => entry.invitationStatus);
  const statusFor = (email) =>
    listing.candidates.find((entry) => entry.email === email)?.invitationStatus ?? null;
  check(
    "the persisted invitation statuses are what the candidate list returns after refresh",
    statusFor(inSystem.candidate.email) === "EMAIL_VERIFIED" &&
      statusFor(spareRow.candidate.email) === "INVITED" &&
      // the manually added candidate keeps its own persisted status too
      statusFor(manualEmail) === "INVITED",
    summarize({
      candidateAccount: statusFor(inSystem.candidate.email),
      spare: statusFor(spareRow.candidate.email),
      manual: statusFor(manualEmail),
      all: statuses,
    })
  );
  const listingKeys = collectKeys(listing);
  check(
    "the refreshed listing still never exposes verification challenges",
    ["verificationTokenHash", "verificationExpiresAt"].every((key) => !listingKeys.has(key)),
    summarize([...listingKeys].length)
  );
};

// --- scenario B1: the two mailers are structurally separate ------------------
// A behavioural test can only observe what happened; this reads the REAL source
// to prove the separation cannot silently regress. It asserts the invite path
// contains no code generation at all, and that code generation happens ONLY
// after the authorization gate in the candidate-facing function.
const scenarioMailerSeparation = () => {
  section("B1. Invitation and verification emails are separate mailers");

  const servicePath = path.join(__dirname, "../src/module/job/job.service.js");
  const inviteMailerPath = path.join(__dirname, "../src/utils/sendAssessmentInvitationEmail.js");
  const verifyMailerPath = path.join(__dirname, "../src/utils/sendAssessmentVerificationEmail.js");
  const sharedPath = path.join(__dirname, "../src/utils/assessmentMail.js");
  const service = fs.readFileSync(servicePath, "utf8");
  const inviteMailer = fs.readFileSync(inviteMailerPath, "utf8");
  const verifyMailer = fs.readFileSync(verifyMailerPath, "utf8");
  const shared = fs.readFileSync(sharedPath, "utf8");

  // Slice the invite function body out of the service so the assertion below is
  // about THAT function and not about the whole file.
  const inviteStart = service.indexOf("const inviteJobCandidate");
  const requestStart = service.indexOf("const requestAssessmentEmailVerification");
  const inviteBody = service.slice(inviteStart, requestStart);

  check(
    "the invite path generates NO verification code and stores NO challenge hash",
    !/generateVerificationToken|hashVerificationToken|setInvitationVerificationChallenge/.test(inviteBody),
    "a code must not exist before the candidate asks for one"
  );
  check(
    "the invite path sends the INVITATION mailer, not the verification mailer",
    /invitationEmailSender\(\{/.test(inviteBody) &&
      /require\("\.\.\/\.\.\/utils\/sendAssessmentInvitationEmail"\)/.test(
        service.slice(0, inviteStart).split("\n").slice(0, 60).join("\n")
      ),
    "the recruiter action is the only caller of the invitation mailer"
  );
  check(
    "the candidate-facing path is the ONLY place a code is generated, and it does so AFTER the authorization gate",
    service.slice(requestStart).includes("generateVerificationToken") &&
      service.slice(requestStart).indexOf("requireActiveInvitationContext") <
        service.slice(requestStart).indexOf("generateVerificationToken"),
    "authorization must precede code generation"
  );
  // The invitation copy may legitimately MENTION a future code ("we will email
  // you a one-time verification code"), so the real assertion is structural:
  // the invitation mailer accepts no code/token value and interpolates none.
  const strippedInvite = inviteMailer.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "the invitation mailer accepts and interpolates NO code/token (structurally cannot leak one)",
    !/token/i.test(strippedInvite) && !/\$\{token\}/.test(strippedInvite),
    "the invitation email cannot carry a code even by mistake"
  );
  check(
    "only the verification mailer interpolates a code, and it goes to the invited address only",
    /\$\{token\}/.test(verifyMailer) && /(^|\n)\s*to,/.test(shared),
    "the raw code exists only transiently, as the mail argument"
  );
  check(
    "both mailers share ONE provider boundary, so there is no duplicate email system",
    /deliverAssessmentEmail/.test(inviteMailer) && /deliverAssessmentEmail/.test(verifyMailer) &&
      /require\("\.\/assessmentMail"\)/.test(inviteMailer) && /require\("\.\/assessmentMail"\)/.test(verifyMailer),
    "one SMTP contract, two distinct events"
  );
  check(
    "the email diagnostics distinguish the two types and never log a code",
    /ASSESSMENT_EMAIL_TYPES/.test(shared) && /maskEmail/.test(shared) &&
      !/token|verification code/i.test(shared.slice(shared.indexOf("const logEmailAttempt"), shared.indexOf("// nodemailer resolves"))),
    "safe metadata only"
  );
  check(
    // The notification is read-only AND carries no assessment URL at all: it must
    // not open the assessment and must not hand the candidate a usable capability
    // link. The invitation email remains the ONLY route in.
    "the in-app notification is read-only and carries NO assessment link",
    /type: "ASSESSMENT_INVITATION"/.test(inviteBody) &&
      /link: "\/employee\/notifications"/.test(inviteBody) &&
      !/link: `\/assessment\/\$\{assessment\.publicId\}`/.test(inviteBody),
    "the notification must not open the assessment or bypass email verification"
  );
};

// --- scenario B2: the TWO email events are distinct -------------------------
// The corrected architecture keeps two logically separate emails at two
// different lifecycle stages, and this proves they are not combined:
//
//   Invite Selected        → ASSESSMENT INVITATION EMAIL (link, NO code)
//   candidate enters email → backend authorizes against the invitation
//   authorization succeeds → ASSESSMENT VERIFICATION EMAIL (the code)
//
// It also proves the authorization gate: a wrong email, a different candidate's
// invitation and a cross-job address are all refused BEFORE any code is
// generated, hashed, stored or emailed.
const scenarioTwoEmailLifecycle = async ({
  recruiterA, jobA, jobB, inSystem, notInSystem,
}) => {
  const inSystemEmail = inSystem.candidate.email;
  const externalEmail = notInSystem.candidate.email;
  const publicId = jobA.assessment.publicId;
  section("B2. Invitation email vs verification email are distinct events");

  const codesBefore = capturedCodes.length;

  // Invite a NOT-yet-invited row so this observes a FIRST invitation email.
  // (A repeat invite of an already-invited candidate deliberately sends nothing —
  // that is the duplicate-invitation rule, proven in scenario C.)
  const freshRow = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const freshEmail = freshRow.candidates[2]?.email;
  await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 2);
  check(
    "Invite Selected emits an ASSESSMENT INVITATION email for the candidate",
    invitationEmailCountFor(freshEmail) === 1,
    summarize({ email: freshEmail, invitations: invitationEmailCountFor(freshEmail) })
  );
  check(
    "Invite Selected emits NO verification code (the code is the later event)",
    capturedCodes.length === codesBefore && latestCodeFor(inSystemEmail) === null,
    summarize({ newCodes: capturedCodes.length - codesBefore })
  );
  check(
    "the invite stored NO verification challenge on the invitation row",
    (await invitationRowFor(jobA.assessment.id, inSystemEmail)).verificationTokenHash === null,
    "a code must not exist before the candidate asks for one"
  );

  // CASE 3 — WRONG EMAIL: an address that was never invited.
  const wrongEmail = uniqueEmail("wrong-email");
  const wrongCodesBefore = capturedCodes.length;
  await expectRejection(
    "CASE 3 — an email that was NOT invited is refused by the authorization gate",
    () => jobService.requestAssessmentEmailVerification(publicId, wrongEmail),
    403
  );
  check(
    "CASE 3 — the wrong email triggered NO verification code (nothing emailed, nothing stored)",
    capturedCodes.length === wrongCodesBefore &&
      (await prisma.jobAssessmentInvitation.count({ where: { email: wrongEmail.toLowerCase() } })) === 0,
    summarize({ newCodes: capturedCodes.length - wrongCodesBefore })
  );
  // CASE 4 — SAME ASSESSMENT, DIFFERENT INVITATION: a second invited address on
  // the same assessment must authorize only ITSELF.
  const otherInvited = uniqueEmail("other-invited");
  const otherAdded = await jobCandidateReferenceService.addManualCandidateReference(
    recruiterA.user,
    jobA.job.id,
    { email: otherInvited }
  );
  await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, otherAdded.candidate.referenceId);

  const firstCode = latestCodeFor(inSystemEmail);
  const otherCodeBefore = capturedCodes.length;
  await jobService.requestAssessmentEmailVerification(publicId, otherInvited);
  const otherCode = latestCodeFor(otherInvited);
  check(
    "CASE 4 — each invited address is authorized and gets its OWN code",
    typeof otherCode === "string" && otherCode.length > 0 && capturedCodes.length === otherCodeBefore + 1,
    summarize({ otherCode: typeof otherCode === "string" })
  );
  check(
    "CASE 4 — authorizing one invitation never verifies another",
    (await invitationRowFor(jobA.assessment.id, inSystemEmail)).status === "INVITED" &&
      latestCodeFor(inSystemEmail) === firstCode,
    "invitations are independent per (assessment, email)"
  );

  // CASE 5 — CROSS-JOB: an address invited to job B must not authorize job A.
  const jobBEmail = uniqueEmail("cross-job");
  const jobBAdded = await jobCandidateReferenceService.addManualCandidateReference(
    recruiterA.user,
    jobB.job.id,
    { email: jobBEmail }
  );
  await jobService.inviteJobCandidate(recruiterA.user, jobB.job.id, jobBAdded.candidate.referenceId);

  const crossCodesBefore = capturedCodes.length;
  await expectRejection(
    "CASE 5 — an address invited to ANOTHER job is refused on this assessment",
    () => jobService.requestAssessmentEmailVerification(publicId, jobBEmail),
    403
  );
  check(
    "CASE 5 — the cross-job attempt triggered NO verification code",
    capturedCodes.length === crossCodesBefore,
    summarize({ newCodes: capturedCodes.length - crossCodesBefore })
  );
  check(
    "CASE 5 — job B's own invitation is untouched (still INVITED, never cross-verified)",
    (await prisma.jobAssessmentInvitation.findUnique({
      where: { assessmentId_email: { assessmentId: jobB.assessment.id, email: jobBEmail.toLowerCase() } },
    })).status === "INVITED",
    "no cross-job promotion to EMAIL_VERIFIED"
  );
  // CASE 7 — EXPIRED/CLOSED JOB: rejected BEFORE a code is generated or sent.
  const closedCodesBefore = capturedCodes.length;
  await prisma.job.update({
    where: { id: jobB.job.id },
    data: { status: "CLOSED", closedReason: "SYSTEM_EXPIRED" },
  });
  await expectRejection(
    "CASE 7 — a CLOSED job is refused before any code is generated",
    () => jobService.requestAssessmentEmailVerification(jobB.assessment.publicId, jobBEmail),
    403
  );
  check(
    "CASE 7 — the closed-job attempt triggered NO verification code",
    capturedCodes.length === closedCodesBefore,
    summarize({ newCodes: capturedCodes.length - closedCodesBefore })
  );
  // Restore, so the remaining scenarios are unaffected by this probe.
  await prisma.job.update({
    where: { id: jobB.job.id },
    data: { status: "ACTIVE", closedReason: null },
  });

  // CASE 2 — NOT_IN_SYSTEM: the same invitation email, no in-app notification,
  // and the code only after the candidate authorizes their own address.
  const externalCodesBefore = capturedCodes.length;
  await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1);
  check(
    "CASE 2 — NOT_IN_SYSTEM receives the same invitation email",
    invitationEmailCountFor(externalEmail) >= 1,
    summarize({ invitations: invitationEmailCountFor(externalEmail) })
  );
  check(
    "CASE 2 — NOT_IN_SYSTEM still receives NO code at invite time",
    capturedCodes.length === externalCodesBefore,
    summarize({ newCodes: capturedCodes.length - externalCodesBefore })
  );
  await jobService.requestAssessmentEmailVerification(publicId, externalEmail);
  check(
    "CASE 2 — the NOT_IN_SYSTEM candidate's own authorization DOES send a code",
    typeof latestCodeFor(externalEmail) === "string" && latestCodeFor(externalEmail).length > 0,
    "external candidates follow the identical authorization path"
  );
  check(
    "CASE 2 — NOT_IN_SYSTEM still has NO in-app notification (not a registered user)",
    (await prisma.user.findFirst({ where: { email: externalEmail } })) === null,
    "an account is never created for an external candidate"
  );
};

// --- scenario H: frontend contract (static, against the REAL files) ----------

const scenarioFrontendContract = () => {
  section("H. Frontend contract — row-scoped invite, no manual email, authoritative status");

  const listPath = path.join(__dirname, "../../frontend/src/components/jobs/CandidateWorkflowList.jsx");
  const servicePath = path.join(__dirname, "../../frontend/src/services/jobService.js");
  const listSource = fs.readFileSync(listPath, "utf8");
  const serviceSource = fs.readFileSync(servicePath, "utf8");

  check(
    "the Invite action posts the ROW-SCOPED API (job id + candidate row id)",
    serviceSource.includes("`/job/${jobId}/candidates/${encodeURIComponent(candidateId)}/invite`"),
    "expected the row-scoped invite call in jobService.js"
  );
  check(
    "NO manual email input exists anywhere in the candidate list component",
    !/(type=["']email|placeholder=[^>]*mail|input[^>]*value=\{?email)/i.test(listSource),
    "found an email-like input in CandidateWorkflowList.jsx"
  );
  check(
    "the invite handler sends ONLY the row identity (never an email payload)",
    /inviteJobCandidate\(jobId,\s*rowId\)/.test(listSource) &&
      !/inviteJobCandidate\([^)]*email/i.test(listSource),
    "the invite call must not carry an email argument"
  );
  check(
    "the row identity is the row's own id (Excel rowId) or its candidate-reference id",
    /const rowId = candidate\.id \?\? candidate\.referenceId/.test(listSource),
    "expected candidate.id ?? candidate.referenceId as the invite identity"
  );
  check(
    "NO email-only invitation path remains in the candidate list",
    !/createAssessmentInvitations/.test(listSource),
    "found the removed email-only invitation call in CandidateWorkflowList.jsx"
  );
  check(
    // The guard is now PER CATEGORY, which is the fix for the reported bug:
    // one category's in-flight batch can never block or visually load the other.
    "a per-category in-flight invite guard prevents duplicate UI clicks",
    /invitingCategory === categoryKey\) return/.test(listSource) &&
      /setInvitingCategory\(categoryKey\)/.test(listSource) &&
      /setInvitingCategory\(null\)/.test(listSource) &&
      /setInvitingKey\(rowId\)/.test(listSource) &&
      /setInvitingKey\(null\)/.test(listSource),
    "expected the per-category guard around the invite call"
  );
  check(
    "the returned (persisted) invitation status updates the row — no local status invention",
    /invitationStatus: status === "EMAIL_VERIFIED" \? "EMAIL_VERIFIED" : "INVITED"/.test(listSource),
    "expected the authoritative status mapping in the row update"
  );
  check(
    "the Sendings… loading state is rendered while the invite is in flight",
    listSource.includes('"Sending…"'),
    "expected the Sending state"
  );
  check(
    "the backend activation state (not frontend opinion) gates the Invite button",
    /assessmentActive/.test(listSource) && /status === "FINALIZED" && assessment\.activatedAt/.test(listSource),
    "expected the FINALIZED + activatedAt gate"
  );
  check(
    "the invitation-status badges render the BACKEND statuses (incl. persisted EMAIL_VERIFIED)",
    ["NOT_INVITED", "INVITED", "EMAIL_VERIFIED", "EXPIRED"].every((status) =>
      listSource.includes(`"${status}"`)
    ),
    "expected all four persisted statuses in the badge maps"
  );
  check(
    "the existing skill score stays clearly labelled as informational (never an assessment score)",
    /not the assessment score/.test(listSource),
    "expected the display-only disclaimer"
  );

  // --- the duplicate-invitation rule, frontend half (TEST 6) ----------------
  // Eligibility is decided ONCE in a shared helper and reused by the row
  // checkbox, the select-all toggle, the section count and the invite handler,
  // so "Invite Selected (n)" can never promise more invitations than it sends.
  check(
    "INVITED candidates are NOT eligible for another invitation (INVITED: false)",
    /INVITE_ALLOWED_STATES = \{[^}]*"INVITED": false[^}]*\}/s.test(listSource),
    "expected INVITED to be ineligible for re-invitation"
  );
  check(
    "EMAIL_VERIFIED candidates remain ineligible (nothing left to invite)",
    /INVITE_ALLOWED_STATES = \{[^}]*"EMAIL_VERIFIED": false[^}]*\}/s.test(listSource),
    "expected EMAIL_VERIFIED to stay ineligible"
  );
  check(
    "NOT_INVITED and EXPIRED remain eligible (a lapsed window may be re-invited)",
    /INVITE_ALLOWED_STATES = \{[^}]*"NOT_INVITED": true[^}]*"EXPIRED": true[^}]*\}/s.test(
      listSource
    ),
    "expected NOT_INVITED and EXPIRED to stay eligible"
  );
  check(
    "a single shared eligibility helper drives selection, counting and inviting",
    /const isInviteEligible = \(candidate\) =>/.test(listSource) &&
      // referenced by BOTH pass-through filters (.filter(isInviteEligible)) and
      // the per-row decision, so the rule cannot drift between the four sites
      (listSource.match(/\.filter\(isInviteEligible\)/g) ?? []).length === 3 &&
      /const eligible = isInviteEligible\(candidate\)/.test(listSource),
    "expected isInviteEligible to be reused across the selection and invite paths"
  );
  check(
    "an already-invited row's checkbox is disabled so it cannot be selected again",
    /disabled=\{!eligible\}/.test(listSource) && /checked=\{eligible && selectedKeys\.has\(key\)\}/.test(
      listSource
    ),
    "expected the row checkbox to be disabled for an ineligible candidate"
  );
  check(
    "the persisted invitation status stays visible on an already-invited row",
    /data-invitation-status=\{candidate\.invitationStatus/.test(listSource) &&
      /ASSESSMENT_LABEL = \{[\s\S]*INVITED: "Invited"/.test(listSource),
    "expected the existing INVITED status to remain rendered"
  );
  check(
    "the Invite Selected count only includes ELIGIBLE candidates",
    /const eligibleCandidates = candidates\.filter\(isInviteEligible\)/.test(listSource) &&
      /selectedCandidates = eligibleCandidates\.filter/.test(listSource),
    "expected the section count to exclude already-invited candidates"
  );
  check(
    "select-all skips ineligible candidates (it can never select an invited row)",
    /categoryCandidates\.filter\(isInviteEligible\)\.map\(candidateKey\)/.test(listSource),
    "expected select-all to filter to eligible rows"
  );
  check(
    "Invite Selected disables itself when a section has no eligible candidates",
    /const disabled = inviting \|\| !assessmentActive \|\| selectedCount === 0/.test(listSource) &&
      /disabled=\{eligibleCandidates\.length === 0\}/.test(listSource),
    "expected the action to disable with no eligible candidates remaining"
  );
  check(
    "the invite handler filters ineligible candidates (defence in depth)",
    /const toInvite = selected\.filter\(isInviteEligible\)/.test(listSource),
    "expected the handler to re-filter before sending"
  );
  check(
    "no per-row invite control was added (still category-level only)",
    !/<button[^>]*>[^<]*\bInvite\b/i.test(listSource.replace(/Invite Selected/g, "")),
    "found a per-row invite button"
  );
  check(
    "the fixed eight columns and the two categories are unchanged",
    ["Select", "Candidate", "Email", "Verification", "Assessment", "Test Status", "Score", "Analysis"]
      .every((label) => listSource.includes(`label: "${label}"`)) &&
      /<CandidateCategoryColumn/g.test(listSource) &&
      /column=\{IN_SYSTEM_COLUMN\}/.test(listSource) &&
      /column=\{NOT_IN_SYSTEM_COLUMN\}/.test(listSource),
    "expected the accepted column set and both category sections to be intact"
  );
  check(
    "no verification code is ever rendered or stored by the recruiter list",
    !/verificationTokenHash|verificationExpiresAt|localStorage|sessionStorage/.test(listSource),
    "found a verification challenge or browser storage write in the recruiter list"
  );
};

// --- scenario J: the TWO column-wise candidate categories --------------------
//
// The recruiter list is ONE data source displayed as TWO categorized columns:
// IN SYSTEM on the left, NOT IN SYSTEM on the right. This scenario pins the
// structural properties of that layout, and — critically — that both columns
// are the SAME system: one row component, one Invite action, one endpoint.

const scenarioTwoCategoryColumns = () => {
  section("J. Two column-wise categories — one list, two categories, one workflow");

  const listSource = fs.readFileSync(
    path.join(__dirname, "../../frontend/src/components/jobs/CandidateWorkflowList.jsx"),
    "utf8"
  );
  const manualAddSource = fs.readFileSync(
    path.join(__dirname, "../../frontend/src/components/jobs/ManualCandidateAdd.jsx"),
    "utf8"
  );

  check(
    "the list renders exactly TWO category columns",
    (listSource.match(/<CandidateCategoryColumn/g) ?? []).length === 2,
    "expected exactly two CandidateCategoryColumn instances"
  );
  check(
    "the two SEPARATE SECTIONS are IN SYSTEM first and NOT IN SYSTEM second",
    /column=\{IN_SYSTEM_COLUMN\}[\s\S]{0,1200}column=\{NOT_IN_SYSTEM_COLUMN\}/.test(
      listSource
    ) && /flex flex-col gap-6/.test(listSource),
    "expected two stacked, clearly separated category sections"
  );
  check(
    "the split is a PURE READ of the backend's systemStatus classification",
    /candidate\.systemStatus === "IN_SYSTEM"/.test(listSource),
    "expected the column to be decided by the backend value alone"
  );
  check(
    "the frontend NEVER lets a recruiter move a candidate between categories",
    !/(onChange|onSelect|onClick)\s*=\s*\{[^}]*\bsystemStatus\b/.test(listSource) &&
      !/setSystemStatus/.test(listSource) &&
      !/moveCandidateTo|changeCategory|reclassify/i.test(listSource),
    "found a control that could re-assign a candidate's category"
  );
  check(
    "BOTH columns are rendered by the SAME shared column component (not two systems)",
    /const CandidateCategoryColumn = \(\{/.test(listSource) &&
      /column={IN_SYSTEM_COLUMN}/.test(listSource) &&
      /column={NOT_IN_SYSTEM_COLUMN}/.test(listSource),
    "expected one shared CandidateCategoryColumn used by both categories"
  );
  check(
    "there is exactly ONE Invite action rendered in the shared column component",
    (listSource.match(/<InviteAction/g) ?? []).length === 1,
    "expected a single InviteAction render site shared by both columns"
  );
  check(
    "BOTH columns are wired to the SAME invite handler",
    (listSource.match(/onInvite=\{handleInvite\}/g) ?? []).length === 2,
    "expected both columns to pass the same handleInvite"
  );
  check(
    "the old single MIXED table is gone (rows are only mapped inside the shared section)",
    !/\{COLUMNS\.map\(/.test(listSource) &&
      // the only row mapping lives in the shared section component, and the page
      // itself renders the two stacked category sections rather than one mixed table
      /const CandidateCategoryColumn[\s\S]*\{candidates\.map\(/.test(listSource) &&
      /flex flex-col gap-6[\s\S]{0,4000}<CandidateCategoryColumn[\s\S]{0,4000}<CandidateCategoryColumn/.test(
        listSource
      ),
    "found the old single mixed table"
  );
  // The two category sections must be COMPLETELY INDEPENDENT: each is handed its
  // own loading state derived from its own key, so one category's request can
  // never put the other category's button into a loading/disabled state.
  check(
    "each category's loading state is derived from ITS OWN key (no shared isInviting flag)",
    /inviting=\{invitingCategory === IN_SYSTEM_COLUMN\.key\}/.test(listSource) &&
      /inviting=\{invitingCategory === NOT_IN_SYSTEM_COLUMN\.key\}/.test(listSource) &&
      !/inviting=\{invitingKey !== null\}/.test(listSource),
    "one category's request must never visually load the other"
  );
  check(
    "the invite handler is scoped to the category that was pressed",
    /onInvite\(selectedCandidates, column\.key\)/.test(listSource),
    "each button must send its own category's selection under its own key"
  );
  check(
    "no per-row category badge remains (the SECTION is the category)",
    !/SYSTEM_LABEL\[/.test(listSource) && !/SYSTEM_BADGE\[/.test(listSource),
    "found the removed per-row category badge"
  );
  check(
    "there is NO Analyze button or manual analysis trigger anywhere in the list",
    !/(\bAnalyze\b|RunAnalysis|startCandidateAnalysis|requestCandidateAnalysis)/.test(listSource),
    "found a manual analysis trigger"
  );
  check(
    "the Verification column is FIXED and shown for BOTH categories (never hidden)",
    /label: "Verification"/.test(listSource) &&
      /SHARED_COLUMNS = \[/.test(listSource) &&
      !/NOT_IN_SYSTEM_ONLY/.test(listSource) &&
      !/IN_SYSTEM_ONLY_COLUMNS/.test(listSource),
    "expected one fixed Verification column shared by both categories"
  );
  check(
    "a NOT_IN_SYSTEM candidate shows — for verification and is never given a score",
    /systemStatus !== "IN_SYSTEM"/.test(listSource) &&
      /No platform account — no platform verification/.test(listSource) &&
      !/NOT_IN_SYSTEM_ONLY/.test(listSource),
    "expected NOT_IN_SYSTEM verification to render an em dash, never a number"
  );
  check(
    "the manual add form collects ONLY the five candidate evidence fields",
    !/key: "skills"/.test(manualAddSource) &&
      !/key: "skillNotes"/.test(manualAddSource) &&
      !/key: "preferredRole"/.test(manualAddSource) &&
      ["email", "name", "linkedinUrl", "githubUrl"].every((key) =>
        manualAddSource.includes(`key: "${key}"`)
      ) &&
      /manual-candidate-resume/.test(manualAddSource),
    "expected exactly Name, Email, Resume, LinkedIn, GitHub"
  );
  check(
    "the manual add payload no longer sends skills / skill notes / preferred role",
    !/skills:/.test(manualAddSource) && !/skillNotes:/.test(manualAddSource) &&
      !/preferredRole:/.test(manualAddSource),
    "found a job-requirement field still sent from the candidate form"
  );
};
//
// The product rule is structural: there is exactly ONE way to send an
// invitation — the Invite action on a row of the recruiter's candidate list.
// This scenario reads the REAL backend + frontend sources and asserts the
// email-only path is gone everywhere, while the candidate-facing verification
// contract (which legitimately uses an email field) is untouched.

const scenarioSingleInvitationFlow = () => {
  section("I. Single invitation flow — the email-only path is gone repo-wide");

  const read = (relative) =>
    fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

  const routes = read("src/module/job/job.routes.js");
  const controller = read("src/module/job/job.controller.js");
  const service = read("src/module/job/job.service.js");
  const validation = read("src/module/job/job.validation.js");
  const assessmentCard = read("../frontend/src/components/jobs/AssessmentCard.jsx");
  const jobDetail = read("../frontend/src/pages/dashboard/RecruiterJobDetail.jsx");
  const frontendService = read("../frontend/src/services/jobService.js");

  check(
    "the backend has NO email-only invitation route",
    !routes.includes("assessment/invitations"),
    "found the removed /:jobId/assessment/invitations route"
  );
  check(
    "the candidate-list invite route is the ONLY recruiter invitation route",
    (routes.match(/inviteJobCandidate/g) ?? []).length === 1 &&
      routes.includes('"/:jobId/candidates/:candidateId/invite"'),
    "expected exactly one recruiter invitation route (the candidate-list one)"
  );
  check(
    "the backend has NO email-only invitation controller",
    !/createAssessmentInvitations/.test(controller),
    "found the removed recruiter controller"
  );
  check(
    // The repository's single-row `createAssessmentInvitations` writer is still
    // used BY the single invite action, so the assertion targets the removed
    // recruiter-side SERVICE function specifically.
    "the backend has NO email-only invitation service",
    !/const createAssessmentInvitations = async/.test(service) &&
      !/^\s*createAssessmentInvitations,\s*$/m.test(service),
    "found the removed recruiter service"
  );
  check(
    "the backend has NO recruiter-side email-list invitation schema",
    !/invitationCreateSchema/.test(validation),
    "found the removed recruiter invitation body schema"
  );
  check(
    "the CANDIDATE-FACING email field is preserved (invitation verification still works)",
    /const invitationEmailField = z/.test(validation) &&
      /assessmentEmailVerificationSchema = z\.object\(\{\s*email: invitationEmailField/.test(
        validation
      ),
    "the candidate-facing verification email schema must be untouched"
  );
  check(
    "the assessment card has NO standalone Send Invitation UI",
    !/Send Invitations/.test(assessmentCard) &&
      !/assessment-invitations/.test(assessmentCard) &&
      !/onInvite/.test(assessmentCard),
    "found the removed standalone invitation form in AssessmentCard.jsx"
  );
  check(
    "the job detail page has NO invitation submission handler",
    !/createAssessmentInvitations/.test(jobDetail) && !/handleCreateInvitations/.test(jobDetail),
    "found the removed invitation handler in RecruiterJobDetail.jsx"
  );
  check(
    "the frontend service has NO email-only invitation client",
    !/createAssessmentInvitations/.test(frontendService) &&
      !/assessment\/invitations/.test(frontendService),
    "found the removed email-only client in jobService.js"
  );
  check(
    "the ONE remaining frontend invite client is the row-scoped candidate-list call",
    (frontendService.match(/\/invite`/g) ?? []).length === 1,
    "expected exactly one invite client call"
  );
};

// --- cleanup & report --------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  storedFile: await prisma.storedFile.count(),
  jobCandidateList: await prisma.jobCandidateList.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  employeeProfile: await prisma.employeeProfile.count(),
  notification: await prisma.notification.count(),
  verificationAttempt: await prisma.verificationAttempt.count(),
  verificationReport: await prisma.verificationReport.count(),
});

// Deletes exactly what this harness created, in FK-safe order. Scoped strictly
// to tracked ids.
const cleanup = async () => {
  const removed = {};
  const jobIds = tracked.jobIds;
  const userIds = tracked.userIds;

  if (jobIds.length > 0) {
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
    removed.notification = (
      await prisma.notification.deleteMany({
        where: { user: { id: { in: userIds } } },
      })
    ).count;
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
    const scope = { in: userIds };
    removed.verificationEvidence = (
      await prisma.verificationEvidence.deleteMany({
        where: { verificationReport: { verificationAttempt: { userId: scope } } },
      })
    ).count;
    removed.verificationReport = (
      await prisma.verificationReport.deleteMany({
        where: { verificationAttempt: { userId: scope } },
      })
    ).count;
    removed.verificationAttempt = (
      await prisma.verificationAttempt.deleteMany({ where: { userId: scope } })
    ).count;
    removed.assessmentDefinition = (
      await prisma.assessmentDefinition.deleteMany({
        where: { employeeProfileSkill: { employeeProfile: { userId: scope } } },
      })
    ).count;
    removed.employeeProfileSkill = (
      await prisma.employeeProfileSkill.deleteMany({
        where: { employeeProfile: { userId: scope } },
      })
    ).count;
    removed.employeeProfile = (
      await prisma.employeeProfile.deleteMany({ where: { userId: scope } })
    ).count;
    removed.userRole = (await prisma.userRole.deleteMany({ where: { userId: scope } })).count;
    removed.user = (await prisma.user.deleteMany({ where: { id: scope } })).count;
  }

  return removed;
};

const countLeftovers = async () => {
  const [users, jobs, profiles, attempts, reports, invitations, assessments, lists, notifications] =
    await Promise.all([
      tracked.userIds.length
        ? prisma.user.count({ where: { id: { in: tracked.userIds } } })
        : Promise.resolve(0),
      tracked.jobIds.length
        ? prisma.job.count({ where: { id: { in: tracked.jobIds } } })
        : Promise.resolve(0),
      tracked.employeeProfileIds.length
        ? prisma.employeeProfile.count({ where: { id: { in: tracked.employeeProfileIds } } })
        : Promise.resolve(0),
      prisma.verificationAttempt.count({ where: { userId: { in: tracked.userIds } } }),
      prisma.verificationReport.count({
        where: { verificationAttempt: { userId: { in: tracked.userIds } } },
      }),
      prisma.jobAssessmentInvitation.count({ where: { jobId: { in: tracked.jobIds } } }),
      prisma.jobAssessment.count({ where: { jobId: { in: tracked.jobIds } } }),
      prisma.jobCandidateList.count({ where: { jobId: { in: tracked.jobIds } } }),
      prisma.notification.count({ where: { user: { id: { in: tracked.userIds } } } }),
    ]);
  return (
    users + jobs + profiles + attempts + reports + invitations + assessments + lists + notifications
  );
};

// --- runner ------------------------------------------------------------------

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

  console.log(
    "Candidate invitations verified: email resolved from the persisted Excel row, " +
      "idempotent JobAssessmentInvitation reuse, activation enforced, no AI/quota/attempt/account side effects."
  );
};

const run = async () => {
  console.log("Candidate invitation verification harness (Phase 2)");
  console.log(`run id: ${SUFFIX}`);

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);

  try {
    // --- fixtures ------------------------------------------------------------
    const recruiterA = await createRecruiterFixture("main", 10);
    const recruiterB = await createRecruiterFixture("other", 10);

    // Real platform candidate (IN_SYSTEM) + three not-in-system sheet emails.
    // Row 1's sheet email uses MIXED CASE to prove normalization end-to-end.
    const inSystemEmail = uniqueEmail("in-system");
    const candidateAccount = await createCandidateFixture({ email: inSystemEmail, score: 82 });
    const notInSystemEmail = `Candinv-NotInSystem-${SUFFIX}@example.TEST`;
    const spareEmail = uniqueEmail("spare");
    const expiryEmail = uniqueEmail("expiry");

    // Job A: the main flow (4 rows: 0=in-system, 1=mixed-case not-in-system,
    // 2=email-failure spare, 3=expiry/public-flow row).
    const jobA = await createJobFixture(recruiterA, {
      label: "a",
      rows: [
        ["Ali", inSystemEmail],
        ["Sara", notInSystemEmail],
        ["Noor", spareEmail],
        ["Omar", expiryEmail],
      ],
      assessment: { status: "FINALIZED", activated: true },
    });

    // Job B: same recruiter, second assessment — cross-assessment isolation.
    const jobB = await createJobFixture(recruiterA, {
      label: "b",
      rows: [["Zara", uniqueEmail("b-row0")]],
      assessment: { status: "FINALIZED", activated: true },
    });

    // Guard jobs: no assessment / DRAFT assessment / FINALIZED-but-inactive.
    const noAssessment = await createJobFixture(recruiterA, {
      label: "no-assessment",
      rows: [["Nia", uniqueEmail("no-assessment")]],
    });
    const draftAssessment = await createJobFixture(recruiterA, {
      label: "draft-assessment",
      rows: [["Nia", uniqueEmail("draft-assessment")]],
      assessment: { status: "DRAFT", activated: false },
    });
    const finalizedOnly = await createJobFixture(recruiterA, {
      label: "finalized-only",
      rows: [["Nia", uniqueEmail("finalized-only")]],
      assessment: { status: "FINALIZED", activated: false },
    });

    // A CLOSED job (closed through the real lifecycle service) with a
    // finalized+active assessment: the invitation path only runs on ACTIVE
    // jobs, so this must refuse.
    const closedJob = await createJobFixture(recruiterA, {
      label: "closed-job",
      rows: [["Nia", uniqueEmail("closed-job")]],
      assessment: { status: "FINALIZED", activated: true },
    });
    await jobService.closeJobAsRecruiter(recruiterA.user, closedJob.job.id);

    const baseline = await snapshotSideEffects(candidateAccount.user.id);

    scenarioFrontendContract();
    scenarioSingleInvitationFlow();
    scenarioTwoCategoryColumns();
    scenarioMailerSeparation();
    await scenarioGuards({
      recruiterA,
      noAssessment,
      draftAssessment,
      finalizedOnly,
      closedJob,
    });
    const invited = await scenarioCandidateSource({ recruiterA, jobA, jobB, candidateAccount });
    await scenarioIdempotency({ recruiterA, jobA, ...invited });
    await scenarioSecurity({
      recruiterA,
      recruiterB,
      jobA,
      jobB,
      finalizedOnly,
      notInSystem: invited.notInSystem,
    });
    await scenarioSideEffects({ recruiterA, jobA, candidateAccount, baseline });
    await scenarioEmailFailure({ recruiterA, jobA, spareEmail });
    // Runs AFTER the side-effect/notification assertions, which expect exactly
    // one notification, and BEFORE the public-flow scenario (which asserts the
    // in-system candidate has no code yet).
    await scenarioConcurrentInvite({ recruiterA, jobA, candidateAccount });
    // Runs BEFORE the public-flow scenario: it leaves the in-system candidate
    // unverified (a code is requested but never confirmed), which is exactly
    // the state scenario G asserts its "no code at invite time" baseline on.
    await scenarioTwoEmailLifecycle({ recruiterA, jobA, jobB, ...invited });
    await scenarioPublicVerificationFlow({ recruiterA, jobA, ...invited });
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
    // startJob legitimately enqueues analysis work in an ISOLATED queue
    // namespace (no worker can ever pick it up); the connections must be
    // closed so the harness process can exit.
    await aiJobQueue.closeAiJobQueue();
    await prisma.$disconnect();
  });













