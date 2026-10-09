/* eslint-disable no-console */
// Regression harness for the two reported candidate-workflow bugs.
//
// Run with:  npm run verify:candidate-invitation-email-and-report
//
//   A. Invitation EMAIL DELIVERY is real (not "the app believes it sent").
//      The mailer is driven against a stubbed nodemailer transport so the
//      ACCEPTED/REJECTED contract is observable: a message the provider did
//      not accept must FAIL instead of reporting `emailSent: true`.
//   B. IN_SYSTEM and NOT_IN_SYSTEM invitations both send the ASSESSMENT
//      INVITATION email (the link) and NO verification code; the code is the
//      separate, later VERIFICATION email, issued only after the candidate's
//      email is authorized against a persisted invitation. NOT_IN_SYSTEM still
//      creates no EMPLOYEE account.
//   C. The code never leaves the email: not in the API response, not in the
//      notification payload, not in the realtime/SSE payload, and the stored
//      challenge is only ever a SHA-256 hash.
//   D. The recruiter "View Report" read returns the EXISTING persisted
//      verification reports (latest COMPLETED per skill), with no new
//      verification generated.
//   E. Scoping: NOT_IN_SYSTEM, cross-job, cross-recruiter and unknown
//      references are all refused without leaking verification data.
//
// Convention follows verifyCandidateInvitation.js (CommonJS, the app's own
// Prisma client, throwaway fixtures, process.exitCode on failure).
require("dotenv").config();

const XLSX = require("xlsx");
const nodemailer = require("nodemailer");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const jobCandidateReferenceService = require("../src/module/job/jobCandidateReference.service");
const jobCandidateReferenceRepository = require("../src/module/job/jobCandidateReference.repository");
const realtimePublisher = require("../src/module/job/jobAssessmentRealtime.publisher");
const { smtpConfigured } = require("../src/utils/sendAssessmentVerificationEmail");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
process.env.AI_QUEUE_PREFIX = `candemail-${SUFFIX}`;

// ---------------------------------------------------------------------------
// The deterministic email channel. SMTP is BLANKED (never deleted) so no real
// mail can leave this process; the project then uses its documented server-log
// fallback, and the code the candidate would receive is captured from there.
// ---------------------------------------------------------------------------
const neutralizeSmtp = () => {
  process.env.SMTP_HOST = "";
  process.env.SMTP_PORT = "";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";
  process.env.EMAIL_FROM = "";
};
neutralizeSmtp();

const capturedCodes = [];
const capturedInvitations = [];
const originalConsoleLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  // Two DISTINCT email events, told apart by prefix. The VERIFICATION regex is
  // the historical contract; the INVITATION one is new.
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
const codesFor = (email) => capturedCodes.filter((entry) => entry.email === email).length;
// Counts the ASSESSMENT INVITATION EMAILS emitted on the deterministic channel
// (the PERSISTED row count is read separately, straight from Prisma).
const invitationEmailCountFor = (email) =>
  capturedInvitations.filter((entry) => entry.email === email).length;
// A verification code must never ride along on the invitation email.
const invitationLineFor = (email) =>
  [...capturedInvitations].reverse().find((entry) => entry.email === email)?.line ?? null;

// --- reporting --------------------------------------------------------------
const results = [];
const section = (title) => originalConsoleLog(`\n${title}`);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  originalConsoleLog(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail) originalConsoleLog(`        -> ${detail}`);
};
const summarize = (value) => JSON.stringify(value ?? null);
const collectKeys = (value, keys = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
};
const expectRejection = async (label, fn, status) => {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  if (!error) {
    check(label, false, `expected HTTP ${status}, but the call resolved`);
    return null;
  }
  check(label, error.status === status, `expected ${status}, got ${error.status}: ${error.message}`);
  return error;
};

// --- fixtures ----------------------------------------------------------------
const tracked = { userIds: [], planIds: [], subscriptionIds: [], jobIds: [] };
const uniqueEmail = (label) =>
  `candemail-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

const createRecruiterFixture = async (label) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Candidate Email Harness ${label}`,
      email: `candemail-recruiter-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.upsert({
    where: { name: "RECRUITER" },
    update: {},
    create: { name: "RECRUITER", description: "Recruiter" },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Candidate Email Harness Plan ${label} ${SUFFIX}`,
      type: "RECRUITER",
      price: 0,
      billingCycle: "MONTHLY",
      jobPostingLimit: 10,
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

