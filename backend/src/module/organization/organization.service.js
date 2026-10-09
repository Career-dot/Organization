const crypto = require("crypto");

const {
  findOrganizationById,
  countRecruiterMembershipsByStatus,
  listRecruiterMemberships,
  findMembershipByIdInOrganization,
  findMembershipByUserIdInOrganization,
  updateMembershipStatus,
  createActiveRecruiter,
  resetRecruiterPassword,
  updateOrganizationProfile: updateOrgProfileInRepository,
  findOrganizationLogoByOwnerId,
  countOrganizationJobsByRecruiter,
  countOrganizationActivityByRecruiter,
  countOrganizationJobsByRecruiterInRange,
  countSubmittedAssessmentsInRange,
  findOrganizationJobsByRecruiter,
  findActiveRecruiterMembership,
  permanentlyDeleteRecruiterAccount,
  countOrganizationCandidateStats,
  countOrganizationAnalysisStatus,
  listOrganizationJobsForAudit,
  countOrganizationMonthlyActivity,
  countOrganizationAssessmentActivity,
  searchRecruiterMemberships,
  countAssessmentActivityByRecruiter,
  countUnattributedHistoricalJobs,
} = require("./organization.repository");

const {
  findActiveOrganizationMembership,
  findLatestOrganizationSubscription,
} = require("../subscription/subscription.repository");

const { isSubscriptionUsable, resolveSubscriptionAccess } = require("../subscription/subscription.service");

// The EXISTING job-quota projection (limit/used/remaining from the plan plus
// JobQuotaConsumption). Reused verbatim so the audit dashboard can never drift
// from the number the recruiter's Start button is actually gated by. Importing
// the service function (not re-reading the plan here) is the point: one source
// of truth for "jobs used / jobs remaining".
const { getJobLimits } = require("../job/job.service");

const {
  findUsersByEmail,
  findUserById,
  updateEmployeeUserProfile,
} = require("../auth/auth.repository");
const {
  getUserAccountFieldUpdate,
} = require("../auth/auth.service");

const hashPassword = require("../../utils/hashPassword");
const sendOrganizationCredentialsEmail = require("../../utils/sendOrganizationCredentialsEmail");

// NOTE: OrganizationMembership.permissions is intentionally NOT used anywhere.
//
// It was previously exposed as a per-recruiter permission matrix (a
// `permissions String[]` on the membership plus an ALLOWED_RECRUITER_PERMISSIONS
// allow-list and a PATCH /recruiters/:membershipId/permissions endpoint). That
// system was never enforced by a single authorization check — `authorize` only
// ever compared `req.user.role` against a static role list — so the stored
// values never affected what a recruiter could actually do. It was decorative
// configuration that would have to be re-implemented, re-audited and re-secured
// to become real.
//
// Organization recruiters are therefore governed by the SAME single global
// RECRUITER role as every other recruiter (see the authorize("RECRUITER")
// route guards in module/job/job.routes.js and the getProfileAccounts /
// getAvailableAccounts role derivation in module/auth/auth.service.js).
// There is deliberately no per-recruiter permission selection.
//
// The Prisma column is left in place (unused, defaulting to []) purely as
// backward-compatible dead data. It is never read to determine capabilities and
// must not be reintroduced as an authorization input.

// PHASE 1 — shown wherever a job's owning recruiter no longer exists because
// the account was permanently deleted. The job, its candidates, assessments and
// analyses are deliberately preserved as the organization's historical record,
// but the person who posted it is gone.
const DELETED_RECRUITER_LABEL = "Deleted Recruiter";

// Projects a job's owning recruiter for an API response.
//
// `createdByUser` is nullable since the permanent-delete migration (SetNull). A
// detached job reports `userId: null`, `email: null`, `isDeleted: true` and the
// honest DELETED_RECRUITER_LABEL — it is NEVER attributed to another recruiter,
// because that would fabricate who ran the job.
const buildJobRecruiterProjection = (createdByUser) => {
  if (!createdByUser) {
    return {
      userId: null,
      fullName: DELETED_RECRUITER_LABEL,
      email: null,
      isDeleted: true,
    };
  }

  return {
    userId: createdByUser.id,
    fullName: createdByUser.fullName,
    email: createdByUser.email,
    isDeleted: false,
  };
};

const httpError = (status, message, extra) => {
  const error = new Error(message);
  error.status = status;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
};

// One shared, controlled message for every duplicate-email path: the
// read-only pre-check, the in-transaction re-check, and the Prisma P2002
// unique-constraint violation a concurrent loser receives. Deliberately
// generic — it never echoes a Prisma/DB message back to the client.
const DUPLICATE_RECRUITER_MESSAGE =
  "A recruiter account with this email already exists.";

// Character pools deliberately exclude visually-ambiguous characters
// (0/O, 1/l/I) since this password is meant to be read out of an email and
// typed once, not stored anywhere long-term.
const PASSWORD_CHAR_POOL = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnpqrstuvwxyz",
  digit: "23456789",
  special: "!@#$%^&*()_+-=",
};

const randomChar = (pool) => pool[crypto.randomInt(pool.length)];

// Generates a 12-character, cryptographically random password guaranteed to
// satisfy the same complexity policy enforced elsewhere (registerSchema /
// changePasswordSchema): at least one uppercase, lowercase, digit, and
// special character. Built from required-class characters + random fill,
// then shuffled with crypto.randomInt (never Math.random) so position
// doesn't leak which characters were "required".
const generateTemporaryPassword = () => {
  const required = [
    randomChar(PASSWORD_CHAR_POOL.upper),
    randomChar(PASSWORD_CHAR_POOL.lower),
    randomChar(PASSWORD_CHAR_POOL.digit),
    randomChar(PASSWORD_CHAR_POOL.special),
  ];

  const allChars = Object.values(PASSWORD_CHAR_POOL).join("");
  const targetLength = 12;
  const rest = Array.from({ length: targetLength - required.length }, () =>
    randomChar(allChars)
  );

  const chars = [...required, ...rest];

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
};

