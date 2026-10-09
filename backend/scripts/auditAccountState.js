// ============================================================================
// backend/scripts/auditAccountState.js
//
// PHASE 0 — READ-ONLY ACCOUNT / ROLE / ONBOARDING DIAGNOSTIC
//
// THIS SCRIPT NEVER WRITES TO THE DATABASE.
// It executes ONLY prisma.findMany / prisma.findFirst queries, prints a
// human-readable audit report, and (only when --out is passed) writes a JSON
// and a CSV report FILE. It never repairs, normalizes, adds, or removes any
// user/role/profile/membership/subscription and never changes User.status.
//
// BUSINESS DISTINCTION ENFORCED BY THIS REPORT:
//   PERSISTED ACCOUNT STATE  = derived ONLY from persisted rows
//                              (UserRole rows, OrganizationMembership rows).
//                              A subscription NEVER proves an account exists.
//   CURRENT USABLE ACCOUNT   = existence + the CURRENT application rules
//                              (getAvailableAccounts / subscription usability).
//   CURRENT ONBOARDING STATE = what the app would compute for the default
//                              active role (getOnboardingState mirror).
//
// CLASSIFICATION POLICY (the NEW business rules — report-only):
//   VALID   : Candidate only | Recruiter only | Org Admin only |
//             Org Recruiter only | Candidate + Recruiter |
//             Candidate + Org Admin | Candidate + Org Recruiter
//   INVALID : Recruiter + Org Admin | Candidate + Recruiter + Org Admin
//             (any combination containing both Recruiter and Org Admin)
//   NOTE    : "Org Admin + Candidate" and "Recruiter only" and
//             "Org Admin only" are VALID under the new policy and are NOT
//             flagged. Historical data is never auto-corrected.
//
// Usage:
//   node backend/scripts/auditAccountState.js
//   node backend/scripts/auditAccountState.js --out <base-path>
//     -> writes <base-path>.json and <base-path>.csv
// ============================================================================

// Load backend/.env (repo-root .env as harmless fallback). Never prints env.
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
[
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../../.env"),
].forEach((candidate) => dotenv.config({ path: candidate }));

const prisma = require("../src/config/prisma");

// ---------------------------------------------------------------------------
// READ-ONLY MIRRORS of current application rules (subscription.service.js /
// auth.service.js). These constants replicate the app so the audit reflects
// real behavior. They do NOT change any rule.
// ---------------------------------------------------------------------------
const USABLE_STATUSES = ["ACTIVE", "TRIAL"]; // subscription.service.js
const ROLE_PRIORITY = ["EMPLOYEE", "RECRUITER", "ORG_ADMIN"]; // auth.service.js

const isSubscriptionUsable = (subscription, now) => {
  if (!subscription) return false;
  if (!USABLE_STATUSES.includes(subscription.status)) return false;
  if (subscription.expiryDate && subscription.expiryDate <= now) return false;
  return true;
};

const normalizeProfileValue = (value) =>
  typeof value === "string" ? value.trim() : value ?? "";

const hasRequiredText = (value) => {
  const text = normalizeProfileValue(value);
  return typeof text === "string" ? text.length > 0 : Boolean(text);
};

const hasValidSkillRecord = (skill) => {
  if (!skill || typeof skill !== "object") return false;
  const name = normalizeProfileValue(skill.name);
  const proficiency = normalizeProfileValue(skill.proficiency);
  const years = Number(skill.yearsOfExperience);
  return (
    hasRequiredText(name) &&
    hasRequiredText(proficiency) &&
    Number.isInteger(years) &&
    years >= 0 &&
    years <= 80
  );
};

const latestUsable = (subscriptions, now) =>
  [...(subscriptions ?? [])]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .find((subscription) => isSubscriptionUsable(subscription, now)) ?? null;

const csvEscape = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// ---------------------------------------------------------------------------
// Profile-completion mirrors (auth.service.js re-implementations, READ-ONLY)
// ---------------------------------------------------------------------------

const hasSkillVerificationData = (profile) => {
  const projectSkills = ((profile.projects ?? []) || []).flatMap(
    (project) => project.projectSkills ?? []
  );
  const hasProjectSkillEvidence = projectSkills.some((projectSkill) => {
    const name = normalizeProfileValue(
      projectSkill.customSkillName ?? (projectSkill.skill ? projectSkill.skill.name : "") ?? ""
    );
    const proficiency = normalizeProfileValue(projectSkill.proficiency);
    const years = Number(projectSkill.yearsOfExperience);
    return (
      Boolean(name || projectSkill.skillId) &&
      hasRequiredText(proficiency) &&
      (Number.isInteger(years) || projectSkill.yearsOfExperience == null)
    );
  });
  const hasCertificateEvidence = (profile.certificates ?? []).some(
    (certificate) =>
      Boolean(certificate.skillId) || hasRequiredText(certificate.name)
  );
  const hasDirectSkillEvidence = (profile.skills ?? []).some((skill) =>
    hasValidSkillRecord(skill)
  );
  return (
    hasDirectSkillEvidence || hasProjectSkillEvidence || hasCertificateEvidence
  );
};