// A real EMPLOYEE candidate with the FULL existing verification chain, so the
// report assertions read genuinely persisted VerificationReport rows.
const createCandidateWithReports = async ({ email, skills }) => {
  const user = await prisma.user.create({
    data: { email, fullName: `Candidate ${email}`, provider: "LOCAL", emailVerified: true, status: "ACTIVE" },
  });
  const role = await prisma.role.upsert({
    where: { name: "EMPLOYEE" },
    update: {},
    create: { name: "EMPLOYEE", description: "Candidate" },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const profile = await prisma.employeeProfile.create({
    data: { userId: user.id, headline: "h", bio: "b", experienceLevel: "MID_LEVEL" },
  });
  for (const skill of skills) {
    const profileSkill = await prisma.employeeProfileSkill.create({
      data: { employeeProfileId: profile.id, name: skill.name, yearsOfExperience: 3 },
    });
    const definition = await prisma.assessmentDefinition.create({
      data: {
        employeeProfileSkillId: profileSkill.id,
        skillNameSnapshot: skill.name,
        title: `${skill.name} assessment`,
        version: 1,
        durationSeconds: 1200,
        questionCount: 1,
        passingScore: 50,
        domain: "ENG",
        department: "ENG",
        status: "PUBLISHED",
        questions: {
          create: [{
            questionOrder: 1, questionType: "SINGLE_CHOICE", prompt: "Q",
            points: 10, options: { a: "A", b: "B" }, correctAnswer: "A",
          }],
        },
      },
    });
    const attempt = await prisma.verificationAttempt.create({
      data: {
        userId: user.id,
        employeeProfileId: profile.id,
        employeeProfileSkillId: profileSkill.id,
        assessmentDefinitionId: definition.id,
        assessmentVersion: 1,
        skillNameSnapshot: skill.name,
        status: "SCORED",
        deadlineAt: new Date(Date.now() - DAY_IN_MS),
        submittedAt: new Date(Date.now() - DAY_IN_MS),
      },
    });
    await prisma.verificationReport.create({
      data: {
        verificationAttemptId: attempt.id,
        employeeProfileSkillId: profileSkill.id,
        processingStatus: "COMPLETED",
        verificationStatus: skill.status,
        verificationScore: skill.score,
        confidenceScore: skill.confidence,
        aiSummary: `Summary for ${skill.name}`,
        strengths: [`${skill.name} strength`],
        areasToImprove: [`${skill.name} improve`],
        completedAt: skill.completedAt,
      },
    });
  }
  tracked.userIds.push(user.id);
  return { user, profile };
};

const buildSheet = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  return XLSX.write({ SheetNames: ["C"], Sheets: { C: sheet } }, { type: "buffer", bookType: "xlsx" });
};

const createJobFixture = async (recruiter, { label, rows }) => {
  const draft = await jobService.createDraft(recruiter.user, {
    title: `Candidate email harness ${label}`,
    yearsExperience: 5,
    description: "Harness job used to verify invitation email delivery and the recruiter verification report.",
    analysisDays: 3,
    skills: [{ name: "React", weight: 60 }, { name: "Node.js", weight: 40 }],
    tools: [{ name: "Git" }],
    questions: [{ question: "Describe a project you shipped." }],
  });
  tracked.jobIds.push(draft.id);
  const buffer = buildSheet([["Name", "Email"], ...rows]);
  await jobService.uploadCandidateList(recruiter.user, draft.id, {
    originalname: `candemail-${label}-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
  const assessment = await prisma.jobAssessment.create({
    data: {
      jobId: draft.id,
      title: `Candidate email harness assessment ${label}`,
      status: "FINALIZED",
      publicId: `candemail-${SUFFIX}-${label}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
      durationSeconds: 600,
    },
  });
  await jobService.startJob(recruiter.user, draft.id);
  return { job: draft, assessment };
};