// The recruiter's User/OrganizationMembership rows are already committed by
// the time this runs — an email-provider failure here must never be
// reported as "the recruiter wasn't created" (it was), nor silently
// reported as success. Callers surface the returned emailSent flag so the
// frontend shows the real outcome and can offer Reset & Resend Credentials
// instead of a false "sent" message. The temporary password is passed
// through to the mailer only — never logged, never returned to callers of
// this function.
const dispatchCredentialsEmail = async ({
  email,
  fullName,
  organizationName,
  temporaryPassword,
}) => {
  try {
    await sendOrganizationCredentialsEmail({
      email,
      fullName,
      organizationName,
      temporaryPassword,
    });
    return true;
  } catch (error) {
    console.error(
      `Organization credentials email dispatch failed for ${email}:`,
      error.message
    );
    return false;
  }
};

// maxUsers is the total organization seat count. One seat belongs to the
// ORG_ADMIN, so this resolver returns only the available RECRUITER capacity
// (see countRecruiterMembershipsByStatus's role: "RECRUITER" filter, which this
// relies on unchanged). Reads the org's own current usable subscription, so
// it always reflects live plan/status, never a cached or assumed value. In
// practice checkSubscription middleware already guarantees a usable
// organization subscription before any caller in this file runs, so the
// "no usable subscription" branch below is a defensive fallback (e.g. a
// subscription lapsing in the instant between that check and this one), not
// the expected path — it fails closed (0 seats) rather than open.
const resolveRecruiterSeatLimit = async (organizationId) => {
  const subscription = await findLatestOrganizationSubscription(organizationId);

  if (!subscription || !isSubscriptionUsable(subscription) || !subscription.plan) {
    return 0;
  }

  return subscription.plan.maxUsers === null
    ? null
    : Math.max(0, subscription.plan.maxUsers - 1);
};

// The single source of truth for "which organization does this authenticated
// ORG_ADMIN manage" — never accepts an organizationId from the caller. Any
// endpoint that scopes data to an organization must go through this first.
const resolveAdminOrganization = async (user) => {
  const membership = await findActiveOrganizationMembership(user.id);

  if (!membership || membership.role !== "ORG_ADMIN") {
    throw httpError(403, "ORGANIZATION_MEMBERSHIP_REQUIRED");
  }

  const organization = await findOrganizationById(membership.organizationId);

  if (!organization) {
    throw httpError(403, "ORGANIZATION_MEMBERSHIP_REQUIRED");
  }

  return organization;
};

const getOrganizationSummary = async (user) => {
  const organization = await resolveAdminOrganization(user);

  const subscription = await findLatestOrganizationSubscription(organization.id);
  const recruiterCounts = await countRecruiterMembershipsByStatus(organization.id);
  const logo = await findOrganizationLogoByOwnerId(organization.id);

  return {
    id: organization.id,
    name: organization.name,
    website: organization.website,
    businessEmail: organization.businessEmail,
    organizationLogo: logo ? `/api/files/${logo.id}/view` : null,
    status: organization.status,
    subscription: subscription
      ? {
          status: subscription.status,
          planId: subscription.planId,
          expiryDate: subscription.expiryDate,
          active: isSubscriptionUsable(subscription),
        }
      : { status: null, planId: null, expiryDate: null, active: false },
    recruiters: recruiterCounts,
  };
};

const getOrganizationBranding = async (user) => {
  const membership = await findActiveOrganizationMembership(user.id);

  if (!membership || !["ORG_ADMIN", "RECRUITER"].includes(membership.role)) {
    throw httpError(403, "ORGANIZATION_MEMBERSHIP_REQUIRED");
  }

  const organization = await findOrganizationById(membership.organizationId);
  if (!organization) {
    throw httpError(403, "ORGANIZATION_MEMBERSHIP_REQUIRED");
  }

  const logo = await findOrganizationLogoByOwnerId(organization.id);

  return {
    id: organization.id,
    name: organization.name,
    organizationLogo: logo ? `/api/files/${logo.id}/view` : null,
  };
};

const listRecruiters = async (user) => {
  const organization = await resolveAdminOrganization(user);

  const memberships = await listRecruiterMemberships(organization.id);

  return memberships.map((membership) => ({
    membershipId: membership.id,
    userId: membership.user.id,
    fullName: membership.user.fullName,
    email: membership.user.email,
    status: membership.status,
    invitedAt: membership.createdAt,
  }));
};

// Creates a normal, immediately-usable RECRUITER account for the
// organization: a server-generated temporary password is hashed and stored,
// the account is ACTIVE and emailVerified from the moment it's created (the
// organization vouches for it), and the plaintext password is emailed once
// and never persisted or returned.
//
// The recruiter is an ordinary RECRUITER with the global role's capabilities —
// no per-recruiter permission selection happens here (see the permissions note
// at the top of this file).
const provisionOrganizationRecruiter = async (user, { fullName, email }) => {
  const organization = await resolveAdminOrganization(user);

  const normalizedEmail = email.trim().toLowerCase();

  const existingUsers = await findUsersByEmail(normalizedEmail);

  if (
    existingUsers.some((existingUser) =>
      existingUser.roles.some(({ role }) => role?.name === "RECRUITER")
    )
  ) {
    throw httpError(409, DUPLICATE_RECRUITER_MESSAGE);
  }

  if (existingUsers.some((existingUser) => existingUser.roles.length > 0)) {
    throw httpError(409, "This user already has a global account capability");
  }


  const hasExistingUser = existingUsers.length > 0;
  const temporaryPassword = hasExistingUser
    ? null
    : generateTemporaryPassword();
  const passwordHash = hasExistingUser
    ? null
    : await hashPassword(temporaryPassword);

  const maxUsers = await resolveRecruiterSeatLimit(organization.id);

  let created;
  try {
    created = await createActiveRecruiter({
      fullName: fullName.trim(),
      email: normalizedEmail,
      organizationId: organization.id,
      passwordHash,
      maxUsers,
    });
  } catch (error) {
    if (error.code === "SEAT_LIMIT_EXCEEDED") {
      throw httpError(
        409,
        `This organization has reached its plan's recruiter seat limit (${maxUsers}). Upgrade your plan or remove an existing recruiter to add another.`
      );
    }

    // Prisma P2002 = unique-constraint violation. The authoritative duplicate
    // protection is the database itself: User.email @unique and
    // OrganizationMembership @@unique([userId, organizationId]). This branch is
    // what a genuinely CONCURRENT request hits — two tabs (or two Org Admin
    // sessions, or two backend instances) can both pass the read-only
    // findUsersByEmail pre-check above, but only one INSERT can win. The loser
    // lands here instead of surfacing a raw Prisma error as a 400.
    //
    // Correct across processes, instances and restarts because the constraint is
    // enforced by PostgreSQL inside the transaction — never by an in-memory
    // lock. The whole create is one transaction, so a losing request commits
    // nothing: no orphan User, no orphan membership, no consumed seat.
    if (error.code === "P2002") {
      throw httpError(409, DUPLICATE_RECRUITER_MESSAGE);
    }

    throw error;
  }

  const { user: recruiterUser, membership, usesExistingPassword } = created;

  const emailSent = usesExistingPassword
    ? null
    : await dispatchCredentialsEmail({
        email: recruiterUser.email,
        fullName: recruiterUser.fullName,
        organizationName: organization.name,
        temporaryPassword,
      });

  return {
    membershipId: membership.id,
    userId: recruiterUser.id,
    fullName: recruiterUser.fullName,
    email: recruiterUser.email,
    status: membership.status,
    emailSent,
    passwordReused: usesExistingPassword,
  };
};