// Mirror of evaluateEmployeeProfileCompletion (14 required fields).
const evaluateEmployeeProfileCompletion = ({ user, profile, profileData = {} }) => {
  const missingFields = [];
  const data = profileData && typeof profileData === "object" ? profileData : {};
  const careerInformation = data.careerInformation ?? {};
  const ageNumber = Number(
    data.personalInformation ? data.personalInformation.age : undefined
  );
  const hasCareerInformation =
    typeof careerInformation === "object" &&
    Object.values(careerInformation).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object" && value !== null)
        return Object.values(value).some(Boolean);
      return hasRequiredText(value);
    });

  if (!hasRequiredText(user && user.fullName)) missingFields.push("fullName");
  if (!normalizeProfileValue(user && user.profileImage)) missingFields.push("profileImage");
  if (!Number.isInteger(ageNumber) || ageNumber < 18 || ageNumber > 100) missingFields.push("age");
  if (!normalizeProfileValue(user && user.phone)) missingFields.push("phone");
  if (!normalizeProfileValue(user && user.city)) missingFields.push("city");
  if (!normalizeProfileValue(user && user.country)) missingFields.push("country");

  const headline = normalizeProfileValue(
    (profile && profile.headline) ??
      (data.generalInformation ? data.generalInformation.headline : undefined)
  );
  if (!headline) missingFields.push("headline");

  const bio = normalizeProfileValue(
    (profile && profile.bio) ??
      (data.professionalDescription ? data.professionalDescription.bio : undefined)
  );
  if (!bio) missingFields.push("bio");

  if (!hasCareerInformation) missingFields.push("careerInformation");
  if (
    !(profile && profile.availability) &&
    !(data.generalInformation && data.generalInformation.availability)
  ) {
    missingFields.push("availability");
  }

  const educationCount = Array.isArray(profile && profile.education)
    ? profile.education.length
    : 0;
  if (educationCount === 0) missingFields.push("education");

  const validSkills = Array.isArray(profile && profile.skills)
    ? profile.skills.filter(hasValidSkillRecord)
    : [];
  if (validSkills.length === 0) missingFields.push("skills");

  const validProjects = ((profile && profile.projects) || []).filter(
    (project) =>
      hasRequiredText(project && project.name) &&
      hasRequiredText(project && project.description)
  );
  if (validProjects.length === 0) missingFields.push("projects");

  if (!hasSkillVerificationData(profile ?? { skills: [], projects: [], certificates: [] })) {
    missingFields.push("skillVerification");
  }

  const deduped = [...new Set(missingFields)];
  return { isComplete: deduped.length === 0, missingFields: deduped };
};

// Mirror of isRecruiterProfileComplete.
const isRecruiterProfileComplete = (profile, isOrganizationRecruiter, user) => {
  const isRecruiterSpecificComplete = Boolean(
    profile &&
      profile.jobTitle &&
      profile.jobTitle.trim() &&
      (isOrganizationRecruiter || (profile.companyName && profile.companyName.trim()))
  );
  const isBasicProfileComplete =
    !user ||
    Boolean(
      hasRequiredText(user.fullName) &&
        hasRequiredText(user.profileImage) &&
        hasRequiredText(user.phone) &&
        hasRequiredText(user.city) &&
        hasRequiredText(user.country)
    );
  return isRecruiterSpecificComplete && isBasicProfileComplete;
};

// Mirror of isOrganizationProfileComplete.
const isOrganizationProfileComplete = (organization, user, organizationLogo) =>
  Boolean(
    organization &&
      organization.website &&
      organization.website.trim() &&
      organization.businessEmail &&
      organization.businessEmail.trim() &&
      organization.name &&
      organization.name.trim() &&
      organizationLogo &&
      hasRequiredText(user && user.fullName) &&
      hasRequiredText(user && user.email) &&
      hasRequiredText(user && user.profileImage) &&
      hasRequiredText(user && user.phone) &&
      hasRequiredText(user && user.city) &&
      hasRequiredText(user && user.country)
  );

// ---------------------------------------------------------------------------
// NEW-policy combination classification (report-only; nothing is fixed)
// ---------------------------------------------------------------------------
const classifyCombination = (roleNames, hasActiveOrgRecruiterMembership) => {
  const hasE = roleNames.includes("EMPLOYEE");
  const hasR = roleNames.includes("RECRUITER");
  const hasOA = roleNames.includes("ORG_ADMIN");

  if (hasR && hasOA) {
    return {
      label: hasE ? "Candidate + Recruiter + Org Admin" : "Recruiter + Org Admin",
      valid: false,
      reason: "Recruiter and Org Admin can never be combined",
    };
  }
  if (!hasE && !hasR && !hasOA) {
    return hasActiveOrgRecruiterMembership
      ? { label: "Org Recruiter only", valid: true }
      : {
          label: "NO_ACCOUNT",
          valid: false,
          reason: "No global roles and no ACTIVE organization-recruiter membership",
        };
  }
  if (hasE && !hasR && !hasOA) {
    return hasActiveOrgRecruiterMembership
      ? { label: "Candidate + Org Recruiter", valid: true }
      : { label: "Candidate only", valid: true };
  }
  if (!hasE && hasR && !hasOA) {
    return hasActiveOrgRecruiterMembership
      ? {
          label: "Recruiter + Org Recruiter membership",
          valid: true,
          note:
            "Global RECRUITER + ACTIVE org-recruiter membership is not produced by any current flow (informational)",
        }
      : { label: "Recruiter only", valid: true };
  }
  if (!hasE && !hasR && hasOA) {
    return hasActiveOrgRecruiterMembership
      ? {
          label: "Org Admin + Org Recruiter membership",
          valid: false,
          reason:
            "A combination containing both Recruiter (membership) and Org Admin semantics is not allowed",
        }
      : { label: "Org Admin only", valid: true };
  }
  if (hasE && hasR && !hasOA) {
    return { label: "Candidate + Recruiter", valid: true };
  }
  // hasE && hasOA && !hasR
  return hasActiveOrgRecruiterMembership
    ? {
        label: "Candidate + Org Admin + Org Recruiter membership",
        valid: false,
        reason:
          "Org Admin combined with an ACTIVE org-recruiter membership is not an allowed combination",
      }
    : { label: "Candidate + Org Admin", valid: true };
};

