/* eslint-disable no-console */
// Candidate classification verification harness — Phase 1 of the recruiter
// candidate workflow.
//
// Run with:  npm run verify:candidate-classification
//
// Proves, against the REAL database and the REAL service path:
//   A. Pure classification rules — a platform CANDIDATE (EMPLOYEE) account
//      makes a row IN_SYSTEM; anything else is NOT_IN_SYSTEM; matching is
//      case-insensitive; duplicates are reported and never double-counted.
//   B. The existing platform skill score — an in-system candidate's EXISTING
//      verified skill score is projected from the already persisted
//      VerificationReport rows, NEVER recalculated; an in-system candidate
//      without a completed verification reports null (never a fabricated 0);
//      a NOT_IN_SYSTEM candidate reports exactly 0.
//   C. Excel is the only candidate source — the persisted JobCandidateList
//      file drives the list; only the existing Excel fields (Email + optional
//      Name) are read; unsupported candidate fields are reported unavailable
//      instead of invented.
//   D. The read path is inert — no AI job, no queue delivery, no verification
//      attempt/report/evidence change, no invitation change, no quota.
//   E. Authorization — job ownership / org scope is enforced server-side.
//
// Convention follows scripts/verifyJobCandidateList.js (CommonJS, the
// application's own Prisma client, process.exitCode on failure, throwaway
// fixtures tracked by id and deleted in FK-safe order, platform totals printed
// before/after).
require("dotenv").config();

const XLSX = require("xlsx");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const jobCandidateReferenceService = require("../src/module/job/jobCandidateReference.service");
const {
  CANDIDATE_INVITATION_STATUS,
  CANDIDATE_SYSTEM_STATUS,
  UNAVAILABLE_CANDIDATE_FIELDS,
  classifyCandidateRows,
} = require("../src/module/job/jobCandidate.classification");
const {
  parseCandidateListPreview,
  parseCandidateListRows,
} = require("../src/module/job/jobCandidateList.parser");
// The strict route schema, asserted directly: a client-supplied status must be
// REJECTED, proving the backend is the only classification authority.
const { manualCandidateCreateSchema } = require("../src/module/job/job.validation");
const { cleanupJobCandidateLists } = require("./jobCandidateListFixture");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Isolate this run's BullMQ namespace so a real worker can never pick work up
// (and so the "no delivery" assertions below are about this run only).
process.env.AI_QUEUE_PREFIX = `candclass-${SUFFIX}`;
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");

// --- reporting --------------------------------------------------------------

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

// Collects every object key in a JSON structure, so a response can be scanned
// for data that must NEVER leave the server (verification tokens, evidence).
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


// --- fixtures ---------------------------------------------------------------

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  employeeProfileIds: [],
  assessmentIds: [],
};

const uniqueEmails = (count, label) =>
  Array.from(
    { length: count },
    (_, index) =>
      `candclass-${label}-${index}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`
  );

// Recruiter fixture: the job service only reads user.id/user.role from the
// principal (same shortcut as the other harnesses), but the row is real so job
// ownership and FK cleanup behave exactly as in production.
const createRecruiterFixture = async (label, jobPostingLimit = 10) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Candidate Classification Harness ${label}`,
      email: `candclass-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Candidate Classification Harness Plan ${label} ${SUFFIX}`,
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
    originalname: name ?? `candclass-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });


// A real candidate account: a User row carrying the EMPLOYEE role (the
// platform's CANDIDATE identity). When withVerification is true it also gets
// the FULL existing verification chain — EmployeeProfile → skill →
// AssessmentDefinition → VerificationAttempt → VerificationReport — so the
// "existing verified skill score" read is exercised against real persisted rows.
const createCandidateFixture = async ({
  email,
  withVerification = true,
  skillName = "Node.js",
  score = 82,
}) => {
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

  if (!withVerification) {
    return { user, profile, skill, attempt: null, report: null };
  }

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


// A FINALIZED + ACTIVATED assessment for the job, plus invitation rows. Built
// directly because the AI generation pipeline is out of scope for this harness
// (and must not be involved): what matters here is that the classification
// READ reflects real persisted invitation state and never changes it.
const createAssessmentFixture = async (jobId, { invitations = [] } = {}) => {
  const assessment = await prisma.jobAssessment.create({
    data: {
      jobId,
      title: "Harness assessment",
      status: "FINALIZED",
      publicId: `candclass-${SUFFIX}-${Math.random().toString(36).slice(2, 10)}`,
      finalizedAt: new Date(),
      activatedAt: new Date(),
      durationSeconds: 600,
    },
  });
  tracked.assessmentIds.push(assessment.id);

  for (const invitation of invitations) {
    await prisma.jobAssessmentInvitation.create({
      data: {
        jobId,
        assessmentId: assessment.id,
        email: invitation.email,
        status: invitation.status ?? "INVITED",
        expiresAt: invitation.expiresAt ?? new Date(Date.now() + DAY_IN_MS),
        emailVerifiedAt: invitation.status === "EMAIL_VERIFIED" ? new Date() : null,
        verificationTokenHash: invitation.verificationTokenHash ?? null,
      },
    });
  }

  return assessment;
};

const READY_PAYLOAD = {
  title: "Candidate classification harness job",
  yearsExperience: 5,
  description:
    "Harness job used to verify backend-authoritative candidate classification for the recruiter workflow.",
  analysisDays: 3,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe a database migration you have run in production." }],
};

const createDraftFixture = async (recruiter, payload = READY_PAYLOAD) => {
  const draft = await jobService.createDraft(recruiter.user, payload);
  tracked.jobIds.push(draft.id);
  return draft;
};

// Snapshots of the tables the classification read must NEVER touch. Compared
// before/after so "no recalculation, no new evidence, no invitation change" is
// proven rather than assumed.
const snapshotVerificationState = async (userIds) => {
  const scope = { in: userIds };
  const [attempts, reports, evidence] = await Promise.all([
    prisma.verificationAttempt.findMany({
      where: { userId: scope },
      select: { id: true, status: true, testScorePercentage: true, updatedAt: true },
      orderBy: { id: "asc" },
    }),
    prisma.verificationReport.findMany({
      where: { verificationAttempt: { userId: scope } },
      select: { id: true, verificationScore: true, processingStatus: true, updatedAt: true },
      orderBy: { id: "asc" },
    }),
    prisma.verificationEvidence.count({
      where: { verificationReport: { verificationAttempt: { userId: scope } } },
    }),
  ]);
  return {
    attempts: JSON.stringify(attempts),
    reports: JSON.stringify(reports),
    evidenceCount: evidence,
  };
};

const snapshotInvitationState = async (jobIds) => {
  const rows = await prisma.jobAssessmentInvitation.findMany({
    where: { jobId: { in: jobIds } },
    select: {
      id: true,
      email: true,
      status: true,
      expiresAt: true,
      emailVerifiedAt: true,
      verificationTokenHash: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  return JSON.stringify(rows);
};


// --- scenario A: pure classification rules (no database) --------------------

const scenarioPureRules = () => {
  section("A. Classification rules — backend-authoritative IN_SYSTEM / NOT_IN_SYSTEM");

  const rows = [
    { rowIndex: 0, name: "Ali", email: " ALI@Example.com " },
    { rowIndex: 1, name: "Sara", email: "sara@example.com" },
    { rowIndex: 2, name: "Noor", email: "noor@example.com" },
  ];
  const base = {
    rows,
    accountsByEmail: { "ali@example.com": { userId: "u-ali" } },
    verificationByUserId: {
      "u-ali": {
        existingVerifiedSkillScore: 82,
        verifiedSkillCount: 1,
        verifiedSkills: [{ skillName: "Node.js", score: 82 }],
      },
    },
    invitationsByEmail: {},
  };

  const result = classifyCandidateRows(base);
  const [ali, sara] = result.candidates;

  check(
    "a known candidate account is IN_SYSTEM, an unknown email is NOT_IN_SYSTEM",
    ali.systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM &&
      sara.systemStatus === CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM,
    summarize({ ali: ali.systemStatus, sara: sara.systemStatus })
  );
  check(
    "matching is case-insensitive and the email is normalized for display",
    ali.email === "ali@example.com" && ali.candidateUserId === "u-ali",
    summarize({ email: ali.email, userId: ali.candidateUserId })
  );
  check(
    "an in-system candidate shows the EXISTING verified skill score (82) unchanged",
    ali.existingVerifiedSkillScore === 82 && ali.existingVerifiedSkillCount === 1,
    summarize({ score: ali.existingVerifiedSkillScore, skills: ali.existingVerifiedSkills })
  );
  check(
    "a NOT_IN_SYSTEM candidate reports exactly 0 (never a fabricated score)",
    sara.existingVerifiedSkillScore === 0 &&
      sara.existingVerifiedSkillCount === 0 &&
      sara.existingVerifiedSkills.length === 0 &&
      sara.candidateUserId === null,
    summarize({ score: sara.existingVerifiedSkillScore })
  );
  check(
    "an in-system candidate with no completed verification reports null (not 0)",
    classifyCandidateRows({
      ...base,
      rows: [{ rowIndex: 0, email: "noor@example.com" }],
      accountsByEmail: { "noor@example.com": { userId: "u-noor" } },
      verificationByUserId: { "u-noor": { existingVerifiedSkillScore: null, verifiedSkillCount: 0, verifiedSkills: [] } },
    }).candidates[0].existingVerifiedSkillScore === null,
    "expected null"
  );

  // Verification data can never leak onto a row that is not an account.
  const leaked = classifyCandidateRows({
    ...base,
    rows: [{ rowIndex: 0, email: "ghost@example.com" }],
    accountsByEmail: {},
    verificationByUserId: {
      "u-ghost": { existingVerifiedSkillScore: 97, verifiedSkillCount: 3, verifiedSkills: [] },
    },
  }).candidates[0];
  check(
    "a NOT_IN_SYSTEM row can never pick up another user's verification data",
    leaked.existingVerifiedSkillScore === 0 && leaked.existingVerifiedSkills.length === 0,
    summarize(leaked)
  );

  // Duplicates: reported, never double-counted as two distinct candidates.
  const duplicated = classifyCandidateRows({
    ...base,
    rows: [
      { rowIndex: 0, email: "ALI@example.com" },
      { rowIndex: 1, email: "ali@example.com" },
      { rowIndex: 2, email: "sara@example.com" },
    ],
  });
  check(
    "duplicate emails are reported and counted once per distinct address",
    duplicated.summary.candidateCount === 3 &&
      duplicated.summary.distinctCandidateEmailCount === 2 &&
      duplicated.summary.duplicateEmails.length === 1 &&
      duplicated.summary.duplicateEmails[0] === "ali@example.com",
    summarize(duplicated.summary)
  );
  check(
    "both duplicate rows classify identically (same account, same existing score)",
    duplicated.candidates[0].existingVerifiedSkillScore === 82 &&
      duplicated.candidates[1].existingVerifiedSkillScore === 82,
    summarize(duplicated.candidates.map((c) => c.existingVerifiedSkillScore))
  );
};


// --- scenario B: invitation projection, field honesty, parser contract ------

const scenarioProjectionAndParser = () => {
  section("B. Invitation projection, field availability and the Excel row read");

  const now = new Date("2026-09-21T12:00:00.000Z");
  const future = new Date(now.getTime() + DAY_IN_MS);
  const past = new Date(now.getTime() - DAY_IN_MS);
  const rows = [
    { rowIndex: 0, name: "A", email: "not-invited@example.com" },
    { rowIndex: 1, name: "B", email: "invited@example.com" },
    { rowIndex: 2, name: "C", email: "verified@example.com" },
    { rowIndex: 3, name: "D", email: "expired@example.com" },
  ];
  const projected = classifyCandidateRows({
    rows,
    invitationsByEmail: {
      "invited@example.com": { status: "INVITED", expiresAt: future, invitedAt: past },
      "verified@example.com": { status: "EMAIL_VERIFIED", expiresAt: future },
      "expired@example.com": { status: "INVITED", expiresAt: past },
    },
    now,
  });
  const [notInvited, invited, verified, expired] = projected.candidates;

  check(
    "invitation status is projected from the persisted invitation rows",
    notInvited.invitationStatus === CANDIDATE_INVITATION_STATUS.NOT_INVITED &&
      invited.invitationStatus === CANDIDATE_INVITATION_STATUS.INVITED &&
      verified.invitationStatus === CANDIDATE_INVITATION_STATUS.EMAIL_VERIFIED &&
      expired.invitationStatus === CANDIDATE_INVITATION_STATUS.EXPIRED,
    summarize(projected.candidates.map((c) => c.invitationStatus))
  );
  check(
    "the projected invitation never exposes a verification token or challenge",
    !("verificationTokenHash" in invited) && !("verificationExpiresAt" in verified),
    summarize(Object.keys(invited))
  );
  check(
    "invitation summary counts mirror the rows",
    projected.summary.invitedCount === 1 &&
      projected.summary.emailVerifiedCount === 1 &&
      projected.summary.expiredInvitationCount === 1 &&
      projected.summary.notInvitedCount === 1,
    summarize(projected.summary)
  );
  check(
    "fields the current Excel contract does not carry are null, never invented",
    Object.entries(UNAVAILABLE_CANDIDATE_FIELDS).every(
      ([field, value]) => notInvited[field] === value
    ),
    summarize(UNAVAILABLE_CANDIDATE_FIELDS)
  );
  const flags = projected.availableCandidateFields;
  check(
    "availableCandidateFields advertises email + name and no unsupported field",
    flags.email === true &&
      flags.name === true &&
      flags.preferredRole === false &&
      flags.skills === false &&
      flags.resumeReference === false &&
      flags.linkedinReference === false &&
      flags.githubReference === false,
    summarize(flags)
  );

  // Excel row read: Name resolved BY HEADER, Email by header, rowIndex stable.
  const named = parseCandidateListRows(
    buildSheet([
      ["Name", "Email"],
      ["Ali", "ali@example.com"],
      ["Sara", "SARA@example.com"],
    ])
  );
  check(
    "the workflow row read resolves Name by header and keeps file order",
    named.rows.length === 2 &&
      named.rows[0].name === "Ali" &&
      named.rows[0].email === "ali@example.com" &&
      named.rows[1].rowIndex === 1 &&
      named.rows[1].email === "SARA@example.com",
    summarize(named.rows)
  );
  const emailOnly = parseCandidateListRows(buildSheet([["Email"], ["only@example.com"]]));
  check(
    "an Email-only sheet yields no fabricated name (the email is never echoed as a name)",
    emailOnly.rows.length === 1 &&
      classifyCandidateRows({ rows: emailOnly.rows }).candidates[0].name === null,
    summarize(emailOnly.rows)
  );
  const limited = parseCandidateListRows(
    buildSheet([
      ["Name", "Email"],
      ["A", "a@example.com"],
      ["B", "b@example.com"],
      ["C", "c@example.com"],
    ]),
    2
  );
  check(
    "the workflow row read honours the row limit while still counting the whole file",
    limited.candidateCount === 3 && limited.rows.length === 2,
    summarize({ count: limited.candidateCount, rows: limited.rows.length })
  );
  const preview = parseCandidateListPreview(buildSheet([["Email"], ["preview@example.com"]]));
  check(
    "the shipped preview contract is unchanged (no rowIndex field added there)",
    preview.rows.length === 1 && !("rowIndex" in preview.rows[0]),
    summarize(preview.rows[0])
  );
};

// --- scenario C: classification through the production service path ---------

const scenarioIntegration = async (recruiter) => {
  section("C. Job candidate list — REAL candidate accounts, REAL persisted list");

  // Two REAL candidate accounts. The first is stored with NON-lowercase letters
  // on purpose: the sheet below refers to it in lower case, which is exactly the
  // case-insensitive matching rule the workflow must apply.
  const withScore = await createCandidateFixture({
    email: `CandClass.Scored.${SUFFIX}@Example.Test`,
    score: 82,
  });
  const withoutScore = await createCandidateFixture({
    email: `candclass.unscored.${SUFFIX}@example.test`,
    withVerification: false,
  });
  const unknown = uniqueEmails(2, "unknown");

  const draft = await createDraftFixture(recruiter);
  const sheet = buildSheet([
    ["Name", "Email"],
    ["Ali", `   ${withScore.user.email.toLowerCase()}   `],
    ["Sara", unknown[0]],
    ["Noor", withoutScore.user.email],
    ["Hana", unknown[1]],
  ]);
  await uploadList(recruiter, draft.id, sheet, `candclass-ok-${SUFFIX}.xlsx`);

  const verificationBefore = await snapshotVerificationState([
    withScore.user.id,
    withoutScore.user.id,
  ]);

  const listing = await jobService.listJobCandidates(recruiter.user, draft.id);

  check(
    "the persisted candidate list drives the listing (4 rows, file metadata only)",
    listing.candidates.length === 4 &&
      listing.candidateList.candidateCount === 4 &&
      Boolean(listing.candidateList.file?.originalName) &&
      !("storagePath" in (listing.candidateList.file ?? {})),
    summarize(listing.candidateList)
  );
  check(
    "a registered candidate is IN_SYSTEM with its EXISTING verified skill score (82)",
    listing.candidates[0].systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM &&
      listing.candidates[0].existingVerifiedSkillScore === 82 &&
      listing.candidates[0].existingVerifiedSkills?.[0]?.skillName === "Node.js" &&
      listing.candidates[0].name === "Ali",
    summarize(listing.candidates[0])
  );
  check(
    "email matching is case-insensitive (stored mixed case, sheet lower case)",
    listing.candidates[0].email === withScore.user.email.toLowerCase() &&
      withScore.user.email !== listing.candidates[0].email,
    summarize({ stored: withScore.user.email, listed: listing.candidates[0].email })
  );
  check(
    "an unregistered candidate is NOT_IN_SYSTEM with existing score 0",
    listing.candidates[1].systemStatus === CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM &&
      listing.candidates[1].existingVerifiedSkillScore === 0 &&
      listing.candidates[1].candidateUserId === null,
    summarize(listing.candidates[1])
  );
  check(
    "an in-system candidate with NO verification reports null (nothing fabricated)",
    listing.candidates[2].systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM &&
      listing.candidates[2].existingVerifiedSkillScore === null,
    summarize(listing.candidates[2])
  );
  check(
    "summary counts split the list by system status",
    listing.summary.candidateCount === 4 &&
      listing.summary.inSystemCount === 2 &&
      listing.summary.notInSystemCount === 2 &&
      listing.summary.notInvitedCount === 4 &&
      listing.summary.rowsReturned === 4,
    summarize(listing.summary)
  );
  check(
    "no assessment exists yet, so the listing reports none (no invented status)",
    listing.assessment === null,
    summarize(listing.assessment)
  );
  check(
    "the platform score is labelled as coming from stored verification reports",
    listing.existingVerifiedSkillScoreSource === "STORED_PLATFORM_VERIFICATION_REPORTS",
    summarize(listing.existingVerifiedSkillScoreSource)
  );

  return { draft, listing, withScore, withoutScore, unknown, verificationBefore };
};

// --- scenario D: the read is inert + invitation projection is per assessment -

const scenarioInertReadAndInvitations = async ({
  recruiter,
  other,
  draft,
  withScore,
  withoutScore,
  unknown,
  verificationBefore,
}) => {
  section("D. Inert read + per-assessment invitation projection");

  // 1. Nothing about the candidate's earlier verification may change.
  const verificationAfter = await snapshotVerificationState([
    withScore.user.id,
    withoutScore.user.id,
  ]);
  check(
    "the existing verification attempts/reports/evidence were NOT recalculated or touched",
    verificationBefore.attempts === verificationAfter.attempts &&
      verificationBefore.reports === verificationAfter.reports &&
      verificationBefore.evidenceCount === verificationAfter.evidenceCount,
    summarize({ before: verificationBefore, after: verificationAfter })
  );
  check(
    "classification created no AiJob and consumed no quota",
    (await prisma.aiJob.count({ where: { jobId: draft.id } })) === 0 &&
      (await prisma.jobQuotaConsumption.count({ where: { jobId: draft.id } })) === 0,
    summarize({
      aiJobs: await prisma.aiJob.count({ where: { jobId: draft.id } }),
      quota: await prisma.jobQuotaConsumption.count({ where: { jobId: draft.id } }),
    })
  );
  check(
    "no candidate row was written (the recruiter Excel file stays the only candidate source)",
    (await prisma.jobCandidateList.count({ where: { jobId: draft.id } })) === 1,
    summarize({
      candidateLists: await prisma.jobCandidateList.count({ where: { jobId: draft.id } }),
    })
  );

  // 2. Nothing the recruiter AI pipeline must never receive can appear here: no
  //    verification evidence, no analysis summaries, no tokens, no AI payloads.
  const listing = await jobService.listJobCandidates(recruiter.user, draft.id);
  const responseKeys = collectKeys(listing);
  const forbiddenKeys = [
    "verificationTokenHash",
    "verificationExpiresAt",
    "storagePath",
    "requestPayload",
    "snapshot",
    "analysisSummary",
    "evidence",
    "passwordHash",
    "token",
  ];
  check(
    "the response carries no verification evidence, tokens or AI payloads",
    forbiddenKeys.every((key) => !responseKeys.has(key)),
    summarize([...responseKeys].filter((key) => forbiddenKeys.includes(key)))
  );

  const limited = await jobService.listJobCandidates(recruiter.user, draft.id, { limit: 2 });
  check(
    "the row limit caps the returned rows without changing the file count",
    limited.candidates.length === 2 &&
      limited.summary.rowsReturned === 2 &&
      limited.candidateList.candidateCount === 4,
    summarize({ rows: limited.candidates.length, summary: limited.summary })
  );

  // 3. Invitation projection against REAL persisted invitation rows.
  const jobA = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    jobA.id,
    buildSheet([
      ["Name", "Email"],
      ["Invited", unknown[0]],
      ["Verified", withoutScore.user.email],
      ["Expired", unknown[1]],
      ["Plain", withScore.user.email.toLowerCase()],
    ]),
    `candclass-inv-a-${SUFFIX}.xlsx`
  );
  await createAssessmentFixture(jobA.id, {
    invitations: [
      { email: unknown[0], status: "INVITED", expiresAt: new Date(Date.now() + DAY_IN_MS) },
      { email: withoutScore.user.email, status: "EMAIL_VERIFIED" },
      {
        email: unknown[1],
        status: "INVITED",
        expiresAt: new Date(Date.now() - DAY_IN_MS),
        verificationTokenHash: "harness-hash-not-a-real-token",
      },
    ],
  });

  // A DIFFERENT job with the SAME email and its OWN assessment/invitation: the
  // two listings must never mix, which proves job + assessment scoping.
  const jobB = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    jobB.id,
    buildSheet([
      ["Name", "Email"],
      [null, unknown[0]],
    ]),
    `candclass-inv-b-${SUFFIX}.xlsx`
  );
  await createAssessmentFixture(jobB.id, {
    invitations: [{ email: unknown[0], status: "EMAIL_VERIFIED" }],
  });

  const invitationStateBefore = await snapshotInvitationState([jobA.id, jobB.id]);
  const listingA = await jobService.listJobCandidates(recruiter.user, jobA.id);
  const listingB = await jobService.listJobCandidates(recruiter.user, jobB.id);
  const invitationStateAfter = await snapshotInvitationState([jobA.id, jobB.id]);

  check(
    "invitation status per candidate mirrors the job's own invitation rows",
    listingA.candidates[0].invitationStatus === CANDIDATE_INVITATION_STATUS.INVITED &&
      listingA.candidates[1].invitationStatus === CANDIDATE_INVITATION_STATUS.EMAIL_VERIFIED &&
      listingA.candidates[2].invitationStatus === CANDIDATE_INVITATION_STATUS.EXPIRED &&
      listingA.candidates[3].invitationStatus === CANDIDATE_INVITATION_STATUS.NOT_INVITED,
    summarize(listingA.candidates.map((c) => c.invitationStatus))
  );
  check(
    "invitations are scoped to the exact job/assessment (job B verified, job A invited)",
    listingB.candidates[0].invitationStatus === CANDIDATE_INVITATION_STATUS.EMAIL_VERIFIED &&
      listingA.candidates[0].invitationStatus === CANDIDATE_INVITATION_STATUS.INVITED,
    summarize({
      jobA: listingA.candidates[0].invitationStatus,
      jobB: listingB.candidates[0].invitationStatus,
    })
  );
  check(
    "the activated assessment is reported read-only (status + activation timestamp)",
    listingA.assessment?.status === "FINALIZED" && Boolean(listingA.assessment?.activatedAt),
    summarize(listingA.assessment)
  );
  check(
    "the classification read never mutates invitation rows (verification-token hash included)",
    invitationStateBefore === invitationStateAfter,
    summarize({ before: invitationStateBefore, after: invitationStateAfter })
  );
  check(
    "an invitation's verification challenge never reaches the response",
    !collectKeys(listingA).has("verificationTokenHash"),
    summarize({ keys: [...collectKeys(listingA)].length })
  );

  // 4. Authorization: the same read through another recruiter's principal.
  await expectRejection(
    "a different recruiter cannot read another job's candidate classification",
    () => jobService.listJobCandidates(other.user, draft.id),
    403
  );
  await expectRejection(
    "an unknown job id is a 404",
    () => jobService.listJobCandidates(recruiter.user, `missing-${SUFFIX}`),
    404
  );

  const empty = await createDraftFixture(recruiter);
  const noListError = await expectRejection(
    "a job without an uploaded candidate list is refused (nothing to classify)",
    () => jobService.listJobCandidates(recruiter.user, empty.id),
    400
  );
  check(
    "the missing-list rejection is the existing candidate-list message",
    Boolean(noListError?.message?.startsWith("Candidate list is required")),
    summarize(noListError?.message)
  );

  return { jobReady: true };
};

// --- scenario E: MANUAL candidate addition = the SAME authoritative rule ------
//
// The bug this scenario pins down: a candidate the recruiter adds manually must
// be classified by the SAME backend rule that classifies an imported Excel row.
// Both paths call jobService.classifyJobCandidates → classifyCandidateRows, so
// for the same email the answer must be identical.

const scenarioManualAdd = async (recruiter, other) => {
  section("E. Manual candidate addition — same classification rule as the Excel path");

  // Case A/B: two fresh addresses. One belongs to a REAL EMPLOYEE account
  // (registered), the other is not registered at all.
  const registered = await createCandidateFixture({
    email: `candclass.manual.registered.${SUFFIX}@example.test`,
    score: 77,
    withVerification: false,
  });
  const externalEmail = `candclass.manual.external.${SUFFIX}@example.test`;

  // A registered account that is NOT a candidate: the classifier must not treat
  // an unrelated account role as an eligible candidate.
  const nonCandidateEmail = `candclass.manual.recruiter.${SUFFIX}@example.test`;
  const nonCandidateUser = await prisma.user.create({
    data: {
      email: nonCandidateEmail,
      fullName: "Not a candidate",
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const recruiterRole = await prisma.role.findUnique({ where: { name: "RECRUITER" } });
  await prisma.userRole.create({
    data: { userId: nonCandidateUser.id, roleId: recruiterRole.id },
  });
  tracked.userIds.push(nonCandidateUser.id);

  // The parity candidate (Case C/D) is created up here with the other fixtures
  // so the §14 "no user creation" count below can only move if the MANUAL ADD
  // path itself created an account.
  const parityEmails = [
    `candclass.parity.registered.${SUFFIX}@example.test`,
    `candclass.parity.external.${SUFFIX}@example.test`,
  ];
  await createCandidateFixture({ email: parityEmails[0], withVerification: false });

  const draft = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    draft.id,
    buildSheet([["Name", "Email"], ["Excel", `candclass.manual.excel.${SUFFIX}@example.test`]]),
    `candclass-manual-${SUFFIX}.xlsx`
  );

  const usersBefore = await prisma.user.count();
  const registeredUserBefore = await prisma.user.findUnique({
    where: { id: registered.user.id },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      status: true,
      isDeleted: true,
      emailVerified: true,
      fullName: true,
      provider: true,
      updatedAt: true,
      _count: { select: { roles: true, subscriptions: true } },
    },
  });

  // --- Case A: existing system candidate, added manually ---------------------
  const addedRegistered = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, draft.id, {
    email: registered.user.email,
  });

  check(
    "Case A: a manually added registered EMPLOYEE email is IN_SYSTEM",
    addedRegistered.candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM,
    summarize(addedRegistered.candidate)
  );
  check(
    "Case A: the manual response is the backend's own classification, not a client claim",
    addedRegistered.candidate.candidateUserId === registered.user.id &&
      // This fixture has no completed verification, so the EXISTING contract
      // reports null (an absent score is never turned into a fabricated 0).
      addedRegistered.candidate.existingVerifiedSkillScore === null,
    summarize({
      candidateUserId: addedRegistered.candidate.candidateUserId,
      score: addedRegistered.candidate.existingVerifiedSkillScore,
    })
  );

  // --- Case B: external candidate, added manually ---------------------------
  const addedExternal = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, draft.id, {
    email: externalEmail,
  });

  check(
    "Case B: a manually added unregistered email is NOT_IN_SYSTEM",
    addedExternal.candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM &&
      addedExternal.candidate.candidateUserId === null &&
      addedExternal.candidate.existingVerifiedSkillScore === 0,
    summarize(addedExternal.candidate)
  );
  check(
    "an unrelated RECRUITER account sharing the email is NOT counted as a candidate",
    (await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, draft.id, { email: nonCandidateEmail }))
      .candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM,
    "a non-EMPLOYEE account must yield NOT_IN_SYSTEM"
  );

  // --- Case C/D: Excel and manual agree for the SAME email -------------------
  // One job carries the addresses through the Excel path, a second job adds
  // exactly the same addresses through the manual path.
  const parityDraft = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    parityDraft.id,
    buildSheet([["Name", "Email"], ["Parity", parityEmails[0]], ["Parity", parityEmails[1]]]),
    `candclass-parity-excel-${SUFFIX}.xlsx`
  );
  const excelListing = await jobService.listJobCandidates(recruiter.user, parityDraft.id);

  const manualDraft = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    manualDraft.id,
    buildSheet([["Name", "Email"], ["Seed", `candclass.parity.seed.${SUFFIX}@example.test`]]),
    `candclass-parity-manual-${SUFFIX}.xlsx`
  );
  const manualRegistered = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, manualDraft.id, {
    email: parityEmails[0],
  });
  const manualExternal = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, manualDraft.id, {
    email: parityEmails[1],
  });
  const manualListing = await jobService.listJobCandidates(recruiter.user, manualDraft.id);

  const excelRegistered = excelListing.candidates.find((row) => row.email === parityEmails[0]);
  const excelExternal = excelListing.candidates.find((row) => row.email === parityEmails[1]);
  const listedManualRegistered = manualListing.candidates.find(
    (row) => row.email === parityEmails[0]
  );

  check(
    "Case C: Excel registered → IN_SYSTEM and manual registered → IN_SYSTEM (parity)",
    excelRegistered?.systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM &&
      manualRegistered.candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM &&
      listedManualRegistered?.systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM,
    summarize({
      excel: excelRegistered?.systemStatus,
      manual: manualRegistered.candidate.systemStatus,
      listed: listedManualRegistered?.systemStatus,
    })
  );
  check(
    "Case D: Excel external → NOT_IN_SYSTEM and manual external → NOT_IN_SYSTEM (parity)",
    excelExternal?.systemStatus === CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM &&
      manualExternal.candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM,
    summarize({
      excel: excelExternal?.systemStatus,
      manual: manualExternal.candidate.systemStatus,
    })
  );
  check(
    "a manually added candidate appears in the persisted candidate list",
    manualListing.candidates.some((row) => row.email === parityEmails[1]),
    summarize(manualListing.candidates.map((row) => row.email))
  );
  check(
    "the manual row carries a job-scoped reference id and no spreadsheet row id",
    listedManualRegistered?.referenceId != null && listedManualRegistered?.id === null,
    summarize({
      referenceId: listedManualRegistered?.referenceId,
      id: listedManualRegistered?.id,
    })
  );

  // --- Case E: Excel candidate + manual add of the SAME email ---------------
  const sharedEmail = `candclass.dupe.excelfirst.${SUFFIX}@example.test`;
  const excelFirst = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    excelFirst.id,
    buildSheet([["Name", "Email"], ["Excel", sharedEmail]]),
    `candclass-dupe-e-${SUFFIX}.xlsx`
  );
  const refsAfterExcel = await prisma.jobCandidateReference.count({
    where: { jobId: excelFirst.id, candidateEmail: sharedEmail },
  });
  // Deliberately a DIFFERENT casing of the same address.
  const again = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, excelFirst.id, {
    email: sharedEmail.toUpperCase(),
  });
  const refsAfterManual = await prisma.jobCandidateReference.count({
    where: { jobId: excelFirst.id, candidateEmail: sharedEmail },
  });

  check(
    "Case E: Excel candidate + manual add of the same email → exactly ONE reference",
    refsAfterExcel === 1 &&
      refsAfterManual === 1 &&
      again.candidate.referenceId != null,
    summarize({ refsAfterExcel, refsAfterManual })
  );

  // --- Case F: manual candidate + Excel import of the SAME email ------------
  const reverseEmail = `candclass.dupe.manualfirst.${SUFFIX}@example.test`;
  const manualFirst = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    manualFirst.id,
    buildSheet([["Name", "Email"], ["Seed", `candclass.dupe.seed.${SUFFIX}@example.test`]]),
    `candclass-dupe-m-${SUFFIX}.xlsx`
  );
  const manualFirstAdd = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, manualFirst.id, {
    email: reverseEmail,
  });
  // A replacement sheet that ALSO contains the manual candidate must stay
  // seed-only: it adds nothing and overwrites nothing.
  await uploadList(
    recruiter,
    manualFirst.id,
    buildSheet([
      ["Name", "Email"],
      ["Recruiter edit", reverseEmail],
      ["Sheet", `candclass.dupe.sheet.${SUFFIX}@example.test`],
    ]),
    `candclass-dupe-f-${SUFFIX}.xlsx`
  );
  const reverseRows = await prisma.jobCandidateReference.findMany({
    where: { jobId: manualFirst.id, candidateEmail: reverseEmail },
    select: { id: true, candidateName: true },
  });

  check(
    "Case F: manual candidate + Excel import of the same email → exactly ONE reference",
    reverseRows.length === 1 && reverseRows[0].id === manualFirstAdd.candidate.referenceId,
    summarize(reverseRows)
  );
  check(
    "the Excel import did not overwrite the recruiter-owned candidate reference",
    reverseRows[0].candidateName === null,
    summarize(reverseRows[0])
  );

  // --- Case G: the existing normalization contract --------------------------
  const addedMixed = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, draft.id, {
    email: `  CandClass.Mixed.${SUFFIX}@Example.Test  `,
  });
  const addedLower = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, draft.id, {
    email: `candclass.mixed.${SUFFIX}@example.test`,
  });

  check(
    "Case G: case + surrounding whitespace normalize to the same single candidate",
    addedMixed.candidate.email === `candclass.mixed.${SUFFIX}@example.test` &&
      addedLower.candidate.referenceId === addedMixed.candidate.referenceId &&
      (await prisma.jobCandidateReference.count({
        where: { jobId: draft.id, candidateEmail: `candclass.mixed.${SUFFIX}@example.test` },
      })) === 1,
    summarize({ first: addedMixed.candidate.email, second: addedLower.candidate.email })
  );

  // --- Case H: concurrent manual adds of the same email --------------------
  const concurrentEmail = `candclass.concurrent.${SUFFIX}@example.test`;
  const raceDraft = await createDraftFixture(recruiter);
  await uploadList(
    recruiter,
    raceDraft.id,
    buildSheet([["Name", "Email"], ["Seed", `candclass.concurrent.seed.${SUFFIX}@example.test`]]),
    `candclass-race-${SUFFIX}.xlsx`
  );
  const concurrent = await Promise.all([
    jobCandidateReferenceService.addManualCandidateReference(recruiter.user, raceDraft.id, { email: concurrentEmail }),
    jobCandidateReferenceService.addManualCandidateReference(recruiter.user, raceDraft.id, { email: concurrentEmail }),
    jobCandidateReferenceService.addManualCandidateReference(recruiter.user, raceDraft.id, {
      email: concurrentEmail.toUpperCase(),
    }),
  ]);
  const raceRows = await prisma.jobCandidateReference.count({
    where: { jobId: raceDraft.id, candidateEmail: concurrentEmail },
  });

  check(
    "Case H: three simultaneous manual adds create exactly ONE reference",
    raceRows === 1,
    summarize({ raceRows })
  );
  check(
    "every concurrent caller receives the same reference identity",
    new Set(concurrent.map((entry) => entry.candidate.referenceId)).size === 1,
    summarize(concurrent.map((entry) => entry.candidate.referenceId))
  );

  // --- §6/§25: the backend owns the classification, and validates input -----
  const strictRejected = manualCandidateCreateSchema.safeParse({
    email: externalEmail,
    status: "IN_SYSTEM",
  });
  const missingEmail = manualCandidateCreateSchema.safeParse({});
  const invalidEmail = manualCandidateCreateSchema.safeParse({ email: "not-an-email" });
  const blankEmail = manualCandidateCreateSchema.safeParse({ email: "   " });

  check(
    "a client-supplied status is rejected by the strict route schema",
    strictRejected.success === false,
    summarize(strictRejected.success)
  );
  check(
    "missing / invalid / whitespace-only email is rejected at the boundary",
    missingEmail.success === false &&
      invalidEmail.success === false &&
      blankEmail.success === false,
    summarize({
      missing: missingEmail.success,
      invalid: invalidEmail.success,
      blank: blankEmail.success,
    })
  );
  await expectRejection(
    "a missing email is refused by the service too (direct call, no route)",
    () => jobCandidateReferenceService.addManualCandidateReference(recruiter.user, draft.id, {}),
    400
  );
  await expectRejection(
    "an invalid email is refused by the service too (direct call, no route)",
    () => jobCandidateReferenceService.addManualCandidateReference(recruiter.user, draft.id, { email: "nope" }),
    400
  );

  // --- §8/§17: authorization + no data leakage ------------------------------
  await expectRejection(
    "another recruiter cannot add a candidate to this job",
    () => jobCandidateReferenceService.addManualCandidateReference(other.user, draft.id, { email: externalEmail }),
    403
  );
  await expectRejection(
    "an unknown job id is a 404",
    () =>
      jobCandidateReferenceService.addManualCandidateReference(recruiter.user, `missing-${SUFFIX}`, {
        email: externalEmail,
      }),
    404
  );

  const forbiddenKeys = [
    "password",
    "passwordHash",
    "token",
    "verificationTokenHash",
    "refreshToken",
    "subscription",
    "user",
    "roles",
    "provider",
    "phone",
  ];
  const manualResponseKeys = collectKeys(addedRegistered);
  check(
    "the manual-add response exposes no credential, token or private account field",
    forbiddenKeys.every((key) => !manualResponseKeys.has(key)),
    summarize([...manualResponseKeys].filter((key) => forbiddenKeys.includes(key)))
  );

  // --- §14/§15: no user creation, no user modification ---------------------
  const usersAfter = await prisma.user.count();
  const registeredUserAfter = await prisma.user.findUnique({
    where: { id: registered.user.id },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      status: true,
      isDeleted: true,
      emailVerified: true,
      fullName: true,
      provider: true,
      updatedAt: true,
      _count: { select: { roles: true, subscriptions: true } },
    },
  });

  check(
    "§14: adding candidates created NO user accounts (the external address stayed unregistered)",
    usersAfter === usersBefore &&
      (await prisma.user.count({ where: { email: externalEmail } })) === 0 &&
      (await prisma.user.count({ where: { email: nonCandidateEmail } })) === 1,
    summarize({ usersBefore, usersAfter })
  );
  check(
    "§15: the recognized existing user is completely untouched",
    JSON.stringify(registeredUserBefore) === JSON.stringify(registeredUserAfter),
    summarize({ registeredUserBefore, registeredUserAfter })
  );
  check(
    "the manual add created no AiJob and consumed no quota (no analysis, no AI)",
    (await prisma.aiJob.count({ where: { jobId: draft.id } })) === 0 &&
      (await prisma.jobQuotaConsumption.count({ where: { jobId: draft.id } })) === 0,
    summarize({ aiJobs: await prisma.aiJob.count({ where: { jobId: draft.id } }) })
  );

  // --- §16: cross-job isolation -------------------------------------------
  const jobARef = addedRegistered.candidate.referenceId;
  const jobB = await createDraftFixture(recruiter);
  const sameEmailInJobB = await jobCandidateReferenceService.addManualCandidateReference(recruiter.user, jobB.id, {
    email: registered.user.email,
  });
  const jobBRefs = await prisma.jobCandidateReference.findMany({
    where: { jobId: jobB.id },
    select: { id: true, jobId: true },
  });

  check(
    "§16: the same email in another job is a separate job-scoped reference (no global candidate)",
    sameEmailInJobB.candidate.referenceId !== jobARef &&
      jobBRefs.every((row) => row.jobId === jobB.id),
    summarize({
      jobAReference: jobARef,
      jobBReference: sameEmailInJobB.candidate.referenceId,
    })
  );
  check(
    "§16: both jobs classify the same email identically",
    sameEmailInJobB.candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM,
    summarize(sameEmailInJobB.candidate.systemStatus)
  );
};