const ALLOWED_STATUS_TRANSITIONS = {
  ACTIVE: ["REMOVED"],
  REMOVED: ["ACTIVE"],
};

const updateRecruiterStatus = async (user, membershipId, nextStatus) => {
  const organization = await resolveAdminOrganization(user);

  const membership = await findMembershipByIdInOrganization(
    membershipId,
    organization.id
  );

  if (!membership) {
    throw httpError(404, "Recruiter not found in your organization");
  }

  const allowedTargets = ALLOWED_STATUS_TRANSITIONS[membership.status] ?? [];

  if (!allowedTargets.includes(nextStatus)) {
    throw httpError(
      400,
      `Cannot move a recruiter from ${membership.status} to ${nextStatus}`
    );
  }

  // Reactivating (REMOVED -> ACTIVE) increases the active seat count exactly
  // like provisioning a new recruiter does, so it needs the same locked
  // check. Deactivating never can overshoot a limit, so it skips it.
  let updated;
  try {
    if (nextStatus === "ACTIVE") {
      const maxUsers = await resolveRecruiterSeatLimit(organization.id);
      updated = await updateMembershipStatus(membershipId, nextStatus, {
        organizationId: organization.id,
        maxUsers,
      });
    } else {
      updated = await updateMembershipStatus(membershipId, nextStatus);
    }
  } catch (error) {
    if (error.code === "SEAT_LIMIT_EXCEEDED") {
      throw httpError(
        409,
        "This organization has reached its plan's recruiter seat limit. Remove another recruiter or upgrade your plan before reactivating this one."
      );
    }
    throw error;
  }

  return { membershipId: updated.id, status: updated.status };
};