// ---------------------------------------------------------------------------
// READ-ONLY data loading (findMany only — no writes of any kind)
// ---------------------------------------------------------------------------
const loadWorkspace = async () => {
  const now = new Date();

  const users = await prisma.user.findMany({
    include: {
      roles: { include: { role: true } },
      employeeProfile: {
        include: {
          education: true,
          skills: true,
          projects: { include: { projectSkills: { include: { skill: true } } } },
          certificates: true,
        },
      },
      recruiterProfile: true,
      organizations: true,
      organizationMemberships: { include: { organization: true } },
    },
  });

  const subscriptions = await prisma.subscription.findMany({
    include: { plan: true },
  });

  const orgLogos = await prisma.storedFile.findMany({
    where: { ownerType: "ORGANIZATION", category: "ORGANIZATION_DOCUMENT" },
    orderBy: { createdAt: "desc" },
  });

  const subsByUser = new Map();
  const subsByOrg = new Map();
  for (const subscription of subscriptions) {
    if (subscription.userId) {
      if (!subsByUser.has(subscription.userId)) subsByUser.set(subscription.userId, []);
      subsByUser.get(subscription.userId).push(subscription);
    }
    if (subscription.organizationId) {
      if (!subsByOrg.has(subscription.organizationId)) subsByOrg.set(subscription.organizationId, []);
      subsByOrg.get(subscription.organizationId).push(subscription);
    }
  }

  const logoByOrgId = new Map();
  for (const logo of orgLogos) {
    if (!logoByOrgId.has(logo.ownerId)) logoByOrgId.set(logo.ownerId, logo);
  }

  const orgById = new Map();
  for (const user of users) {
    for (const organization of user.organizations ?? []) {
      orgById.set(organization.id, organization);
    }
    for (const membership of user.organizationMemberships ?? []) {
      if (membership.organization) orgById.set(membership.organization.id, membership.organization);
    }
  }

  return { now, users, subsByUser, subsByOrg, logoByOrgId, orgById };
};