// --- scenario A: the mailer confirms REAL delivery -------------------------
// The reported symptom was an invitation that reported success while the
// candidate received nothing. nodemailer resolves for a message the provider
// did not accept, so the mailer must inspect accepted/rejected itself. This is
// proven against a STUBBED transport — no real provider is contacted.
const scenarioDeliveryIsReal = async () => {
  section("A. Email delivery is verified against the provider, not assumed");
  check(
    "this harness can never reach a real mail provider",
    smtpConfigured() === false,
    "SMTP must be neutralized for this harness"
  );

  const original = nodemailer.createTransport;
  const makeStub = (info) => {
    nodemailer.createTransport = () => ({
      verify: async () => true,
      sendMail: async () => info,
      close: () => {},
    });
  };
  const recipient = uniqueEmail("delivery-probe");
  const { sendAssessmentVerificationEmail } = require("../src/utils/sendAssessmentVerificationEmail");
  const send = () =>
    sendAssessmentVerificationEmail({
      email: recipient,
      token: "harness-token-not-a-real-secret",
      assessmentTitle: "Delivery probe",
      expiresAt: new Date(Date.now() + DAY_IN_MS),
    });

  const realEnv = {
    host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD,
    from: process.env.EMAIL_FROM,
  };
  process.env.SMTP_HOST = "stub"; process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "u"; process.env.SMTP_PASSWORD = "p";
  process.env.EMAIL_FROM = "sender@example.test";

  try {
    makeStub({ accepted: [recipient], rejected: [], response: "250 OK" });
    const ok = await send();
    check("a message the provider ACCEPTED is reported as sent", ok?.channel === "smtp", summarize(ok));

    makeStub({ accepted: [], rejected: [recipient], response: "550 rejected" });
    let rejectedError = null;
    try { await send(); } catch (error) { rejectedError = error; }
    check(
      "a message the provider REJECTED fails instead of reporting emailSent: true",
      rejectedError !== null && rejectedError.code === "ASSESSMENT_EMAIL_NOT_DELIVERED",
      summarize({ code: rejectedError?.code })
    );

    makeStub({ accepted: [], rejected: [], response: "250 OK" });
    let silentError = null;
    try { await send(); } catch (error) { silentError = error; }
    check(
      "a resolved promise WITHOUT the recipient in `accepted` is still a failure",
      silentError !== null && silentError.code === "ASSESSMENT_EMAIL_NOT_DELIVERED",
      summarize({ code: silentError?.code })
    );

    const leak = String(rejectedError?.message ?? "");
    check(
      "the delivery failure never leaks a token, a credential or the address",
      !leak.includes("harness-token-not-a-real-secret") && !leak.includes(recipient),
      summarize(leak)
    );
  } finally {
    nodemailer.createTransport = original;
    Object.assign(process.env, {
      SMTP_HOST: realEnv.host, SMTP_PORT: realEnv.port, SMTP_USER: realEnv.user,
      SMTP_PASSWORD: realEnv.pass, EMAIL_FROM: realEnv.from,
    });
    neutralizeSmtp();
  }
};