// Addressed by recruiter userId, scoped to the authenticated ORG_ADMIN's own
// organization via resolveAdminOrganization — an admin can never reset
// credentials for a recruiter outside their own org. Only available for
// ACTIVE recruiters (there's no INVITED state left for newly created
// recruiters to be "resent" to, and resetting a REMOVED recruiter's
// credentials makes no sense). Generates a brand-new temporary password and
// overwrites the stored hash — the previous password stops working the
// instant this commits, before the new email is even sent.
const resetAndResendCredentials = async (user, recruiterUserId) => {
  const organization = await resolveAdminOrganization(user);

  const membership = await findMembershipByUserIdInOrganization(
    recruiterUserId,
    organization.id
  );

  if (!membership) {
    throw httpError(404, "Recruiter not found in your organization");
  }

  if (membership.status !== "ACTIVE") {
    throw httpError(
      400,
      `Cannot reset credentials for a recruiter whose membership is ${membership.status}`
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await resetRecruiterPassword(recruiterUserId, passwordHash);

  const emailSent = await dispatchCredentialsEmail({
    email: membership.user.email,
    fullName: membership.user.fullName,
    organizationName: organization.name,
    temporaryPassword,
  });

  return {
    membershipId: membership.id,
    userId: recruiterUserId,
    email: membership.user.email,
    status: membership.status,
    emailSent,
  };
};

// PHASE 1 — PERMANENT recruiter deletion.
//
// This is NOT the existing `REMOVED` membership status: the User row is really
// deleted, so the account stops existing entirely. `updateRecruiterStatus`
// (Remove) keeps the row for audit and can be undone with Reactivate;
// this cannot.
//
// SECURITY / AUTHORIZATION:
//   * The organization comes from resolveAdminOrganization — the EXISTING
//     server-side resolver. `organizationId` is never read from the request.
//   * The target must be a RECRUITER membership inside THAT organization, so a
//     cross-organization delete is a 404 (the row is invisible to this admin,
//     not merely forbidden — it must not confirm the existence of another
//     organization's recruiter).
//   * An ORG_ADMIN can never delete themselves or another admin: the membership
//     lookup is restricted to role RECRUITER, so an admin's membership simply
//     does not match.
//
// Idempotency: a repeated delete of an already-deleted recruiter resolves to the
// same 404 as deleting a recruiter that never existed, so a double-click or a
// retried request is safe and cannot error out as a server fault.
const permanentlyDeleteRecruiter = async (user, recruiterUserId) => {
  const organization = await resolveAdminOrganization(user);

  if (!recruiterUserId || typeof recruiterUserId !== "string") {
    throw httpError(400, "A recruiter id is required");
  }

  // Pre-flight existence check purely to produce the correct 404 (and to keep
  // the transaction free to focus on the delete). The repository re-validates
  // the same condition inside the transaction, so this is NOT the authorization
  // boundary — it cannot be raced into a cross-org delete.
  const membership = await findMembershipByUserIdInOrganization(
    recruiterUserId,
    organization.id
  );

  if (!membership) {
    throw httpError(404, "Recruiter not found in your organization");
  }

  // A self-delete guard that is not role-dependent: even if an ORG_ADMIN
  // somehow also held a RECRUITER membership in the same organization, they
  // must not be able to remove their own account and lock the org out.
  if (recruiterUserId === user.id) {
    throw httpError(400, "You cannot delete your own account");
  }

  const result = await permanentlyDeleteRecruiterAccount({
    organizationId: organization.id,
    recruiterUserId,
    actorUserId: user.id,
  });

  // Seat accounting: the ACTIVE membership row is gone with the account, so the
  // organization's recruiter seat is released. Recounted from the authoritative
  // table so the number returned is measured, never assumed.
  const seatCounts = await countRecruiterMembershipsByStatus(organization.id);

  return {
    deleted: true,
    userId: result.deletedUserId,
    email: result.deletedEmail,
    fullName: result.deletedFullName,
    // Reported honestly so the UI never claims the historical data was deleted.
    preservedHistoricalData: result.preserved,
    recruiterSeats: seatCounts,
  };
};

// Updates the organization's profile fields (website, businessEmail). Scoped
// to the authenticated ORG_ADMIN's own organization — never accepts an
// organizationId from the caller.
// Also accepts shared User identity fields (phone, city, country, profileImage)
// which are initialized only if the corresponding User field is empty
// (fill-only-if-empty via getUserAccountFieldUpdate). Established shared
// identity is never overwritten here — Account Settings is the intentional
// endpoint for editing existing shared identity.
const updateOrganizationProfile = async (user, data) => {
  const organization = await resolveAdminOrganization(user);

  // Initialize missing shared User identity fields (fill-only-if-empty).
  const currentUser = await findUserById(user.id);
  const accountFieldUpdate = getUserAccountFieldUpdate(currentUser, data);
  if (Object.keys(accountFieldUpdate).length > 0) {
    await updateEmployeeUserProfile(user.id, accountFieldUpdate);
  }

  const updated = await updateOrgProfileInRepository(organization.id, data);

  return {
    id: updated.id,
    name: updated.name,
    website: updated.website,
    businessEmail: updated.businessEmail,
  };
};

// ---------------------------------------------------------------------------
// ORG ADMIN READ-ONLY AUDIT DASHBOARD
//
// Every function below resolves the caller's organization through
// resolveAdminOrganization FIRST — the existing authoritative resolver that
// never accepts an organizationId from the client — and then reads ONLY
// organization-scoped rows. There is no second authorization rule here.
//
// READ-ONLY: this block exports no mutating function. The single management
// action in the whole dashboard (recruiter removal) is the PRE-EXISTING
// updateRecruiterStatus above; nothing new was added to mutate anything.
//
// NOTHING IS PERSISTED: every figure is computed live from the existing Job,
// JobCandidateReference, JobAssessmentAttempt and JobCandidateAnalysis rows.
// There is no aggregate/snapshot table.
//
// SELECTED CANDIDATES ARE REPORTED AS null, deliberately. The audit found that
// no per-candidate "selected" state is persisted anywhere in the schema, so a
// number here would be fabricated. The recruiter-configured
// preferredCandidateCount TARGET is a different, already-persisted concept and
// is reported separately and explicitly labelled as a target.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const AUDIT_DEFAULT_LIMIT = 20;
const AUDIT_MAX_LIMIT = 100;

// Monthly chart window. Bounded so the time-series response can never grow with
// the organization's age.
const AUDIT_MIN_MONTHS = 1;
const AUDIT_MAX_MONTHS = 24;

// HIRING — WHY THIS BLOCK EXISTS BUT CARRIES NO NUMBERS.
//
// A schema audit of the ENTIRE Prisma file found no persisted candidate
// hiring/selection state: no `hired`, `hiringStatus`, `decision`, `outcome`,
// `shortlisted` or equivalent column on JobCandidateReference, JobAssessmentAttempt
// or JobCandidateAnalysis. The platform's existing read paths already state this
// explicitly (jobOverview.service.js reports `selectedCandidates: null` and a
// `selectedStatusReason`).
//
// Therefore hiring is NOT derived here. It is deliberately NOT inferred from:
//   * an assessment score      (a test result is not a hiring decision)
//   * an AI candidate analysis  (a model output is not a hiring decision)
//   * preferredCandidateCount  (a recruiter's configured target, not a decision)
//   * selected/invited status  (an invitation is not a hire)
// Any of those would fabricate hiring data and would also merge distinct signals,
// which this codebase forbids.
//
// This block is the CONTRACT for the future recruiter hiring feature: when that
// feature persists an explicit recruiter decision, `available` flips to true and
// the same shape is populated from real rows — with no dashboard change beyond
// reading the new field.
const HIRING_UNAVAILABLE_REASON =
  "No persisted candidate hiring state exists yet. Hiring is an explicit recruiter decision that has not been introduced as a product feature, so it is not inferred from assessment scores, AI analysis or preference.";

const buildHiringBlock = (totalCandidates, hiredCount) => {
  if (hiredCount === null) {
    return {
      available: false,
      reason: HIRING_UNAVAILABLE_REASON,
      totalCandidates,
      // null (not 0) so the UI can show an honest empty state rather than a
      // zero that looks like "nobody was hired".
      hired: null,
      notHired: null,
      hiringRate: null,
    };
  }
  // Only computed when a real denominator and a real numerator both exist.
  const denominator = totalCandidates;
  return {
    available: true,
    reason: null,
    totalCandidates: denominator,
    hired: hiredCount,
    notHired: Math.max(denominator - hiredCount, 0),
    hiringRate: denominator > 0 ? Math.round((hiredCount / denominator) * 10000) / 100 : null,
  };
};

// PHASE 4 — the organization-level assessment activity block.
//
// The response shape is DELIBERATELY IDENTICAL to the per-recruiter
// `assessments` object that Recruiter Analysis already returns (Phase 2), so the
// two surfaces cannot drift. `inProgress` keeps the existing platform meaning
// "started but not finished" (STARTED + IN_PROGRESS); the two are ALSO reported
// separately as `started` and `inProgressRaw` so the merge is visible rather than
// hidden.
//
// `completionRate` uses the EXISTING per-recruiter definition (submitted / total)
// so the same word means the same thing on both pages, and is null — never 0 —
// when there is nothing to divide.
const buildAssessmentActivityBlock = (activity) => {
  const counts = {
    total: activity.total ?? 0,
    submitted: activity.submitted ?? 0,
    inProgress: activity.inProgress ?? 0,
    timedUp: activity.timedUp ?? 0,
    cheated: activity.cheated ?? 0,
    expired: activity.expired ?? 0,
  };

  return {
    ...counts,
    // Unmerged persisted lifecycle states, so nothing is lost to the bucket above.
    started: activity.started ?? 0,
    inProgressRaw: activity.inProgressRaw ?? 0,
    completionRate:
      counts.total > 0
        ? Number(((counts.submitted / counts.total) * 100).toFixed(2))
        : null,
  };
};

// Mirrors the recruiter overview's parsing rules so both surfaces accept and
// reject exactly the same inputs (a filter the recruiter can use, the auditor
// can use).
const parseAuditInt = (value, fallback, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
};

const parseAuditDayBoundary = (value, edge) => {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw httpError(422, "Dates must be provided as YYYY-MM-DD");
  }
  const parsed = Date.parse(
    edge === "start" ? `${text}T00:00:00.000Z` : `${text}T23:59:59.999Z`
  );
  if (!Number.isFinite(parsed)) {
    throw httpError(422, "Dates must be provided as YYYY-MM-DD");
  }
  return new Date(parsed);
};

// `range` is the dashboard's own coarse selector; explicit from/to win over it.
// "month" means the current calendar month (not "last 30 days"), matching how a
// person reads "This month".
const resolveAuditWindow = (query) => {
  const from = parseAuditDayBoundary(query.from, "start");
  const to = parseAuditDayBoundary(query.to, "end");
  if (from && to && from.getTime() > to.getTime()) {
    throw httpError(422, "The start date must not be after the end date");
  }
  if (from || to) {
    return { from, to, label: "CUSTOM" };
  }
  const range = String(query.range ?? "").trim().toUpperCase();
  if (!range || range === "ALL") return { from: null, to: null, label: "ALL" };
  if (range === "MONTH") {
    const now = new Date();
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to: null,
      label: "THIS_MONTH",
    };
  }
  if (range === "LAST_30_DAYS") {
    return { from: new Date(Date.now() - 30 * DAY_MS), to: null, label: "LAST_30_DAYS" };
  }
  // PHASE 2 — rolling 3/6-month windows. Calendar-anchored (not "90/180 days")
  // so "last 3 months" means the same thing to a reader as the calendar: the
  // window starts on the 1st of the month N months back and runs to now.
  // Computed in UTC, consistent with the month-boundary and day-boundary logic
  // above, so the filter never drifts by a day across a timezone.
  if (range === "LAST_3_MONTHS" || range === "LAST_6_MONTHS") {
    const months = range === "LAST_3_MONTHS" ? 3 : 6;
    const now = new Date();
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)),
      to: null,
      label: range,
    };
  }
  throw httpError(422, "Unknown date range filter");
};