// ---------------------------------------------------------------------------
// Per-user analysis. Pure + read-only: computes three SEPARATE views.
// ---------------------------------------------------------------------------
const analyzeUser = (user, ctx) => {
  const { now, subsByUser, subsByOrg, logoByOrgId } = ctx;

  const roleNames = [
    ...new Set((user.roles ?? []).map(({ role }) => (role ? role.name : null)).filter(Boolean)),
  ];
  const isSuperAdmin = roleNames.includes("SUPER_ADMIN");
  const hasEmployee = roleNames.includes("EMPLOYEE");
  const hasRecruiter = roleNames.includes("RECRUITER");
  const hasOrgAdmin = roleNames.includes("ORG_ADMIN");

  const allMemberships = user.organizationMemberships ?? [];
  const memberships = allMemberships.map((m) => ({
    id: m.id,
    role: m.role,
    status: m.status,
    organizationId: m.organizationId,
    organizationName: m.organization ? m.organization.name : null,
    organizationStatus: m.organization ? m.organization.status : null,
  }));

  const activeRecruiterMemberships = allMemberships.filter(
    (m) => m.role === "RECRUITER" && m.status === "ACTIVE"
  );
  const firstActiveRecruiterMembership = activeRecruiterMemberships[0] ?? null;
  const firstActiveOrgAdminMembership =
    allMemberships.find((m) => m.role === "ORG_ADMIN" && m.status === "ACTIVE") ?? null;
  const firstNotRemovedOrgAdminMembership =
    allMemberships.find((m) => m.role === "ORG_ADMIN" && m.status !== "REMOVED") ?? null;
  const activeAnyRoleMembership =
    allMemberships.find((m) => m.status === "ACTIVE") ?? null;

  const ownedOrganizations = (user.organizations ?? []).map((organization) => ({
    id: organization.id,
    name: organization.name,
    status: organization.status,
    createdAt: organization.createdAt,
  }));

  const personalSubscriptions = subsByUser.get(user.id) ?? [];
  const latestUsablePersonal = latestUsable(personalSubscriptions, now);
  const orgSubFor = (organizationId) => latestUsable(subsByOrg.get(organizationId) ?? [], now);

  const recruiterOrganization = firstActiveRecruiterMembership
    ? firstActiveRecruiterMembership.organization
    : null;
  const recruiterOrgSubscription = recruiterOrganization
    ? orgSubFor(recruiterOrganization.id)
    : null;
  const recruiterOrgUsable = Boolean(
    recruiterOrganization &&
      recruiterOrganization.status !== "SUSPENDED" &&
      recruiterOrgSubscription
  );

  // ================= 1. PERSISTED ACCOUNT STATE (rows ONLY) =================
  // A subscription is NEVER used to decide existence.
  const exists = {
    candidate: hasEmployee,
    recruiter: hasRecruiter,
    orgAdmin: Boolean(
      hasOrgAdmin &&
        (ownedOrganizations.length > 0 || firstNotRemovedOrgAdminMembership !== null)
    ),
    orgRecruiter: activeRecruiterMemberships.length > 0,
  };
  // Raw role facts kept separate so nothing is hidden by the orgAdmin rule.
  const hasOrgAdminRole = hasOrgAdmin;

  // ============ 2. CURRENT USABLE ACCOUNT STATE (current app rules) =========
  // Mirror of getAvailableAccounts() — subscriptions only affect USABILITY.
  const usable = {
    candidate: hasEmployee, // EMPLOYEE is never subscription-gated in the app
    recruiter: Boolean(
      (hasRecruiter || activeRecruiterMemberships.length > 0) &&
        (latestUsablePersonal || recruiterOrgUsable)
    ),
    orgAdmin: Boolean(
      firstActiveOrgAdminMembership &&
        firstActiveOrgAdminMembership.organization &&
        firstActiveOrgAdminMembership.organization.status !== "SUSPENDED" &&
        orgSubFor(firstActiveOrgAdminMembership.organization.id)
    ),
    orgRecruiter: recruiterOrgUsable,
  };

  // Profile view (login default resolution — mirror of getProfileAccounts).
  const profileAccounts = [];
  if (hasEmployee) profileAccounts.push("EMPLOYEE");
  if (hasRecruiter || activeRecruiterMemberships.length > 0) profileAccounts.push("RECRUITER");
  if (hasOrgAdmin && firstNotRemovedOrgAdminMembership) profileAccounts.push("ORG_ADMIN");

  // Mirror of selectDefaultRole (login default).
  const defaultRole =
    profileAccounts.includes("RECRUITER") && activeRecruiterMemberships.length > 0
      ? "RECRUITER"
      : profileAccounts.includes("ORG_ADMIN") && firstNotRemovedOrgAdminMembership
        ? "ORG_ADMIN"
        : ROLE_PRIORITY.find((role) => profileAccounts.includes(role)) ?? null;

  // Mirror of getAvailableAccounts output shape.
  const usableAccounts = [];
  if (hasEmployee) {
    usableAccounts.push({ role: "EMPLOYEE", scope: "user", organizationId: null });
  }
  if (
    (hasRecruiter || activeRecruiterMemberships.length > 0) &&
    (latestUsablePersonal || recruiterOrgUsable)
  ) {
    usableAccounts.push({
      role: "RECRUITER",
      scope: firstActiveRecruiterMembership ? "organization" : "user",
      organizationId: firstActiveRecruiterMembership
        ? firstActiveRecruiterMembership.organizationId
        : null,
    });
  }
  if (hasOrgAdmin && usable.orgAdmin) {
    usableAccounts.push({
      role: "ORG_ADMIN",
      scope: "organization",
      organizationId: firstActiveOrgAdminMembership.organizationId,
    });
  }

  // ============ 3. CURRENT ONBOARDING STATE (mirror of getOnboardingState) ==
  const resolveSubscriptionAccessFor = (role) => {
    // Mirror of resolveSubscriptionAccess({ id, role }).
    if (activeAnyRoleMembership) {
      const organization = activeAnyRoleMembership.organization;
      const subscription = orgSubFor(activeAnyRoleMembership.organizationId);
      return {
        allowed: Boolean(
          organization &&
            organization.status !== "SUSPENDED" &&
            isSubscriptionUsable(subscription, now)
        ),
        scope: "organization",
        organizationId: activeAnyRoleMembership.organizationId,
      };
    }
    if (role === "RECRUITER") {
      return {
        allowed: isSubscriptionUsable(latestUsablePersonal, now),
        scope: "user",
        organizationId: null,
      };
    }
    if (role === "ORG_ADMIN") {
      return { allowed: false, scope: "organization", organizationId: null };
    }
    return { allowed: false, scope: "none", organizationId: null };
  };

  const onboardingForRole = (role) => {
    if (role === "EMPLOYEE") {
      const completion = evaluateEmployeeProfileCompletion({
        user,
        profile: user.employeeProfile,
        profileData: (user.employeeProfile && user.employeeProfile.profileData) || {},
      });
      return {
        hasActiveSubscription: true,
        nextStep: user.mustChangePassword
          ? "PASSWORD_CHANGE_REQUIRED"
          : completion.isComplete
            ? "EMPLOYEE_DASHBOARD"
            : "EMPLOYEE_PROFILE_SETUP",
        profileComplete: completion.isComplete,
        missingFields: completion.missingFields,
      };
    }

    const access = resolveSubscriptionAccessFor(role);

    if (user.mustChangePassword) {
      return { hasActiveSubscription: access.allowed, nextStep: "PASSWORD_CHANGE_REQUIRED" };
    }

    let profileComplete = false;
    if (role === "RECRUITER" && access.allowed) {
      profileComplete = isRecruiterProfileComplete(
        user.recruiterProfile ?? null,
        access.scope === "organization",
        user
      );
    }
    if (role === "ORG_ADMIN" && access.allowed) {
      const organization = access.organizationId
        ? ctx.orgById.get(access.organizationId) ?? null
        : null;
      const logo = access.organizationId
        ? ctx.logoByOrgId.get(access.organizationId) ?? null
        : null;
      profileComplete = isOrganizationProfileComplete(organization, user, logo);
    }

    // Mirror of determineOnboardingNextStep.
    let nextStep;
    if (access.scope === "bypass") nextStep = "DASHBOARD";
    else if (access.scope === "user") {
      nextStep = !access.allowed ? "PAYMENT" : profileComplete ? "DASHBOARD" : "PROFILE_SETUP";
    } else if (access.scope === "organization") {
      nextStep = !access.allowed ? "PAYMENT" : profileComplete ? "DASHBOARD" : "PROFILE_SETUP";
    } else {
      nextStep = "PROFILE_SETUP";
    }

    return { hasActiveSubscription: access.allowed, nextStep, profileComplete };
  };

  const onboardingByRole = {};
  for (const account of profileAccounts) onboardingByRole[account] = onboardingForRole(account);
  const defaultOnboarding = defaultRole ? onboardingByRole[defaultRole] ?? null : null;

  // ==================== FLAG COMPUTATION (REPORT ONLY) ======================
  const combination = classifyCombination(roleNames, activeRecruiterMemberships.length > 0);

  const flags = [];
  const addFlag = (category, code, detail) => flags.push({ category, code, detail });

  if (!combination.valid) {
    addFlag(
      "ROLE_COMBINATION",
      "INVALID_COMBINATION",
      combination.label + (combination.reason ? " — " + combination.reason : "")
    );
  }
  if (hasOrgAdmin && activeRecruiterMemberships.length > 0) {
    addFlag(
      "ROLE_COMBINATION",
      "ORG_ADMIN_WITH_ACTIVE_ORG_RECRUITER_MEMBERSHIP",
      "Org Admin combined with an ACTIVE organization-recruiter membership is not an allowed combination"
    );
  }
  if (hasRecruiter && activeRecruiterMemberships.length > 0) {
    addFlag(
      "INFORMATIONAL",
      "GLOBAL_RECRUITER_WITH_ORG_MEMBERSHIP",
      "Not produced by any current flow (createActiveRecruiter refuses users already holding global roles)"
    );
  }

  // ---- profile consistency ----
  if (hasEmployee && !user.employeeProfile) {
    addFlag("PROFILE", "CANDIDATE_WITHOUT_EMPLOYEE_PROFILE", "UserRole EMPLOYEE exists but EmployeeProfile row is missing");
  }
  if (hasRecruiter && !user.recruiterProfile) {
    addFlag("PROFILE", "RECRUITER_WITHOUT_RECRUITER_PROFILE", "UserRole RECRUITER exists but RecruiterProfile row is missing");
  }
  if (user.employeeProfile && !hasEmployee) {
    addFlag("PROFILE", "EMPLOYEE_PROFILE_WITHOUT_CANDIDATE_ACCOUNT", "EmployeeProfile exists without a UserRole EMPLOYEE");
  }
  const anyRecruiterMembership = allMemberships.some((m) => m.role === "RECRUITER");
  if (user.recruiterProfile && !hasRecruiter && !anyRecruiterMembership) {
    addFlag("PROFILE", "ORPHAN_RECRUITER_PROFILE", "RecruiterProfile exists without any RECRUITER role or organization-recruiter membership");
  }
  // NOTE: RecruiterProfile WITHOUT global RECRUITER role is EXPECTED for org
  // recruiters (createActiveRecruiter provisions it by design) — not flagged.
  if (hasOrgAdmin && ownedOrganizations.length === 0 && firstNotRemovedOrgAdminMembership === null) {
    addFlag("PROFILE", "ORG_ADMIN_WITHOUT_ORGANIZATION", "UserRole ORG_ADMIN exists but user owns no Organization and holds no ORG_ADMIN membership");
  }

  // ---- membership consistency ----
  if (allMemberships.some((m) => m.role === "ORG_ADMIN" && !hasOrgAdmin)) {
    addFlag("MEMBERSHIP", "ORG_ADMIN_MEMBERSHIP_WITHOUT_USER_ROLE", "OrganizationMembership(ORG_ADMIN) exists without a UserRole ORG_ADMIN");
  }
  const activeMembershipCount = allMemberships.filter((m) => m.status === "ACTIVE").length;
  if (activeMembershipCount > 1) {
    addFlag("MEMBERSHIP", "MULTIPLE_ACTIVE_MEMBERSHIPS", "User holds " + activeMembershipCount + " ACTIVE memberships; app resolution (findFirst) only uses the first");
  }
  if (firstActiveOrgAdminMembership && activeRecruiterMemberships.length > 0) {
    addFlag("MEMBERSHIP", "CONTRADICTORY_ACTIVE_MEMBERSHIPS", "ACTIVE ORG_ADMIN membership and ACTIVE RECRUITER membership simultaneously");
  }
  if (activeAnyRoleMembership && ["SUSPENDED", "INACTIVE"].includes(user.status)) {
    addFlag("MEMBERSHIP", "ACTIVE_MEMBERSHIP_WITH_INACTIVE_USER", "Membership is ACTIVE while user.status=" + user.status);
  }
  if (roleNames.length === 0 && activeRecruiterMemberships.length === 0 && allMemberships.length > 0) {
    addFlag("ACCOUNT", "NO_USABLE_ACCOUNT_STATE", "User has membership(s) but no global roles and no ACTIVE recruiter membership (no usable account)");
  }

  // ---- subscription detail (read-only view) ----
  const toSubView = (subscription, ownerType, ownerId) => ({
    id: subscription.id,
    ownerType,
    ownerId,
    plan: subscription.plan ? subscription.plan.name : null,
    planType: subscription.plan ? subscription.plan.type : null,
    status: subscription.status,
    startDate: subscription.startDate,
    expiryDate: subscription.expiryDate,
    usable: isSubscriptionUsable(subscription, now),
  });
  const personalSubscriptionViews = personalSubscriptions.map((s) => toSubView(s, "user", s.userId));
  const relevantOrgIds = new Set([
    ...ownedOrganizations.map((o) => o.id),
    ...allMemberships.map((m) => m.organizationId),
  ]);
  const organizationSubscriptionViews = [];
  const seenOrgSubIds = new Set();
  for (const organizationId of relevantOrgIds) {
    for (const s of subsByOrg.get(organizationId) ?? []) {
      if (seenOrgSubIds.has(s.id)) continue;
      seenOrgSubIds.add(s.id);
      organizationSubscriptionViews.push(toSubView(s, "organization", organizationId));
    }
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerified: user.emailVerified,
      isDeleted: user.isDeleted,
      mustChangePassword: user.mustChangePassword,
    },
    isSuperAdmin,
    persisted: {
      globalRoles: roleNames,
      hasOrgAdminRole,
      employeeProfileExists: Boolean(user.employeeProfile),
      recruiterProfileExists: Boolean(user.recruiterProfile),
      ownedOrganizations,
      memberships,
    },
    exists,
    usable,
    usableAccounts,
    profileAccounts,
    defaultRole,
    defaultOnboarding,
    onboardingByRole,
    combination,
    flags,
    subscriptions: { personal: personalSubscriptionViews, organization: organizationSubscriptionViews },
  };
};