// --- scenario B/C: the two email events, at their own lifecycle stages -------
const scenarioInvitationDelivery = async ({ recruiterA, jobA, inSystemEmail, externalEmail }) => {
  section("B. Invite Selected sends the INVITATION email and NO verification code");

  const inSystem = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 0);
  check(
    "the IN_SYSTEM invite email path executes and reports the invitation email as sent",
    inSystem.emailSent === true && invitationEmailCountFor(inSystemEmail) === 1,
    summarize({ emailSent: inSystem.emailSent, channel: inSystem.emailChannel })
  );
  check(
    "the IN_SYSTEM invite email carries NO verification code",
    latestCodeFor(inSystemEmail) === null && !/verification code/i.test(invitationLineFor(inSystemEmail) ?? ""),
    "the invitation email is the link, not a code"
  );
  check(
    "the IN_SYSTEM invite persisted NO verification challenge (a code cannot exist yet)",
    (await prisma.jobAssessmentInvitation.findUnique({
      where: { assessmentId_email: { assessmentId: jobA.assessment.id, email: inSystemEmail } },
    })).verificationTokenHash === null,
    "no code is generated at invite time"
  );
  check(
    "the IN_SYSTEM candidate is classified from the registered EMPLOYEE account",
    inSystem.candidate.systemStatus === "IN_SYSTEM" && inSystem.candidateNotified === true,
    summarize(inSystem.candidate)
  );

  const notInSystem = await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 1);
  check(
    "the NOT_IN_SYSTEM invite email path still executes and sends the SAME invitation email",
    notInSystem.emailSent === true && invitationEmailCountFor(externalEmail) === 1,
    summarize({ emailSent: notInSystem.emailSent, channel: notInSystem.emailChannel })
  );
  check(
    "the NOT_IN_SYSTEM invite email also carries NO verification code",
    latestCodeFor(externalEmail) === null,
    "identical invitation semantics for external candidates"
  );
  check(
    "NOT_IN_SYSTEM still creates NO EMPLOYEE account and sends no notification",
    !(await prisma.user.findFirst({ where: { email: externalEmail } })) &&
      notInSystem.candidateNotified === false,
    "an account must never be created for an external candidate"
  );

  section("C. The VERIFICATION email is sent only after a valid invited email is authorized");
  const codesBeforeRequest = codesFor(inSystemEmail);
  const request = await jobService.requestAssessmentEmailVerification(
    jobA.assessment.publicId, inSystemEmail
  );
  const requestCode = latestCodeFor(inSystemEmail);
  const requestKeys = [...collectKeys(request)];
  check(
    "the authorized candidate's email submission DOES send a verification code",
    typeof requestCode === "string" && requestCode.length > 0 && codesFor(inSystemEmail) === codesBeforeRequest + 1,
    summarize({ codes: codesFor(inSystemEmail) })
  );
  check(
    "the verification API response NEVER returns the code, a token or a hash",
    requestKeys.every((key) => !/token|code|hash|secret|password/i.test(key)) &&
      !JSON.stringify(request).includes(requestCode),
    summarize({ keys: requestKeys })
  );

  const invitationRow = await prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId: jobA.assessment.id, email: inSystemEmail } },
  });
  check(
    "the stored challenge is a SHA-256 hash, never the raw code",
    typeof invitationRow.verificationTokenHash === "string" &&
      invitationRow.verificationTokenHash.length === 64 &&
      invitationRow.verificationTokenHash !== requestCode,
    "only the digest may be persisted"
  );

  const candidateUser = await prisma.user.findUnique({ where: { email: inSystemEmail } });
  const notification = await prisma.notification.findFirst({ where: { userId: candidateUser.id } });
  check(
    "the in-app notification payload carries NO verification code",
    notification !== null && !JSON.stringify(notification).includes(requestCode),
    "the notification is navigation only"
  );

  const published = [];
  const originalPublish = realtimePublisher.publishInvitationEvent;
  realtimePublisher.publishInvitationEvent = (payload) => {
    published.push(payload);
    return originalPublish(payload);
  };
  try {
    await jobService.inviteJobCandidate(recruiterA.user, jobA.job.id, 0);
  } finally {
    realtimePublisher.publishInvitationEvent = originalPublish;
  }
  check(
    "the realtime/SSE invitation event carries NO verification code",
    published.length > 0 && published.every((event) => !JSON.stringify(event).includes(requestCode)),
    summarize(published)
  );

  // The SSE re-invite above did NOT touch the challenge (an invite never issues
  // a code), so the candidate's existing code is still the live one. Re-request
  // anyway to prove rotation is driven ONLY by the candidate's own request, then
  // complete the EXISTING verification flow with the code emailed last.
  const fresh = await jobService.requestAssessmentEmailVerification(
    jobA.assessment.publicId, inSystemEmail
  );
  const freshCode = latestCodeFor(inSystemEmail);
  check(
    "re-requesting rotates the challenge and delivers a NEW code",
    typeof freshCode === "string" && freshCode !== requestCode && fresh.alreadyVerified === false,
    summarize({ status: fresh.status })
  );

  const confirmation = await jobService.confirmAssessmentEmailVerification(
    jobA.assessment.publicId, inSystemEmail, freshCode
  );
  const verifiedRow = await prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId: jobA.assessment.id, email: inSystemEmail } },
  });
  check(
    "the emailed code completes the EXISTING email-verification flow",
    confirmation.verified === true && verifiedRow.status === "EMAIL_VERIFIED",
    summarize({ status: verifiedRow.status })
  );
  check(
    "verification CLEARS the stored challenge hash (one-shot code)",
    verifiedRow.verificationTokenHash === null,
    "a used challenge is never reusable"
  );
};