const AUDIT_JOB_STATUS_GROUPS = {
  ACTIVE: "ACTIVE",
  CURRENT: "ACTIVE",
  CLOSED: "CLOSED",
  COMPLETED: "CLOSED",
  EXPIRED: "CLOSED",
};

const parseAuditStatus = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim().toUpperCase();
  if (["DRAFT", "ACTIVE", "CLOSED"].includes(raw)) return raw;
  if (AUDIT_JOB_STATUS_GROUPS[raw]) return AUDIT_JOB_STATUS_GROUPS[raw];
  throw httpError(422, "Unknown job status filter");
};

// Chart window length. Bounded server-side; an out-of-range or unparseable value
// is a client error rather than a silently clamped value.
const parseAuditMonths = (value) => {
  if (value === undefined || value === null || value === "") {
    return 12;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw httpError(422, "months must be an integer");
  }
  if (parsed < AUDIT_MIN_MONTHS || parsed > AUDIT_MAX_MONTHS) {
    throw httpError(
      422,
      `months must be between ${AUDIT_MIN_MONTHS} and ${AUDIT_MAX_MONTHS}`
    );
  }
  return parsed;
};

// Folds the grouped job rows into per-recruiter totals. Pure in-memory work —
// this is why the recruiter list costs the same whether the org has 1 or 500
// recruiters.
const foldJobsByRecruiter = (groupedRows) => {
  const totals = {};
  for (const row of groupedRows) {
    const entry = (totals[row.createdByUserId] ??= {
      total: 0,
      DRAFT: 0,
      ACTIVE: 0,
      CLOSED: 0,
    });
    entry.total += row._count._all;
    if (row.status in entry) entry[row.status] += row._count._all;
  }
  return totals;
};