// ---------------------------------------------------------------------------
// Global aggregation + subscription-level consistency checks (read-only)
// ---------------------------------------------------------------------------
const buildReport = async () => {
  const ctx = await loadWorkspace();
  const now = ctx.now;

  const analyses = ctx.users.map((user) => analyzeUser(user, ctx));
  const normalUsers = analyses.filter((a) => !a.isSuperAdmin);
  const superAdmins = analyses.filter((a) => a.isSuperAdmin);

  // ---- global subscription consistency ----
  const allSubscriptions = [];
  const seenSubIds = new Set();
  for (const bucket of [...ctx.subsByUser.values(), ...ctx.subsByOrg.values()]) {
    for (const subscription of bucket) {
      if (!seenSubIds.has(subscription.id)) {
        seenSubIds.add(subscription.id);
        allSubscriptions.push(subscription);
      }
    }
  }

  const subscriptionIssues = [];
  for (const subscription of allSubscriptions) {
    if (!subscription.userId && !subscription.organizationId) {
      subscriptionIssues.push({ code: "ORPHAN_SUBSCRIPTION", id: subscription.id, detail: "Subscription has neither userId nor organizationId" });
    }
    if (subscription.userId && subscription.organizationId) {
      subscriptionIssues.push({ code: "AMBIGUOUS_SUBSCRIPTION", id: subscription.id, detail: "Subscription has BOTH userId=" + subscription.userId + " and organizationId=" + subscription.organizationId });
    }
    if (["ACTIVE", "TRIAL"].includes(subscription.status) && subscription.expiryDate && subscription.expiryDate <= now) {
      subscriptionIssues.push({ code: "STATUS_SAYS_USABLE_BUT_EXPIRED", id: subscription.id, detail: "status=" + subscription.status + " but expiryDate " + subscription.expiryDate.toISOString() + " is in the past (app treats it as unusable)" });
    }
    if (["EXPIRED", "CANCELLED", "SUSPENDED"].includes(subscription.status) && subscription.expiryDate && subscription.expiryDate > now) {
      subscriptionIssues.push({ code: "STATUS_SAYS_DEAD_BUT_NOT_EXPIRED", id: subscription.id, detail: "status=" + subscription.status + " but expiryDate " + subscription.expiryDate.toISOString() + " is still in the future" });
    }
  }
  for (const [ownerId, list] of ctx.subsByUser) {
    const usableCount = list.filter((s) => isSubscriptionUsable(s, now)).length;
    if (usableCount > 1) {
      subscriptionIssues.push({ code: "MULTIPLE_USABLE_SUBSCRIPTIONS", id: ownerId, detail: "User " + ownerId + " has " + usableCount + " simultaneously usable subscriptions (app reads latest only)" });
    }
  }
  for (const [ownerId, list] of ctx.subsByOrg) {
    const usableCount = list.filter((s) => isSubscriptionUsable(s, now)).length;
    if (usableCount > 1) {
      subscriptionIssues.push({ code: "MULTIPLE_USABLE_SUBSCRIPTIONS", id: ownerId, detail: "Organization " + ownerId + " has " + usableCount + " simultaneously usable subscriptions (app reads latest only)" });
    }
  }

  // ---- counts ----
  const combinationCounts = {};
  for (const analysis of normalUsers) {
    const key = analysis.combination.label;
    combinationCounts[key] = (combinationCounts[key] ?? 0) + 1;
  }
  const countByCategory = {};
  const countByCode = {};
  for (const analysis of normalUsers) {
    for (const flag of analysis.flags) {
      countByCategory[flag.category] = (countByCategory[flag.category] ?? 0) + 1;
      countByCode[flag.code] = (countByCode[flag.code] ?? 0) + 1;
    }
  }
  const flaggedUsers = normalUsers.filter((a) => a.flags.length > 0);
  const invalidCombinationUsers = normalUsers.filter((a) =>
    a.flags.some((f) => f.category === "ROLE_COMBINATION")
  );
  const profileIssueUsers = normalUsers.filter((a) =>
    a.flags.some((f) => f.category === "PROFILE" || f.category === "MEMBERSHIP")
  );
  const superAdminAnomalies = superAdmins.filter(
    (a) => a.persisted.globalRoles.length !== 1
  );

  return {
    ctx,
    analyses,
    normalUsers,
    superAdmins,
    superAdminAnomalies,
    flaggedUsers,
    invalidCombinationUsers,
    profileIssueUsers,
    subscriptionIssues,
    combinationCounts,
    countByCategory,
    countByCode,
  };
};