// --- scenario D/E: the recruiter verification report ------------------------
const scenarioVerificationReport = async (ctx) => {
  const { recruiterA, recruiterB, jobA, jobB, inSystemEmail, externalEmail, candidateUserId } = ctx;
  section("D. View Report reads the EXISTING persisted verification reports");

  const listing = await jobService.listJobCandidates(recruiterA.user, jobA.job.id);
  const inRow = listing.candidates.find((candidate) => candidate.email === inSystemEmail);
  const externalRow = listing.candidates.find((candidate) => candidate.email === externalEmail);

  const reportsBefore = await prisma.verificationReport.count({
    where: { verificationAttempt: { userId: candidateUserId } },
  });

  const report = await jobService.getCandidateVerificationReport(
    recruiterA.user, jobA.job.id, inRow.referenceId
  );
  check(
    "the endpoint RESOLVES (it is actually exported and reachable)",
    typeof jobService.getCandidateVerificationReport === "function" && report !== null,
    "the recruiter route must never 500"
  );
  check(
    "it returns the candidate identity from the authorized job reference",
    report.candidateEmail === inSystemEmail && report.systemStatus === "IN_SYSTEM",
    summarize({ email: report.candidateEmail })
  );
  const react = report.verifiedSkills.find((skill) => skill.skillName === "React");
  const javascript = report.verifiedSkills.find((skill) => skill.skillName === "JavaScript");
  check(
    "the correct skills and their STORED verification scores are returned",
    report.verifiedSkills.length === 2 && react?.score === 85 && javascript?.score === 78,
    summarize(report.verifiedSkills.map((s) => ({ skill: s.skillName, score: s.score })))
  );
  check(
    "the stored status, confidence and completion date are returned",
    react?.verificationStatus === "VERIFIED" && react?.confidenceScore === 91 && Boolean(react?.completedAt),
    summarize({ status: react?.verificationStatus, confidence: react?.confidenceScore })
  );
  check(
    "the stored report narrative (summary/strengths/areas) is returned",
    typeof react?.aiSummary === "string" &&
      Array.isArray(react?.strengths) && Array.isArray(react?.areasToImprove),
    summarize({ summary: react?.aiSummary })
  );
  check(
    "the LATEST COMPLETED report per skill is selected (completedAt DESC)",
    new Date(javascript.completedAt).getTime() > new Date(react.completedAt).getTime(),
    summarize(report.verifiedSkills.map((s) => ({ skill: s.skillName, completedAt: s.completedAt })))
  );

  const reportsAfter = await prisma.verificationReport.count({
    where: { verificationAttempt: { userId: candidateUserId } },
  });
  check(
    "reading the report generates NO new verification (no attempt, no report, no AI)",
    reportsAfter === reportsBefore,
    summarize({ before: reportsBefore, after: reportsAfter })
  );

  const reportKeys = collectKeys(report);
  check(
    "the report never exposes tokens, hashes, credentials or evidence payloads",
    [...reportKeys].every((key) => !/token|hash|secret|password|apikey|refreshtoken/i.test(key)) &&
      !reportKeys.has("evidence"),
    summarize({ keys: [...reportKeys] })
  );
  check(
    "the report exposes NO assessment score, hiring score or combined score",
    ![...reportKeys].some((key) =>
      /assessmentScore|hiringScore|overallScore|combinedScore|ranking|recommendation/i.test(key)
    ),
    "verification is never merged with the assessment result"
  );

  section("E. Verification stays separate from assessment, and is correctly scoped");
  await expectRejection(
    "a NOT_IN_SYSTEM candidate has NO verification report (404)",
    () => jobService.getCandidateVerificationReport(recruiterA.user, jobA.job.id, externalRow.referenceId),
    404
  );
  const otherJobRefs = await jobCandidateReferenceRepository.findReferencesByJobId(jobB.job.id);
  await expectRejection(
    "a reference from ANOTHER job cannot be read through this job (404)",
    () => jobService.getCandidateVerificationReport(recruiterA.user, jobA.job.id, otherJobRefs[0].id),
    404
  );
  await expectRejection(
    "a DIFFERENT recruiter cannot read this job's candidate report (403)",
    () => jobService.getCandidateVerificationReport(recruiterB.user, jobA.job.id, inRow.referenceId),
    403
  );
  await expectRejection(
    "an unknown reference id is refused (404)",
    () => jobService.getCandidateVerificationReport(recruiterA.user, jobA.job.id, "no-such-reference"),
    404
  );
};