// --- cleanup & report -------------------------------------------------------

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
  verificationAttempt: await prisma.verificationAttempt.count(),
  verificationReport: await prisma.verificationReport.count(),
});

// Deletes exactly what this harness created, in FK-safe order: invitations and
// assessments before their jobs, candidate lists (JobCandidateList → StoredFile)
// before job rows (Restrict FKs), the whole verification chain before the
// candidate accounts, and users last. Scoped strictly to tracked ids.
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
    removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: { in: jobIds } } })).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    // Candidate references (including any created by MANUAL addition) cascade
    // with the Job, but are deleted explicitly first so the leftover count is
    // deterministic and independent of the FK cascade.
    removed.jobCandidateReference = (
      await prisma.jobCandidateReference.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    const candidateLists = await cleanupJobCandidateLists(prisma, jobIds);
    removed.jobCandidateList = candidateLists.jobCandidateList;
    removed.storedFile = candidateLists.storedFile;
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

// Leftover check: every tracked fixture id must be gone, and no candidate-list
// file this run uploaded may survive (rows first, then the scoped count).
const countLeftovers = async () => {
  const [
    users,
    jobs,
    profiles,
    attempts,
    reports,
    invitations,
    assessments,
    lists,
    references,
  ] = await Promise.all([
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
      prisma.jobCandidateReference.count({ where: { jobId: { in: tracked.jobIds } } }),
    ]);
  return (
    users +
    jobs +
    profiles +
    attempts +
    reports +
    invitations +
    assessments +
    lists +
    references
  );
};


// --- runner -----------------------------------------------------------------

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
    "Candidate classification verified: backend-authoritative IN_SYSTEM / NOT_IN_SYSTEM, " +
      "existing verified skill score shown as-is (never recalculated), no AI, no quota."
  );
};

const run = async () => {
  console.log("Candidate classification verification harness (Phase 1)");
  console.log(`run id: ${SUFFIX}`);

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);

  try {
    scenarioPureRules();
    scenarioProjectionAndParser();

    const recruiter = await createRecruiterFixture("main", 5);
    const other = await createRecruiterFixture("other", 5);
    const integration = await scenarioIntegration(recruiter);
    await scenarioInertReadAndInvitations({ recruiter, other, ...integration });
    await scenarioManualAdd(recruiter, other);
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