// ---------------------------------------------------------------------------
// Printing (human-readable) + export (JSON/CSV, only with --out)
// ---------------------------------------------------------------------------
const pad = (value, width) => String(value ?? "").padEnd(width, " ");

const printReport = (report) => {
  console.log("=====================================================================");
  console.log(" ACCOUNT STATE AUDIT (READ-ONLY) — persisted vs usable vs onboarding");
  console.log("=====================================================================");
  console.log("Generated : " + new Date().toISOString());
  console.log("Policy    : NEW account model (no universal base account).");
  console.log("            VALID   : Candidate | Recruiter | OrgAdmin | OrgRecruiter |");
  console.log("                      Candidate+Recruiter | Candidate+OrgAdmin |");
  console.log("                      Candidate+OrgRecruiter");
  console.log("            INVALID : anything with both Recruiter and Org Admin.");
  console.log("            Existence is NEVER inferred from subscriptions.");
  console.log("");

  console.log("---- 1. SUMMARY ----");
  console.log("Total users in DB           : " + report.analyses.length);
  console.log("Non-super-admin users       : " + report.normalUsers.length);
  console.log("Deleted (isDeleted) users   : " + report.normalUsers.filter((a) => a.user.isDeleted).length);
  console.log("SUPER_ADMIN users           : " + report.superAdmins.length + (report.superAdminAnomalies.length ? " (" + report.superAdminAnomalies.length + " with anomaly)" : ""));
  console.log("");
  console.log("Users by persisted account combination:");
  for (const [label, count] of Object.entries(report.combinationCounts)) {
    console.log("  " + pad(label, 50) + count);
  }
  console.log("");
  console.log("Invalid role combinations   : " + report.invalidCombinationUsers.length + " user(s)");
  console.log("Profile inconsistencies     : " + (report.countByCategory.PROFILE ?? 0) + " flag(s); membership flags: " + (report.countByCategory.MEMBERSHIP ?? 0));
  console.log("Subscription inconsistencies: " + report.subscriptionIssues.length);
  console.log("Users with any flag         : " + report.flaggedUsers.length);
  console.log("");
  console.log("Flag counts by category: " + JSON.stringify(report.countByCategory));
  console.log("Flag counts by code    : " + JSON.stringify(report.countByCode));
  console.log("");

  console.log("---- 2. PER-USER STATE (PERSISTED / USABLE / ONBOARDING) ----");
  for (const analysis of report.normalUsers) {
    const u = analysis.user;
    const persisted = analysis.persisted;
    console.log(
      "[" + pad(u.email, 34) + "] status=" + pad(u.status, 30) +
      " verified=" + pad(String(u.emailVerified), 5) + (u.isDeleted ? " [DELETED]" : "")
    );
    console.log(
      "   PERSISTED : roles=[" + persisted.globalRoles.join(", ") + "]" +
      " | employeeProfile=" + (persisted.employeeProfileExists ? "yes" : "no") +
      " | recruiterProfile=" + (persisted.recruiterProfileExists ? "yes" : "no") +
      " | ownedOrgs=" + persisted.ownedOrganizations.length +
      " | memberships=[" + (persisted.memberships.map((m) => m.role + "/" + m.status).join(", ") || "-") + "]"
    );
    console.log(
      "   EXISTS    : Candidate=" + pad(String(analysis.exists.candidate), 5) +
      " Recruiter=" + pad(String(analysis.exists.recruiter), 5) +
      " OrgAdmin=" + pad(String(analysis.exists.orgAdmin), 5) +
      " OrgRecruiter=" + String(analysis.exists.orgRecruiter)
    );
    console.log(
      "   USABLE    : Candidate=" + pad(String(analysis.usable.candidate), 5) +
      " Recruiter=" + pad(String(analysis.usable.recruiter), 5) +
      " OrgAdmin=" + pad(String(analysis.usable.orgAdmin), 5) +
      " OrgRecruiter=" + String(analysis.usable.orgRecruiter) +
      " -> usableAccounts=" + JSON.stringify(analysis.usableAccounts)
    );
    console.log(
      "   ONBOARDING: defaultRole=" + pad(analysis.defaultRole ?? "-", 10) +
      " nextStep=" + (analysis.defaultOnboarding ? analysis.defaultOnboarding.nextStep : "-")
    );
    console.log(
      "   COMBO     : " + analysis.combination.label + (analysis.combination.valid ? "  [VALID]" : "  [INVALID]") +
      (analysis.flags.length ? "  FLAGS: " + analysis.flags.map((f) => f.code).join(", ") : "")
    );
  }
  if (report.normalUsers.length === 0) console.log("  (no non-super-admin users found)");
  console.log("");

  console.log("---- 3. FLAGGED USERS DETAIL ----");
  if (report.flaggedUsers.length === 0) console.log("  (none)");
  for (const analysis of report.flaggedUsers) {
    console.log("  " + analysis.user.email + " (" + analysis.user.id + ")");
    for (const flag of analysis.flags) {
      console.log("    [" + flag.category + "] " + flag.code + " — " + flag.detail);
    }
    console.log(
      "    combination: " + analysis.combination.label +
      (analysis.combination.valid ? " [VALID]" : " [INVALID]")
    );
  }
  console.log("");

  console.log("---- 4. SUBSCRIPTION INCONSISTENCIES ----");
  if (report.subscriptionIssues.length === 0) console.log("  (none)");
  for (const issue of report.subscriptionIssues) {
    console.log("  [" + issue.code + "] " + issue.id + " — " + issue.detail);
  }
  console.log("");

  console.log("---- 5. SUPER_ADMIN SANITY ----");
  if (report.superAdmins.length === 0) console.log("  (no super admins)");
  for (const analysis of report.superAdmins) {
    const anomaly = analysis.persisted.globalRoles.length !== 1;
    console.log(
      "  " + analysis.user.email + " roles=[" + analysis.persisted.globalRoles.join(", ") + "]" +
      (anomaly ? "  [ANOMALY: SUPER_ADMIN must be a single-role account]" : "  [OK]")
    );
  }
  console.log("");
  console.log("Read-only audit complete. No database rows were written, updated,");
  console.log("or deleted; no migration was executed.");
};