// PHASE 1 — organization overview.
//
// Capacity is NOT recomputed here:
//   * recruiter seats come from the EXISTING resolveRecruiterSeatLimit
//     (plan.maxUsers minus the ORG_ADMIN's own reserved seat);
//   * job quota comes from the EXISTING getJobLimits (plan.jobPostingLimit minus
//     JobQuotaConsumption rows), i.e. the exact ledger the recruiter's Start
//     action is gated by.
// Nothing is persisted; this is a live projection of existing rows.
const getAuditDashboardSummary = async (user) => {
  const organization = await resolveAdminOrganization(user);
  const organizationId = organization.id;

  const [subscription, recruiterCounts, groupedJobs, candidateStats, analysisStats, assessmentActivity] =
    await Promise.all([
      findLatestOrganizationSubscription(organizationId),
      countRecruiterMembershipsByStatus(organizationId),
      countOrganizationJobsByRecruiter(organizationId),
      countOrganizationCandidateStats(organizationId),
      countOrganizationAnalysisStatus(organizationId),
      // PHASE 4 — one grouped query for the organization's assessment activity.
      countOrganizationAssessmentActivity(organizationId),
    ]);

  const jobTotals = foldJobsByRecruiter(groupedJobs);
  const orgJobs = Object.values(jobTotals).reduce(
    (acc, t) => ({
      total: acc.total + t.total,
      DRAFT: acc.DRAFT + t.DRAFT,
      ACTIVE: acc.ACTIVE + t.ACTIVE,
      CLOSED: acc.CLOSED + t.CLOSED,
    }),
    { total: 0, DRAFT: 0, ACTIVE: 0, CLOSED: 0 }
  );

  // Seats: resolveRecruiterSeatLimit already excludes the ORG_ADMIN's own seat
  // and returns null for an unlimited plan (never coerced to 0).
  const recruiterSeatLimit = await resolveRecruiterSeatLimit(organizationId);
  const seatsUsed = recruiterCounts.active;

  // Job quota: delegated to the EXISTING service, with the caller's real
  // principal. getJobLimits resolves its scope from the ACTIVE membership FIRST,
  // so an ORG_ADMIN is already organization-scoped — this is the same ledger the
  // organization's own recruiters are gated against. Passing the user unmodified
  // keeps it honest rather than "pretending" to be a recruiter.
  const quota = await getJobLimits(user);

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      status: organization.status,
    },
    subscription: subscription
      ? {
          status: subscription.status,
          expiryDate: subscription.expiryDate,
          active: isSubscriptionUsable(subscription),
          planName: subscription.plan?.name ?? null,
          maxUsers: subscription.plan?.maxUsers ?? null,
          jobPostingLimit: subscription.plan?.jobPostingLimit ?? null,
        }
      : { status: null, expiryDate: null, active: false, planName: null, maxUsers: null, jobPostingLimit: null },
    // `limit: null` means unlimited on the current plan and is passed through
    // as null rather than turned into a misleading 0.
    seats: {
      limit: recruiterSeatLimit,
      used: seatsUsed,
      remaining:
        recruiterSeatLimit === null ? null : Math.max(recruiterSeatLimit - seatsUsed, 0),
    },
    jobs: {
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
      total: orgJobs.total,
      active: orgJobs.ACTIVE,
      closed: orgJobs.CLOSED,
      draft: orgJobs.DRAFT,
    },
    recruiters: {
      total: recruiterCounts.total,
      active: recruiterCounts.active,
      removed: recruiterCounts.removed,
    },
    // Organization-wide candidate totals, counted from the EXISTING
    // JobCandidateReference rows. Never re-derived from a stored sheet.
    candidates: {
      total: candidateStats.totalCandidates,
      withCompletedAssessment: candidateStats.completedAssessments,
      // Reuses the analysis figure below so the two cards can never disagree.
      analyzed: analysisStats.completed,
    },
    // Candidate-analysis pipeline state straight from the EXISTING AiJob
    // lifecycle. No AI service is invoked to produce these numbers.
    analysis: {
      completed: analysisStats.completed,
      pending: analysisStats.pending,
      failed: analysisStats.failed,
      total: analysisStats.total,
    },
    // PHASE 4 — organization-level assessment activity, ALL TIME, counted from
    // the persisted JobAssessmentAttempt lifecycle. Aggregate-only: no candidate
    // identity, no score and no analysis is read here.
    assessments: buildAssessmentActivityBlock(assessmentActivity),
    // Hiring: an explicit, honest "not available yet" block. See
    // buildHiringBlock for why nothing is inferred here.
    hiring: buildHiringBlock(candidateStats.totalCandidates, null),
  };
};

// PHASE 2 — the organization's recruiters with their activity statistics.
//
// QUERY COST IS CONSTANT IN THE NUMBER OF RECRUITERS: three grouped queries for
// the whole organization (jobs, candidates, completed analyses) plus the
// membership list, then a per-recruiter in-memory fold. There is deliberately
// NO "for each recruiter, query their jobs" loop.
//
// CAPACITY IS ORGANIZATION-LEVEL, NOT PER-RECRUITER. The platform has no
// per-recruiter quota (JobQuotaConsumption is keyed by subscriptionId, i.e. the
// organization's), so the response reports the organization's capacity once and
// each recruiter's USAGE against it. It never invents an individual limit.
const listAuditRecruiters = async (user, query = {}) => {
  const organization = await resolveAdminOrganization(user);
  const organizationId = organization.id;
  const window = resolveAuditWindow(query);

  // Server-side search over the persisted recruiter name + email. Bounded so a
  // pathological term can never turn into an unbounded user-table scan.
  const search = typeof query.search === "string" ? query.search.trim().slice(0, 100) : "";

  const page = parseAuditInt(query.page, 1, 1_000_000);
  const limit = parseAuditInt(query.limit, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);

  const [memberships, activity, quota, groupedJobs, assessmentActivity, unattributed, seatCounts] =
    await Promise.all([
      searchRecruiterMemberships(organizationId, search),
      countOrganizationActivityByRecruiter(organizationId),
      // Same org-level capacity shown on the summary card.
      getJobLimits(user),
      // All-time job totals per recruiter (one grouped query for the org).
      countOrganizationJobsByRecruiter(organizationId),
      // PHASE 2 — assessment attempt activity per recruiter (one grouped query).
      countAssessmentActivityByRecruiter(organizationId),
      // PHASE 2 — jobs detached from a permanently deleted recruiter. Reported as
      // its own honest bucket so it is never silently dropped from the org's
      // totals, and never reassigned to a surviving recruiter.
      countUnattributedHistoricalJobs(organizationId, {
        createdFrom: window.from,
        createdTo: window.to,
      }),
      countRecruiterMembershipsByStatus(organizationId),
    ]);

  const jobsByRecruiter = foldJobsByRecruiter(groupedJobs);

  // Optional date-windowed activity, still one grouped query per family.
  let windowed = null;
  if (window.from || window.to) {
    windowed = await countOrganizationJobsByRecruiterInRange(
      organizationId,
      window.from,
      window.to
    );
  }

  // Search already happened IN SQL above; this slice only re-applies the page to
  // the searched rows, so pagination reflects the filtered set.
  const totalRecruiters = memberships.length;
  const pageRows = memberships.slice((page - 1) * limit, page * limit);
  const recruiters = pageRows.map((membership) => {
    const userId = membership.user.id;
    const jobs = jobsByRecruiter[userId] ?? { total: 0, DRAFT: 0, ACTIVE: 0, CLOSED: 0 };
    // When a date window is active the same fields are additionally reported
    // for that window only, so the UI can show "posted 12 · 3 this month"
    // without a second request. All-time figures are never replaced by them.
    const ranged = windowed
      ? {
          jobsPosted: windowed.jobsByRecruiter[userId]?.total ?? 0,
          candidatesAdded: windowed.candidatesByRecruiter[userId] ?? 0,
        }
      : null;

    const assessments =
      assessmentActivity.perRecruiter[userId] ?? {
        total: 0, submitted: 0, inProgress: 0, timedUp: 0, cheated: 0, expired: 0,
      };

    return {
      membershipId: membership.id,
      userId,
      fullName: membership.user.fullName,
      email: membership.user.email,
      status: membership.status,
      joinedAt: membership.createdAt,
      jobs: {
        // `posted` is the recruiter's posted-job count; the organization-level
        // quota (`quota.used`/`limit`) is reported once at the top level.
        posted: jobs.total,
        active: jobs.ACTIVE,
        closed: jobs.CLOSED,
        draft: jobs.DRAFT,
      },
      candidates: activity.candidatesByRecruiter[userId] ?? 0,
      analyzed: activity.completedByRecruiter[userId] ?? 0,
      // PHASE 2 — assessment activity from the PERSISTED attempt lifecycle.
      // `submitted` is a real completed-attempt count, so it is a genuine
      // completion statistic; nothing here is inferred from a score.
      assessments: {
        total: assessments.total,
        submitted: assessments.submitted,
        inProgress: assessments.inProgress,
        timedOut: assessments.timedUp,
        cheated: assessments.cheated,
        expired: assessments.expired,
        // submitted / started, both persisted counts. null when there is
        // nothing to divide — never a fake 0%.
        completionRate:
          assessments.total > 0
            ? Number(((assessments.submitted / assessments.total) * 100).toFixed(2))
            : null,
      },
      // No per-candidate "selected"/"hired" state is persisted anywhere in the
      // schema, so these stay null rather than being derived from a score, an AI
      // analysis, a preferred candidate or an invitation.
      selected: null,
      hiring: buildHiringBlock(activity.candidatesByRecruiter[userId] ?? 0, null),
      inRange: ranged,
    };
  });

  return {
    organizationId,
    range: window,
    // Echoed back so the UI can show the active query and distinguish an empty
    // result from a filtered one.
    search: search || null,
    // Organization-level capacity, stated explicitly so the UI never presents a
    // per-recruiter quota that does not exist.
    organizationJobQuota: { limit: quota.limit, used: quota.used, remaining: quota.remaining },
    // PHASE 2 — organization seat usage, measured rather than assumed.
    seats: {
      total: seatCounts.total,
      active: seatCounts.active,
      invited: seatCounts.invited,
      removed: seatCounts.removed,
    },
    // PHASE 2 — historical jobs whose recruiter account was permanently deleted
    // in Phase 1 (Job.createdByUserId is NULL). Reported ONCE, outside the
    // recruiter list, because there is no recruiter to list them under.
    // `userId` is null so no caller can mistake this for a real recruiter, and
    // these jobs are NEVER reassigned to a surviving one.
    unattributedHistoricalJobs: {
      label: "Unattributed Historical Jobs",
      labelShort: DELETED_RECRUITER_LABEL,
      userId: null,
      total: unattributed.total,
      byStatus: unattributed.byStatus,
      candidates: unattributed.candidates,
      attempts: unattributed.attempts,
      analyses: unattributed.analyses,
    },
    recruiters,
    pagination: {
      page,
      limit,
      total: totalRecruiters,
      totalPages: Math.max(Math.ceil(totalRecruiters / limit), 1),
    },
  };
};

// PHASE 3 — one recruiter's jobs inside the caller's organization.
//
// AUTHORIZATION: the organization comes from resolveAdminOrganization; the
// recruiter id from the URL is treated as a REQUEST, never as proof — it must
// match a REAL ACTIVE RECRUITER membership in THAT organization or the response
// is 404. A recruiter id belonging to a different organization therefore cannot
// leak this organization's jobs.
//
// The job rows reuse the EXISTING OVERVIEW_JOB_SELECT projection, so
// candidate/attempt/analysis counts come back in the same round trip and the
// heavy analysis `result` JSON is never fetched for a list.
const listAuditRecruiterJobs = async (user, recruiterUserId, query = {}) => {
  const organization = await resolveAdminOrganization(user);

  const membership = await findActiveRecruiterMembership(organization.id, recruiterUserId);
  if (!membership) {
    throw httpError(404, "Recruiter not found in your organization");
  }

  const page = parseAuditInt(query.page, 1, 1_000_000);
  const limit = parseAuditInt(query.limit, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
  const status = parseAuditStatus(query.status);
  const window = resolveAuditWindow(query);

  const { jobs, total } = await findOrganizationJobsByRecruiter({
    organizationId: organization.id,
    userId: recruiterUserId,
    status,
    createdFrom: window.from,
    createdTo: window.to,
    skip: (page - 1) * limit,
    take: limit,
  });

  return {
    organizationId: organization.id,
    recruiter: {
      userId: membership.user.id,
      fullName: membership.user.fullName,
      email: membership.user.email,
    },
    range: window,
    jobs: jobs.map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      analysisEndsAt: job.analysisEndsAt ?? null,
      closedAt: job.closedAt ?? null,
      closedReason: job.closedReason ?? null,
      assessmentStatus: job.assessment?.status ?? null,
      isClosed: job.status === "CLOSED",
      counts: {
        candidates: job._count?.candidateReferences ?? 0,
        attempts: job._count?.assessmentAttempts ?? 0,
        analyses: job._count?.candidateAnalyses ?? 0,
        // Not persisted -> never fabricated.
        selected: null,
      },
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  };
};

// PHASE 9 — organization activity aggregate for the date filter.
//
// Aggregated in the DATABASE (GROUP BY + COUNT), never by loading jobs or
// candidates into JavaScript to count them in a loop. No analytics table is
// created or written: this is a live read of the same persisted rows the rest
// of the platform uses.
//
// The windowed numbers reuse the repository's grouped aggregates; the two
// "whole organization" counters are single COUNT queries with the same window.
const getAuditAnalytics = async (user, query = {}) => {
  const organization = await resolveAdminOrganization(user);
  const organizationId = organization.id;
  const window = resolveAuditWindow(query);

  const [groupedJobs, activity, windowed, submittedAttempts, candidateStats, analysisStats, series, assessmentActivity] =
    await Promise.all([
      countOrganizationJobsByRecruiter(organizationId),
      countOrganizationActivityByRecruiter(organizationId),
      countOrganizationJobsByRecruiterInRange(organizationId, window.from, window.to),
      countSubmittedAssessmentsInRange(organizationId, window.from, window.to),
      countOrganizationCandidateStats(organizationId),
      countOrganizationAnalysisStatus(organizationId),
      // PHASE 4 — the monthly series now spans the SELECTED range, so a trend can
      // never contradict the period the user picked. With range=ALL it keeps the
      // original `months`-back behaviour.
      countOrganizationMonthlyActivity(organizationId, parseAuditMonths(query.months), {
        from: window.from,
        to: window.to,
      }),
      // PHASE 4 — assessment activity bounded to the selected window, on the
      // persisted attempt `startedAt`.
      countOrganizationAssessmentActivity(organizationId, {
        startedFrom: window.from,
        startedTo: window.to,
      }),
    ]);

  const jobsByRecruiter = foldJobsByRecruiter(groupedJobs);

  const sum = (obj) => Object.values(obj ?? {}).reduce((a, b) => a + b, 0);
  const sumJobs = (byRecruiter) =>
    Object.values(byRecruiter ?? {}).reduce((a, t) => a + t.total, 0);

  return {
    organizationId,
    range: window,
    allTime: {
      jobsPosted: sumJobs(jobsByRecruiter),
      candidates: sum(activity.candidatesByRecruiter),
      candidatesAnalyzed: sum(activity.completedByRecruiter),
    },
    inRange: {
      jobsPosted: sumJobs(windowed.jobsByRecruiter),
      candidatesAdded: sum(windowed.candidatesByRecruiter),
      assessmentsSubmitted: submittedAttempts,
    },
    // Organization-wide counters the executive dashboard renders directly.
    candidates: {
      total: candidateStats.totalCandidates,
      withCompletedAssessment: candidateStats.completedAssessments,
    },
    analysis: {
      completed: analysisStats.completed,
      pending: analysisStats.pending,
      failed: analysisStats.failed,
      total: analysisStats.total,
    },
    // PHASE 4 — assessment activity INSIDE the selected range (same persisted
    // lifecycle and same shape as the all-time summary block).
    assessments: buildAssessmentActivityBlock(assessmentActivity),
    // Same honest contract as the summary: available=false until an explicit
    // persisted recruiter hiring decision exists.
    hiring: buildHiringBlock(candidateStats.totalCandidates, null),
    // Dense, zero-filled monthly series for the dashboard charts. Computed in
    // PostgreSQL (date_trunc), never by loading rows into JavaScript.
    series,
    // Recruiter breakdown, folded from the same grouped rows — no extra queries.
    perRecruiter: Object.entries(jobsByRecruiter).map(([recruiterId, t]) => ({
      recruiterId,
      jobsPosted: t.total,
      activeJobs: t.ACTIVE,
      closedJobs: t.CLOSED,
      candidates: activity.candidatesByRecruiter[recruiterId] ?? 0,
      analyzed: activity.completedByRecruiter[recruiterId] ?? 0,
      // Not persisted anywhere -> never fabricated.
      selected: null,
    })),
  };
};

// PHASE 5 — organization-wide JOB ANALYSIS list.
//
// Distinct from listAuditRecruiterJobs: this spans EVERY job in the
// organization (not one recruiter's), which is what the "Job Analysis" section
// needs. The recruiter-scoped list is unchanged and still used by the Recruiter
// Analysis section.
//
// Authorization: the organization is resolved server-side via
// resolveAdminOrganization and is AND-ed into the WHERE clause. No job id, and
// no organizationId, comes from the client. Counters ride along on the reused
// OVERVIEW_JOB_SELECT projection, and the recruiter's name is joined in the same
// query — so the list costs one findMany + one count regardless of org size.
const listAuditOrganizationJobs = async (user, query = {}) => {
  const organization = await resolveAdminOrganization(user);

  const page = parseAuditInt(query.page, 1, 1_000_000);
  const limit = parseAuditInt(query.limit, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
  const status = parseAuditStatus(query.status);
  const window = resolveAuditWindow(query);

  const { jobs, total } = await listOrganizationJobsForAudit({
    organizationId: organization.id,
    status,
    createdFrom: window.from,
    createdTo: window.to,
    skip: (page - 1) * limit,
    take: limit,
  });

  return {
    organizationId: organization.id,
    range: window,
    jobs: jobs.map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      createdAt: job.createdAt,
      closedAt: job.closedAt ?? null,
      closedReason: job.closedReason ?? null,
      assessmentStatus: job.assessment?.status ?? null,
      isClosed: job.status === "CLOSED",
      // PHASE 1 — `createdByUser` is now NULLABLE (see the SetNull migration):
      // permanently deleting a recruiter detaches them from their historical
      // jobs instead of destroying those jobs. A detached job is reported as an
      // explicit "deleted recruiter" placeholder with `userId: null`.
      //
      // NO replacement owner is ever invented. Reassigning the job to another
      // recruiter, or to the organization, would fabricate an audit trail that
      // never happened.
      recruiter: buildJobRecruiterProjection(job.createdByUser),
      counts: {
        candidates: job._count?.candidateReferences ?? 0,
        attempts: job._count?.assessmentAttempts ?? 0,
        analyses: job._count?.candidateAnalyses ?? 0,
        // No persisted per-candidate selected/hired state exists.
        selected: null,
        hired: null,
      },
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  };
};

module.exports = {
  resolveAdminOrganization,
  getOrganizationSummary,
  getOrganizationBranding,
  listRecruiters,
  provisionOrganizationRecruiter,
  updateRecruiterStatus,
  permanentlyDeleteRecruiter,
  resetAndResendCredentials,
  updateOrganizationProfile,
  // Org Admin read-only audit dashboard (PHASES 1-3 + 9). Read-only by
  // construction — recruiter removal is the pre-existing updateRecruiterStatus.
  getAuditDashboardSummary,
  listAuditRecruiters,
  listAuditRecruiterJobs,
  getAuditAnalytics,
  listAuditOrganizationJobs,
  // Reused by admin.service.js for SUPER_ADMIN-initiated organization
  // creation (the initial ORG_ADMIN's temp password) — same generator, same
  // complexity guarantees, not duplicated.
  generateTemporaryPassword,
};