// An IN_SYSTEM candidate with NO completed verification must report an empty
// state, never a fabricated score.
const scenarioEmptyState = async ({ recruiterA }) => {
  const emptyEmail = uniqueEmail("no-reports");
  await createCandidateWithReports({ email: emptyEmail, skills: [] });
  const emptyJob = await createJobFixture(recruiterA, { label: "empty", rows: [["No Reports", emptyEmail]] });
  await jobCandidateReferenceService.listCandidateReferences(recruiterA.user, emptyJob.job.id);
  const listing = await jobService.listJobCandidates(recruiterA.user, emptyJob.job.id);
  const row = listing.candidates.find((candidate) => candidate.email === emptyEmail);
  const report = await jobService.getCandidateVerificationReport(
    recruiterA.user, emptyJob.job.id, row.referenceId
  );
  check(
    "a candidate with no completed reports yields an EMPTY state, not a fake score",
    report.existingVerifiedSkillScore === null &&
      report.verifiedSkills.length === 0 &&
      report.existingVerifiedSkillCount === 0,
    summarize({ score: report.existingVerifiedSkillScore, skills: report.verifiedSkills.length })
  );
};

// Structural guard: the fixes must not have changed the approved UI/flow.
const scenarioFrontendContract = () => {
  section("F. The approved recruiter UI and invitation flow are unchanged");
  const read = (relative) => require("node:fs").readFileSync(require("node:path").join(__dirname, "..", relative), "utf8");
  const list = read("../frontend/src/components/jobs/CandidateWorkflowList.jsx");
  const modal = read("../frontend/src/components/jobs/CandidateVerificationReportModal.jsx");
  const client = read("../frontend/src/services/jobService.js");

  check("the Excel-like table still renders BOTH category sections", /IN_SYSTEM_COLUMN[\s\S]*NOT_IN_SYSTEM_COLUMN/.test(list));
  check("there is still NO per-row Invite button", !/<button[^>]*>[^<]*\bInvite\b/i.test(list.replace(/Invite Selected/g, "")));
  check("the category-level 'Invite Selected' action is still present", /Invite Selected/.test(list));
  check("the recruiter table still has SEPARATE Verification and Score columns",
    /Verification/.test(list) && /Score/.test(list));
  check("'View Report' still opens the existing modal (no row expansion)",
    /CandidateVerificationReportModal/.test(list) && /onViewReport/.test(list));
  check("the modal renders no verification code, token or storage write",
    !/token|verificationCode|localStorage|sessionStorage/i.test(modal));
  check("the modal now shows the stored Status and Confidence columns",
    />Status</.test(modal) && /Confidence/.test(modal));
  check("the frontend still posts the row-scoped invite (no email field)",
    /\/invite`/.test(client) && !/inviteJobCandidate\s*=\s*async\s*\([^)]*email/i.test(client));
  check("the candidate list response is still the ONLY source of the Verification column",
    /existingVerifiedSkillScore/.test(list));
};

// --- cleanup & report --------------------------------------------------------
const cleanup = async () => {
  const userIds = tracked.userIds;
  const jobIds = tracked.jobIds;
  const removed = {};

  removed.jobAssessmentInvitation = (await prisma.jobAssessmentInvitation.deleteMany({ where: { jobId: { in: jobIds } } })).count;
  removed.jobCandidateAnalysis = (await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: { in: jobIds } } })).count;
  removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: { in: jobIds } } })).count;
  removed.jobQuotaConsumption = (await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: jobIds } } })).count;
  removed.jobAssessmentAttempt = (await prisma.jobAssessmentAttempt.deleteMany({ where: { jobId: { in: jobIds } } })).count;
  removed.jobAssessment = (await prisma.jobAssessment.deleteMany({ where: { jobId: { in: jobIds } } })).count;

  for (const jobId of jobIds) {
    const lists = await prisma.jobCandidateList.findMany({ where: { jobId }, select: { fileId: true } });
    await prisma.jobCandidateReference.deleteMany({ where: { jobId } });
    await prisma.jobCandidateList.deleteMany({ where: { jobId } });
    if (lists.length > 0) {
      await prisma.storedFile.deleteMany({ where: { id: { in: lists.map((l) => l.fileId) } } });
    }
  }
  removed.job = (await prisma.job.deleteMany({ where: { id: { in: jobIds } } })).count;

  removed.verificationReport = (await prisma.verificationReport.deleteMany({ where: { verificationAttempt: { userId: { in: userIds } } } })).count;
  removed.assessmentAnswer = (await prisma.assessmentAnswer.deleteMany({ where: { attempt: { userId: { in: userIds } } } })).count;
  removed.verificationAttempt = (await prisma.verificationAttempt.deleteMany({ where: { userId: { in: userIds } } })).count;

  const profiles = await prisma.employeeProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const profileIds = profiles.map((p) => p.id);
  const skillIds = (await prisma.employeeProfileSkill.findMany({ where: { employeeProfileId: { in: profileIds } }, select: { id: true } })).map((s) => s.id);
  removed.assessmentDefinition = (await prisma.assessmentDefinition.deleteMany({ where: { employeeProfileSkillId: { in: skillIds } } })).count;
  removed.employeeProfileSkill = (await prisma.employeeProfileSkill.deleteMany({ where: { id: { in: skillIds } } })).count;
  removed.employeeProfile = (await prisma.employeeProfile.deleteMany({ where: { id: { in: profileIds } } })).count;
  removed.notification = (await prisma.notification.deleteMany({ where: { userId: { in: userIds } } })).count;
  removed.subscription = (await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } })).count;
  removed.subscriptionPlan = (await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } })).count;
  removed.userRole = (await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })).count;
  removed.user = (await prisma.user.deleteMany({ where: { id: { in: userIds } } })).count;

  return removed;
};

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  verificationReport: await prisma.verificationReport.count(),
  verificationAttempt: await prisma.verificationAttempt.count(),
  employeeProfile: await prisma.employeeProfile.count(),
  notification: await prisma.notification.count(),
});

module.exports = { tracked, cleanup, snapshotTotals, scenarioDeliveryIsReal,
  scenarioInvitationDelivery, scenarioVerificationReport, scenarioEmptyState, scenarioFrontendContract };

// --- run ---------------------------------------------------------------------
const main = async () => {
  originalConsoleLog("Candidate invitation email + verification report harness");
  originalConsoleLog(`run id: ${SUFFIX}`);
  const totalsBefore = await snapshotTotals();
  originalConsoleLog(`platform totals at start: ${summarize(totalsBefore)}`);

  await scenarioDeliveryIsReal();

  const recruiterA = await createRecruiterFixture("A");
  const recruiterB = await createRecruiterFixture("B");
  const inSystemEmail = uniqueEmail("in-system");
  const externalEmail = uniqueEmail("not-in-system");
  const candidate = await createCandidateWithReports({
    email: inSystemEmail,
    skills: [
      { name: "React", score: 85, confidence: 91, status: "VERIFIED", completedAt: new Date(Date.now() - 2 * DAY_IN_MS) },
      { name: "JavaScript", score: 78, confidence: 88, status: "VERIFIED", completedAt: new Date(Date.now() - 1 * DAY_IN_MS) },
    ],
  });
  const jobA = await createJobFixture(recruiterA, {
    label: "A", rows: [["In System Cand", inSystemEmail], ["External Cand", externalEmail]],
  });
  const jobB = await createJobFixture(recruiterA, { label: "B", rows: [["Other Job Cand", uniqueEmail("other-job")]] });
  await jobCandidateReferenceService.listCandidateReferences(recruiterA.user, jobA.job.id);
  await jobCandidateReferenceService.listCandidateReferences(recruiterA.user, jobB.job.id);

  await scenarioInvitationDelivery({ recruiterA, jobA, inSystemEmail, externalEmail });
  await scenarioVerificationReport({
    recruiterA, recruiterB, jobA, jobB, inSystemEmail, externalEmail, candidateUserId: candidate.user.id,
  });
  await scenarioEmptyState({ recruiterA });
  scenarioFrontendContract();

  const removed = await cleanup();
  originalConsoleLog("\nCleanup — deleting every row this harness created");
  originalConsoleLog(`  deleted: ${summarize(removed)}`);
  const totalsAfter = await snapshotTotals();
  originalConsoleLog(`platform totals at end:   ${summarize(totalsAfter)}`);
  check(
    "the database was not reset (every pre-existing row count held or grew)",
    Object.keys(totalsBefore).every((key) => totalsAfter[key] >= totalsBefore[key]),
    summarize({ before: totalsBefore, after: totalsAfter })
  );

  const passed = results.filter((r) => r.ok).length;
  originalConsoleLog(`\n${passed}/${results.length} checks passed`);
  originalConsoleLog(
    "Invitation emails are confirmed against the mail provider, and the recruiter report reads the existing persisted verification reports."
  );
  await prisma.$disconnect();
  process.exitCode = passed === results.length ? 0 : 1;
};

main().catch(async (error) => {
  originalConsoleLog("Harness failed:", error);
  try { await cleanup(); await prisma.$disconnect(); } catch {}
  process.exitCode = 1;
});