const buildJsonReport = (report) => ({
  meta: {
    generatedAt: new Date().toISOString(),
    script: "backend/scripts/auditAccountState.js",
    mode: "READ-ONLY (findMany/findFirst only)",
    policy: {
      validCombinations: [
        "Candidate only",
        "Recruiter only",
        "Org Admin only",
        "Org Recruiter only",
        "Candidate + Recruiter",
        "Candidate + Org Admin",
        "Candidate + Org Recruiter",
      ],
      invalidCombinations: [
        "Recruiter + Org Admin",
        "Candidate + Recruiter + Org Admin",
        "Any combination containing both Recruiter and Org Admin",
      ],
      existenceRules: {
        candidate: "UserRole EMPLOYEE exists",
        recruiter: "UserRole RECRUITER exists",
        orgAdmin: "UserRole ORG_ADMIN exists AND (owns an Organization OR holds a non-REMOVED ORG_ADMIN membership)",
        orgRecruiter: "ACTIVE OrganizationMembership with role RECRUITER",
      },
      existenceNeverUsesSubscriptions: true,
    },
  },
  summary: {
    totalUsers: report.analyses.length,
    nonSuperAdminUsers: report.normalUsers.length,
    deletedUsers: report.normalUsers.filter((a) => a.user.isDeleted).length,
    superAdmins: report.superAdmins.length,
    combinationCounts: report.combinationCounts,
    invalidCombinationUsers: report.invalidCombinationUsers.length,
    profileInconsistencyFlags: report.countByCategory.PROFILE ?? 0,
    membershipInconsistencyFlags: report.countByCategory.MEMBERSHIP ?? 0,
    subscriptionInconsistencies: report.subscriptionIssues.length,
    usersWithAnyFlag: report.flaggedUsers.length,
  },
  flagCounts: { byCategory: report.countByCategory, byCode: report.countByCode },
  subscriptionIssues: report.subscriptionIssues,
  superAdminSanity: report.superAdmins.map((a) => ({
    email: a.user.email,
    roles: a.persisted.globalRoles,
    anomaly: a.persisted.globalRoles.length !== 1,
  })),
  users: report.analyses,
});

const buildCsv = (report) => {
  const header = [
    "email", "id", "status", "emailVerified", "isDeleted",
    "globalRoles", "combination", "combinationValid",
    "candidateExists", "recruiterExists", "orgAdminExists", "orgRecruiterExists",
    "candidateUsable", "recruiterUsable", "orgAdminUsable", "orgRecruiterUsable",
    "defaultRole", "defaultNextStep", "employeeProfileExists", "recruiterProfileExists",
    "ownedOrgCount", "activeMembershipCount", "personalSubscriptions", "personalUsableSubscriptions",
    "flags",
  ];
  const rows = report.normalUsers.map((analysis) => [
    analysis.user.email,
    analysis.user.id,
    analysis.user.status,
    analysis.user.emailVerified,
    analysis.user.isDeleted,
    analysis.persisted.globalRoles.join("|"),
    analysis.combination.label,
    analysis.combination.valid ? "VALID" : "INVALID",
    analysis.exists.candidate,
    analysis.exists.recruiter,
    analysis.exists.orgAdmin,
    analysis.exists.orgRecruiter,
    analysis.usable.candidate,
    analysis.usable.recruiter,
    analysis.usable.orgAdmin,
    analysis.usable.orgRecruiter,
    analysis.defaultRole ?? "",
    analysis.defaultOnboarding ? analysis.defaultOnboarding.nextStep : "",
    analysis.persisted.employeeProfileExists,
    analysis.persisted.recruiterProfileExists,
    analysis.persisted.ownedOrganizations.length,
    analysis.persisted.memberships.filter((m) => m.status === "ACTIVE").length,
    analysis.subscriptions.personal.length,
    analysis.subscriptions.personal.filter((s) => s.usable).length,
    analysis.flags.map((f) => f.code).join("|"),
  ]);
  return [header.join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n");
};

const main = async () => {
  const args = process.argv.slice(2);
  let outBase = null;
  const outIndex = args.indexOf("--out");
  if (outIndex !== -1 && args[outIndex + 1]) outBase = path.resolve(args[outIndex + 1]);

  const report = await buildReport();
  printReport(report);

  if (outBase) {
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    const jsonPath = outBase + ".json";
    const csvPath = outBase + ".csv";
    fs.writeFileSync(jsonPath, JSON.stringify(buildJsonReport(report), null, 2), "utf8");
    fs.writeFileSync(csvPath, buildCsv(report) + "\n", "utf8");
    console.log("Exports written (by this read-only script):");
    console.log("  JSON: " + jsonPath);
    console.log("  CSV : " + csvPath);
  }
};

main()
  .catch((error) => {
    console.error("AUDIT FAILED (read-only; no data was changed):", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });










