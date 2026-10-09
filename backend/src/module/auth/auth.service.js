const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { assertProtectedSuperAdminCanReceiveRole } = require("./super-admin-protection");
const { deleteOwnedFile, findOwnedFile } = require("../storage/storage.service");

const {
  findUserByEmail,
  findUsersByEmail,
  findRoleByName,
  findUserById,
  findRecruiterProfileByUserId,
  upsertRecruiterProfile,
  findEmployeeProfileByUserId,
  getEmployeeProfileWithRelations,
  ensureEmployeeProfile,
  saveEmployeeProfile,
  upsertEmployeeProfileEducation,
  deleteEmployeeProfileEducation,
  upsertEmployeeProfileSkill,
  deleteEmployeeProfileSkill,
  upsertEmployeeProfileProject,
  deleteEmployeeProfileProject,
  upsertEmployeeProfileProjectSkill,
  deleteEmployeeProfileProjectSkill,
  upsertEmployeeProfileCertificate,
  deleteEmployeeProfileCertificate,
  createUser,
  addRoleToExistingUser,
  ensureEmployeeAccount,
  getRequiredRegistrationRoleNames,
  findVerificationToken,
  verifyUserEmail,
  createAuthenticatedSession,
  updateLoginSecurity,
  updateEmployeeUserProfile,
  updateAccountProfile,
  updateEmployeeProfileData,
  findRefreshTokenForSession,
  rotateRefreshToken,
  revokeLoginSession,
  deleteVerificationTokens,
  createVerificationToken,
  deletePasswordResetTokens,
  createPasswordResetToken,
  findPasswordResetToken,
  markPasswordResetTokenUsed,
  updateUserPassword,
  findRecentPasswordHistory,
  PASSWORD_HISTORY_DEPTH,
} = require("./auth.repository");

const hashPassword = require("../../utils/hashPassword");
const sendVerificationEmail = require("../../utils/sendVerificationEmail");
const sendPasswordResetEmail = require("../../utils/sendPasswordResetEmail");
const comparePassword = require("../../utils/comparePassword");
const generateAccessToken = require("../../utils/generateAccessToken");
const generateRefreshToken = require("../../utils/generateRefreshToken");
const {
  NORMAL_USER_ROLES,
  normalizeRoleSet,
  isAllowedRoleCombination,
  getAllowedActivationRoles,
} = require("./role-policy");
const {
  resolveSubscriptionAccess,
  isSubscriptionUsable,
} = require("../subscription/subscription.service");

const {
  findOrganizationById,
  findOrganizationLogoByOwnerId,
} = require("../organization/organization.repository");

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SELECTOR_BYTES = 32;

const hashSecret = (secret) =>
  crypto.createHash("sha256").update(secret).digest("hex");

const isValidSessionSelector = (selector) =>
  typeof selector === "string" && /^[A-Za-z0-9_-]{43}$/.test(selector);

// This selector is not authentication by itself: the server also requires the
// matching HttpOnly refresh cookie. It is only a tab-scoped binding that lets
// the refresh endpoint select one session from the browser's shared cookie jar.
const generateSessionSelector = () => crypto.randomBytes(SESSION_SELECTOR_BYTES).toString("base64url");

const ROLE_PRIORITY = ["EMPLOYEE", "RECRUITER", "ORG_ADMIN", "SUPER_ADMIN"];

const getUserRoles = (user) =>
  [...new Set((user.roles ?? []).map(({ role }) => role?.name).filter(Boolean))];

const hasActiveOrganizationRecruiterMembership = (user) =>
  user.organizationMemberships?.some(
    ({ role, status }) => role === "RECRUITER" && status === "ACTIVE"
  ) ?? false;

const hasValidRoleConfiguration = (user) => {
  const roles = getUserRoles(user);

  if (roles.includes("SUPER_ADMIN")) {
    return roles.length === 1;
  }

  return isAllowedRoleCombination(roles) ||
    (roles.length === 0 && hasActiveOrganizationRecruiterMembership(user));
};

const selectDefaultRole = (roles, user = null) => {
  const normalizedRoles = roles ?? [];

  if (normalizedRoles.includes("RECRUITER") && hasActiveOrganizationRecruiterMembership(user)) {
    return "RECRUITER";
  }

  if (normalizedRoles.includes("ORG_ADMIN")) {
    const hasOrgAdminMembership = user?.organizationMemberships?.some(
      ({ role, status }) => role === "ORG_ADMIN" && status !== "REMOVED"
    );

    if (hasOrgAdminMembership || !user) {
      return "ORG_ADMIN";
    }
  }

  return ROLE_PRIORITY.find((role) => normalizedRoles.includes(role));
};

const getProfileAccounts = (user) => {
  const assignedRoles = getUserRoles(user);
  const accounts = [];

  if (assignedRoles.includes("EMPLOYEE")) {
    accounts.push({ role: "EMPLOYEE", scope: "user" });
  }

  const organizationMembership = user.organizationMemberships?.find(
    ({ role, status }) => role === "RECRUITER" && status === "ACTIVE"
  );
  if (assignedRoles.includes("RECRUITER") || organizationMembership) {
    accounts.push({
      role: "RECRUITER",
      scope: organizationMembership ? "organization" : "user",
      organizationId: organizationMembership?.organizationId,
    });
  }

  if (assignedRoles.includes("ORG_ADMIN")) {
    const membership = user.organizationMemberships?.find(
      ({ role, status }) => role === "ORG_ADMIN" && status !== "REMOVED"
    );
    if (membership) {
      accounts.push({
        role: "ORG_ADMIN",
        scope: "organization",
        organizationId: membership.organizationId,
      });
    }
  }

  if (assignedRoles.includes("SUPER_ADMIN")) {
    accounts.push({ role: "SUPER_ADMIN", scope: "platform" });
  }

  return accounts;
};

const getLatestUsableSubscription = (subscriptions = []) =>
  [...subscriptions]
    .sort((left, right) => right.createdAt - left.createdAt)
    .find(isSubscriptionUsable);

const getAvailableAccounts = (user) => {
  const assignedRoles = getUserRoles(user);
  const accounts = [];

  if (assignedRoles.includes("EMPLOYEE")) {
    accounts.push({ role: "EMPLOYEE", scope: "user" });
  }

  if (assignedRoles.includes("RECRUITER") || hasActiveOrganizationRecruiterMembership(user)) {
    const personalSubscription = getLatestUsableSubscription(user.subscriptions);
    const organizationMembership = user.organizationMemberships?.find(
      (membership) => membership.role === "RECRUITER" && membership.status === "ACTIVE"
    );
    const organizationSubscription = organizationMembership
      ? getLatestUsableSubscription(organizationMembership.organization?.subscriptions)
      : null;

    if (
      personalSubscription ||
      (organizationMembership &&
        organizationMembership.organization?.status !== "SUSPENDED" &&
        organizationSubscription)
    ) {
      accounts.push({
        role: "RECRUITER",
        scope: organizationMembership ? "organization" : "user",
        organizationId: organizationMembership?.organizationId,
      });
    }
  }

  if (assignedRoles.includes("ORG_ADMIN")) {
    const membership = user.organizationMemberships?.find(
      ({ role, status }) => role === "ORG_ADMIN" && status === "ACTIVE"
    );
    const subscription = membership
      ? getLatestUsableSubscription(membership.organization?.subscriptions)
      : null;

    if (
      membership &&
      membership.organization?.status !== "SUSPENDED" &&
      subscription
    ) {
      accounts.push({
        role: "ORG_ADMIN",
        scope: "organization",
        organizationId: membership.organizationId,
      });
    }
  }

  if (assignedRoles.includes("SUPER_ADMIN")) {
    accounts.push({ role: "SUPER_ADMIN", scope: "platform" });
  }

  return accounts;
};

// The complement of getAvailableAccounts: which accounts this user could still
// ACTIVATE, as opposed to the accounts that already exist and are usable. The
// policy itself stays in role-policy.js — this only adapts the two account
// shapes that policy does not model directly:
//   * SUPER_ADMIN is never offered a standard account transition (the same
//     reason validateRoleSwitchEligibility rejects it).
//   * An ACTIVE organization-recruiter membership IS that user's RECRUITER
//     account — getAvailableAccounts grants it without any global RECRUITER
//     UserRole — so it must participate in the policy input. That keeps a
//     membership-only Organization Recruiter's only transition at the
//     Candidate base account (RECRUITER is already held; ORG_ADMIN can never
//     co-exist with a Recruiter account).
const getActivationRoles = (user) => {
  const assignedRoles = getUserRoles(user);

  if (assignedRoles.includes("SUPER_ADMIN")) {
    return [];
  }

  const policyRoles = hasActiveOrganizationRecruiterMembership(user)
    ? [...assignedRoles, "RECRUITER"]
    : assignedRoles;

  return getAllowedActivationRoles(policyRoles);
};

const validateRoleSwitchEligibility = (user, requestedRole) => {
  if (requestedRole) {
    assertProtectedSuperAdminCanReceiveRole(user, requestedRole);
  }
  const assignedRoles = getUserRoles(user);
  const hasEmployee = assignedRoles.includes("EMPLOYEE");
  const hasRecruiter = assignedRoles.includes("RECRUITER");
  const hasOrgAdmin = assignedRoles.includes("ORG_ADMIN");
  const isSuperAdmin = assignedRoles.includes("SUPER_ADMIN");

  if (isSuperAdmin) {
    if (!requestedRole || requestedRole === "SUPER_ADMIN") {
      return;
    }

    const error = new Error("SUPER_ADMIN accounts can only remain SUPER_ADMIN");
    error.status = 403;
    throw error;
  }

  if (requestedRole === "SUPER_ADMIN") {
    const error = new Error("SUPER_ADMIN is not available for standard role switching");
    error.status = 403;
    throw error;
  }

  const currentCombination = normalizeRoleSet(assignedRoles);
  const isMembershipOnlyOrganizationRecruiter =
    currentCombination.length === 0 && hasActiveOrganizationRecruiterMembership(user);
  if (!isAllowedRoleCombination(currentCombination) && !isMembershipOnlyOrganizationRecruiter) {
    const error = new Error("This account has an invalid role combination");
    error.status = 403;
    throw error;
  }

  if (!requestedRole) {
    return;
  }

  if (requestedRole === "RECRUITER" && hasActiveOrganizationRecruiterMembership(user)) {
    return;
  }

  if (!NORMAL_USER_ROLES.includes(requestedRole)) {
    const error = new Error("Selected role is not valid for this account");
    error.status = 403;
    throw error;
  }

  const resultingRoles = normalizeRoleSet([...assignedRoles, requestedRole]);
  if (!isAllowedRoleCombination(resultingRoles)) {
    const error = new Error(
      `This role combination is not allowed: ${[...resultingRoles].sort().join(" + ")}`
    );
    error.status = 403;
    throw error;
  }

  if (requestedRole === "RECRUITER" && hasOrgAdmin) {
    const error = new Error("This account cannot switch to RECRUITER while ORG_ADMIN is active");
    error.status = 403;
    throw error;
  }

  if (requestedRole === "ORG_ADMIN" && hasRecruiter) {
    const error = new Error("This account cannot switch to ORG_ADMIN while RECRUITER is active");
    error.status = 403;
    throw error;
  }

  if (requestedRole === "EMPLOYEE" && !hasEmployee) {
    const error = new Error("Selected role is not valid for this account");
    error.status = 403;
    throw error;
  }

  if (requestedRole === "RECRUITER" && !hasRecruiter && !hasEmployee) {
    const error = new Error("Selected role is not valid for this account");
    error.status = 403;
    throw error;
  }

  if (requestedRole === "ORG_ADMIN" && !hasOrgAdmin && !hasEmployee) {
    const error = new Error("Selected role is not valid for this account");
    error.status = 403;
    throw error;
  }
};

const getRoleState = (user, selectedRole, usableOnly = true) => {
  const accounts = usableOnly ? getAvailableAccounts(user) : getProfileAccounts(user);
  const roles = accounts.map(({ role }) => role);

  if (selectedRole) {
    validateRoleSwitchEligibility(user, selectedRole);

    if (!roles.includes(selectedRole)) {
      throw new Error("Selected role is not valid for this account");
    }

    return { role: selectedRole, roles, accounts };
  }

  const explicitRole = roles.includes("SUPER_ADMIN")
    ? "SUPER_ADMIN"
    : selectDefaultRole(roles, user);

  if (explicitRole === "SUPER_ADMIN") {
    validateRoleSwitchEligibility(user, "SUPER_ADMIN");
  } else {
    validateRoleSwitchEligibility(user, explicitRole);
  }

  if (!explicitRole || !roles.includes(explicitRole)) {
    throw new Error("No usable account is available");
  }

  return { role: explicitRole, roles, accounts };
};

const getRefreshCookieName = (sessionSelector) => {
  if (!isValidSessionSelector(sessionSelector)) {
    throw new Error("Invalid authentication session");
  }

  const prefix = process.env.NODE_ENV === "production" ? "__Secure-refreshToken_" : "refreshToken_";
  return `${prefix}${sessionSelector}`;
};

// RecruiterProfile has no explicit "completed" flag (every field is optional,
// and registration creates an empty stub row). In the absence of a dedicated
// completion field, jobTitle is the minimal required identity for an
// organization recruiter, while Independent Recruiters also require
// companyName. Not a new schema field, just a convention over existing columns.
const isRecruiterProfileComplete = (
  profile,
  isOrganizationRecruiter = false,
  user = null
) => {
  const isRecruiterSpecificComplete = Boolean(
    profile &&
      profile.jobTitle &&
      profile.jobTitle.trim() &&
      (isOrganizationRecruiter || (profile.companyName && profile.companyName.trim()))
  );

  const isBasicProfileComplete = !user || Boolean(
    hasRequiredText(user?.fullName) &&
    hasRequiredText(user?.profileImage) &&
    hasRequiredText(user?.phone) &&
    hasRequiredText(user?.city) &&
    hasRequiredText(user?.country)
  );

  return isRecruiterSpecificComplete && isBasicProfileComplete;
};

// Organization profile requires website + businessEmail to be considered
// "setup complete" — the minimal organization identity for the dashboard.
// Similar to recruiter profile logic: convention over explicit flag.
const isOrganizationProfileComplete = (organization, user, organizationLogo) => {
  return Boolean(
    organization &&
      organization.website &&
      organization.website.trim() &&
      organization.businessEmail &&
      organization.businessEmail.trim() &&
      organization.name &&
      organization.name.trim() &&
      organizationLogo &&
      hasRequiredText(user?.fullName) &&
      hasRequiredText(user?.email) &&
      hasRequiredText(user?.profileImage) &&
      hasRequiredText(user?.phone) &&
      hasRequiredText(user?.city) &&
      hasRequiredText(user?.country)
  );
};

// Login must never block on PENDING_PROFILE/PENDING_SUBSCRIPTION (only email
// verification and account lifecycle SUSPENDED/INACTIVE gate login itself).
// Instead, post-login routing is derived here from real subscription state
// and (for recruiters) real profile state — never from a client-supplied
// value or from user.status. In particular, user.status === "ACTIVE" must
// NOT short-circuit straight to DASHBOARD: an organization recruiter whose
// membership has been REMOVED (or whose organization's subscription lapsed)
// still has status ACTIVE on their User row — only subscriptionAccess
// (derived from the live OrganizationMembership/Subscription state) may
// grant DASHBOARD.
const normalizeProfileValue = (value) =>
  typeof value === "string" ? value.trim() : value ?? "";

const hasRequiredText = (value) => {
  const text = normalizeProfileValue(value);
  return typeof text === "string" ? text.length > 0 : Boolean(text);
};

const getUserAccountFieldUpdate = (user, rawInput = {}) => {
  const update = {};
  const raw = rawInput && typeof rawInput === "object" ? rawInput : {};
  const directInput = {
    ...raw,
    ...(raw.personalInformation ?? {}),
  };

  for (const field of ["fullName", "email", "phone", "profileImage", "city", "country"]) {
    if (!Object.prototype.hasOwnProperty.call(directInput, field)) {
      continue;
    }

    const incomingValue = directInput[field];
    const normalizedValue = typeof incomingValue === "string"
      ? incomingValue.trim() || null
      : incomingValue ?? null;

    if (normalizedValue === null || normalizedValue === undefined || normalizedValue === "") {
      continue;
    }

    const currentValue = user?.[field];
    const currentText = typeof currentValue === "string" ? currentValue.trim() : currentValue ?? "";

    if (currentText) {
      continue;
    }

    update[field] = normalizedValue;
  }

  return update;
};

const hasValidSkillRecord = (skill) => {
  if (!skill || typeof skill !== "object") {
    return false;
  }

  const name = normalizeProfileValue(skill.name);
  const proficiency = normalizeProfileValue(skill.proficiency);
  const yearsOfExperience = Number(skill.yearsOfExperience);

  return (
    hasRequiredText(name) &&
    hasRequiredText(proficiency) &&
    Number.isInteger(yearsOfExperience) &&
    yearsOfExperience >= 0 &&
    yearsOfExperience <= 80
  );
};

const hasSkillVerificationData = (profile) => {
  if (!profile || typeof profile !== "object") {
    return false;
  }

  const projectSkills = ((profile.projects ?? []) || []).flatMap((project) => project.projectSkills ?? []);
  const hasProjectSkillEvidence = projectSkills.some((projectSkill) => {
    const name = normalizeProfileValue(projectSkill.customSkillName ?? projectSkill.skill?.name ?? "");
    const proficiency = normalizeProfileValue(projectSkill.proficiency);
    const yearsOfExperience = Number(projectSkill.yearsOfExperience);

    return (
      Boolean(name || projectSkill.skillId) &&
      hasRequiredText(proficiency) &&
      (Number.isInteger(yearsOfExperience) || projectSkill.yearsOfExperience == null)
    );
  });

  const hasCertificateEvidence = (profile.certificates ?? []).some(
    (certificate) => Boolean(certificate.skillId) || hasRequiredText(certificate.name)
  );

  const hasDirectSkillEvidence = (profile.skills ?? []).some((skill) => hasValidSkillRecord(skill));

  return hasDirectSkillEvidence || hasProjectSkillEvidence || hasCertificateEvidence;
};

const evaluateEmployeeProfileCompletion = ({ user, profile, profileData = {} }) => {
  const missingFields = [];

  const requiredProfileData = profileData && typeof profileData === "object" ? profileData : {};
  const userProfileImage = normalizeProfileValue(user?.profileImage);
  const userPhone = normalizeProfileValue(user?.phone);
  const userCity = normalizeProfileValue(user?.city);
  const userCountry = normalizeProfileValue(user?.country);
  const headline = normalizeProfileValue(profile?.headline ?? requiredProfileData?.generalInformation?.headline);
  const bio = normalizeProfileValue(profile?.bio ?? requiredProfileData?.professionalDescription?.bio);
  const careerInformation = requiredProfileData?.careerInformation ?? {};
  const ageValue = requiredProfileData?.personalInformation?.age ?? profileData?.personalInformation?.age;
  const ageNumber = Number(ageValue);
  const hasCareerInformation =
    typeof careerInformation === "object" &&
    Object.values(careerInformation).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object" && value !== null) return Object.values(value).some(Boolean);
      return hasRequiredText(value);
    });

  if (!hasRequiredText(user?.fullName)) missingFields.push("fullName");
  if (!userProfileImage) missingFields.push("profileImage");
  if (!Number.isInteger(ageNumber) || ageNumber < 18 || ageNumber > 100) missingFields.push("age");
  if (!userPhone) missingFields.push("phone");
  if (!userCity) missingFields.push("city");
  if (!userCountry) missingFields.push("country");
  if (!headline) missingFields.push("headline");
  if (!bio) missingFields.push("bio");
  if (!hasCareerInformation) missingFields.push("careerInformation");
  if (!profile?.availability && !requiredProfileData?.generalInformation?.availability) {
    missingFields.push("availability");
  }

  const educationCount = Array.isArray(profile?.education) ? profile.education.length : 0;
  if (educationCount === 0) missingFields.push("education");

  const validSkills = Array.isArray(profile?.skills) ? profile.skills.filter(hasValidSkillRecord) : [];
  if (validSkills.length === 0) missingFields.push("skills");

  const validProjects = (Array.isArray(profile?.projects) ? profile.projects : []).filter((project) => {
    const name = normalizeProfileValue(project?.name);
    const description = normalizeProfileValue(project?.description);
    return hasRequiredText(name) && hasRequiredText(description);
  });
  if (validProjects.length === 0) missingFields.push("projects");

  if (!hasSkillVerificationData(profile ?? { skills: [], projects: [], certificates: [] })) {
    missingFields.push("skillVerification");
  }

  const deduped = [...new Set(missingFields)];

  return {
    isComplete: deduped.length === 0,
    missingFields: deduped,
  };
};

const EMPLOYEE_PROFILE_COMPLETION_FIELD_COUNT = 14;

const toDashboardFile = (file) => ({
  id: file.id,
  category: file.category,
  originalName: file.originalName,
  mimeType: file.mimeType,
  fileSize: file.fileSize,
  createdAt: file.createdAt,
  skillId: file.skillId,
  certificateId: file.certificateId,
  projectId: file.projectId,
});

const toDashboardProjectSkill = (projectSkill) => ({
  id: projectSkill.id,
  skillId: projectSkill.skillId,
  customSkillName: projectSkill.customSkillName,
  proficiency: projectSkill.proficiency,
  yearsOfExperience: projectSkill.yearsOfExperience,
});

const toDashboardProject = (project) => ({
  id: project.id,
  name: project.name,
  description: project.description,
  role: project.role,
  link: project.link,
  startDate: project.startDate,
  endDate: project.endDate,
  isOngoing: project.isOngoing,
  skills: project.projectSkills.map(toDashboardProjectSkill),
  files: project.storedFiles.map(toDashboardFile),
});

const normalizeDesiredRoles = (value) => {
  const values = Array.isArray(value) ? value : [value];
  const roles = values
    .filter((role) => typeof role === "string")
    .map((role) => role.trim())
    .filter(Boolean);

  return roles.length > 0 ? roles : null;
};

const getEmployeeDashboard = async (userId) => {
  const user = await findUserById(userId);
  const profile = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const profileData = profile?.profileData && typeof profile.profileData === "object" ? profile.profileData : {};
  const completion = evaluateEmployeeProfileCompletion({ user, profile, profileData });
  const projects = (profile.projects ?? []).map(toDashboardProject);
  const desiredRoles = normalizeDesiredRoles(profileData?.jobPreferences?.preferredRole);
  const certificatesBySkillId = new Map();

  for (const certificate of profile.certificates ?? []) {
    if (!certificate.skillId) continue;
    const files = (certificate.files ?? []).map((file) => ({
      ...toDashboardFile(file),
      certificateId: certificate.id,
      certificateName: certificate.name,
    }));
    certificatesBySkillId.set(certificate.skillId, [
      ...(certificatesBySkillId.get(certificate.skillId) ?? []),
      ...files,
    ]);
  }

  const skills = (profile.skills ?? []).map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    proficiency: skill.proficiency,
    yearsOfExperience: skill.yearsOfExperience,
    projects: projects
      .filter((project) => project.skills.some((projectSkill) => projectSkill.skillId === skill.id))
      .map(({ skills: _skills, files: _files, ...project }) => project),
    evidenceFiles: [
      ...(skill.files ?? [])
        .filter((file) => file.category === "SKILL_EVIDENCE" && file.skillId === skill.id)
        .map(toDashboardFile),
      ...(certificatesBySkillId.get(skill.id) ?? []),
    ].filter((file, index, files) => files.findIndex(({ id }) => id === file.id) === index),
  }));

  const data = {
    userId: user.id,
    role: "EMPLOYEE",
    fullName: user.fullName,
    email: user.email,
    profileImage: user.profileImage,
    headline: profile.headline,
    bio: profile.bio,
    availability: profile.availability,
    careerInformation: profileData?.careerInformation?.details ?? null,
    completion: {
      percentage: Math.round(((EMPLOYEE_PROFILE_COMPLETION_FIELD_COUNT - completion.missingFields.length) / EMPLOYEE_PROFILE_COMPLETION_FIELD_COUNT) * 100),
      isComplete: completion.isComplete,
      missingFields: completion.missingFields,
    },
    skills,
    projects,
  };

  if (desiredRoles) {
    data.desiredRoles = desiredRoles;
  }

  return data;
};

const isCandidateProfileComplete = (profileData = {}, relationalSkillCount = 0) => {
  const skillCount =
    relationalSkillCount ||
    (Array.isArray(profileData?.skills) ? profileData.skills.length : 0);

  const required = [
    profileData?.generalInformation?.headline,
    profileData?.generalInformation?.location,
    profileData?.personalInformation?.phone,
    profileData?.professionalDescription?.bio,
    profileData?.jobPreferences?.preferredRole,
    skillCount,
    profileData?.experienceLevel,
  ];

  return required.every((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "number") return value > 0;
    return Boolean(value && String(value).trim());
  });
};

const getEmployeeProfileCompletionStatus = async (userId) => {
  const user = await findUserById(userId);
  const profile = (await getEmployeeProfileWithRelations(userId)) ?? (await ensureEmployeeProfile(userId));
  const profileData = profile?.profileData && typeof profile.profileData === "object" ? profile.profileData : {};
  const evaluation = evaluateEmployeeProfileCompletion({ user, profile, profileData });

  return {
    userId,
    isComplete: evaluation.isComplete,
    missingFields: evaluation.missingFields,
    completedAt: profile?.profileCompletedAt ?? null,
    profileData,
  };
};

const determineOnboardingNextStep = (
  subscriptionAccess,
  hasCompletedRecruiterProfile
) => {
  if (subscriptionAccess.scope === "bypass") {
    return "DASHBOARD";
  }

  if (subscriptionAccess.scope === "user") {
    if (!subscriptionAccess.allowed) {
      return "PAYMENT";
    }

    return hasCompletedRecruiterProfile ? "DASHBOARD" : "PROFILE_SETUP";
  }

  if (subscriptionAccess.scope === "organization") {
    if (!subscriptionAccess.allowed) return "PAYMENT";
    return hasCompletedRecruiterProfile ? "DASHBOARD" : "PROFILE_SETUP";
  }

  return "PROFILE_SETUP";
};

// Shared by loginUser and getMyOnboardingState (the /me endpoint) so both
// return the exact same, freshly-computed onboarding state — never a value
// trusted from the client, always re-derived from live DB state.
const getOnboardingState = async (userId, role, mustChangePassword) => {
  if (role === "EMPLOYEE") {
    const employeeCompletion = await getEmployeeProfileCompletionStatus(userId);

    return {
      hasActiveSubscription: true,
      nextStep: mustChangePassword
        ? "PASSWORD_CHANGE_REQUIRED"
        : employeeCompletion.isComplete
          ? "EMPLOYEE_DASHBOARD"
          : "EMPLOYEE_PROFILE_SETUP",
    };
  }

  const subscriptionAccess = await resolveSubscriptionAccess({
    id: userId,
    role,
  });

  // A forced temporary-password state overrides nextStep for every other
  // role too — but hasActiveSubscription still reflects real subscription/
  // membership state (e.g. false for a REMOVED recruiter), never a blanket
  // true. This is a routing hint only (resolveOnboardingPath on the
  // frontend); it does not by itself block any backend endpoint — actual
  // access is always re-checked live by checkSubscription.
  if (mustChangePassword) {
    return {
      hasActiveSubscription: subscriptionAccess.allowed,
      nextStep: "PASSWORD_CHANGE_REQUIRED",
    };
  }

  let hasCompletedRecruiterProfile = false;

  if (role === "RECRUITER" && subscriptionAccess.allowed) {
    const recruiterProfile = await findRecruiterProfileByUserId(userId)
      ?? await upsertRecruiterProfile({ userId, data: {} });
    const user = await findUserById(userId);
    hasCompletedRecruiterProfile = isRecruiterProfileComplete(
      recruiterProfile,
      subscriptionAccess.scope === "organization",
      user
    );
  }

  // For ORG_ADMIN, use the same onboarding logic but check organization
  // profile completion instead of recruiter profile.
  if (role === "ORG_ADMIN" && subscriptionAccess.allowed) {
    const organization = await findOrganizationById(subscriptionAccess.organizationId);
    const user = await findUserById(userId);
    const organizationLogo = await findOrganizationLogoByOwnerId(subscriptionAccess.organizationId);
    hasCompletedRecruiterProfile = isOrganizationProfileComplete(
      organization,
      user,
      organizationLogo
    );
  }

  return {
    hasActiveSubscription: subscriptionAccess.allowed,
    nextStep: determineOnboardingNextStep(
      subscriptionAccess,
      hasCompletedRecruiterProfile
    ),
  };
};

// For GET /api/auth/me — lets the frontend re-fetch current onboarding
// state (e.g. right after a payment) without re-authenticating with a
// password. req.user only carries {id, role} (see authenticate.js), so
// status is re-fetched here.
const getMyOnboardingState = async (userId, requestedRole) => {
  const user = await findUserById(userId);

  if (!user) {
    throw new Error("User not found");
  }

  // Authoritative role consistency: req.user.role is the sticky JWT role,
  // which can outlive the subscription/membership that made it usable (login
  // deliberately resolves the default role from PROFILE accounts so a
  // Recruiter-only account with a lapsed subscription still keeps RECRUITER
  // for PAYMENT onboarding). /me must ship a role that agrees with the
  // usable accounts/onboarding in the SAME payload, so resolve against
  // USABLE accounts with the existing role-selection logic. When no usable
  // account exists at all there is nothing to demote to — the requested
  // (JWT) role is kept so PAYMENT onboarding is still computed and the
  // subscription page remains the correct destination.
  const usableAccounts = getAvailableAccounts(user);
  const usableRoles = usableAccounts.map(({ role: accountRole }) => accountRole);
  let role = requestedRole;
  if (usableRoles.length > 0 && !usableRoles.includes(requestedRole)) {
    role = selectDefaultRole(usableRoles, user) ?? usableRoles[0];
  }

  const onboarding = await getOnboardingState(userId, role, user.mustChangePassword);

  return {
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    profileImage: user.profileImage,
    city: user.city,
    country: user.country,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    // Backend-resolved, mutually consistent with accounts/roles/onboarding
    // below — the controller spreads this over req.user so the frontend
    // never receives a role the usable accounts do not contain.
    role,
    onboarding,
    accounts: usableAccounts,
    roles: usableRoles,
    // Accounts that could still be ACTIVATED, as opposed to `accounts`/`roles`
    // above which only list accounts that already exist and are usable. The
    // Switch Account UI needs both so it can tell "Candidate already exists"
    // (a normal role switch) apart from "Candidate can be activated" (the
    // existing POST /auth/become-candidate flow). The backend policy stays the
    // single source of truth — the frontend never derives this itself.
    activationRoles: getActivationRoles(user),
  };
};

const updateAccountDetails = async ({ userId, data = {} }) => {
  const user = await findUserById(userId);

  if (!user || user.isDeleted || ["SUSPENDED", "INACTIVE"].includes(user.status)) {
    throw new Error("Your account is not active");
  }

  const allowedFields = ["fullName", "profileImage", "phone", "city", "country"];
  const nextData = {};

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      continue;
    }

    const value = data[field];

    if (field === "profileImage" && (value === "" || value === null)) {
      nextData[field] = null;
      continue;
    }

    const normalized =
      typeof value === "string"
        ? value.trim() || null
        : value ?? null;

    if (normalized !== null && normalized !== undefined && normalized !== "") {
      nextData[field] = normalized;
    }
  }

  if (Object.keys(nextData).length === 0) {
    return { user: { ...user, role: user.roles?.[0]?.role?.name ?? null } };
  }

  const updatedUser = await updateAccountProfile(userId, nextData);
  return { user: updatedUser };
};

// ========================================
// PENDING ROLE GRANT (Phase A — existing-email registration ownership proof)
// ========================================

// Registering an additional role for an EXISTING email must never mutate the
// account directly: anyone can POST /auth/register with someone else's email.
// Instead the request is carried by a short-lived, signed, purpose-scoped
// token (the same pattern subscription checkout tokens use) and emailed to
// that address. The role is only added when the emailed link is claimed —
// i.e. by whoever controls the mailbox. Until then nothing is created: no
// UserRole, no EmployeeProfile/RecruiterProfile, no Organization, no
// OrganizationMembership. Legacy email-verification tokens are opaque
// 64-character hex hashes, so `token.includes(".")` cleanly separates the
// two token kinds on GET /auth/verify-email.
const PENDING_ROLE_GRANT_PURPOSE = "pending_role_grant";
const PENDING_ROLE_GRANT_TTL = "24h";
const PENDING_ROLE_GRANT_ROLES = ["EMPLOYEE", "RECRUITER", "ORG_ADMIN"];
const PENDING_ROLE_GRANT_LABELS = {
  EMPLOYEE: "Candidate",
  RECRUITER: "Recruiter",
  ORG_ADMIN: "Organization Admin",
};

const issuePendingRoleGrantToken = ({ userId, role, organizationName }) =>
  jwt.sign(
    {
      purpose: PENDING_ROLE_GRANT_PURPOSE,
      userId,
      role,
      organizationName: organizationName ?? null,
    },
    process.env.JWT_SECRET,
    { expiresIn: PENDING_ROLE_GRANT_TTL }
  );

const claimPendingRoleGrant = async (token) => {
  let payload;

  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    throw new Error("This confirmation link is invalid or has expired.");
  }

  if (
    payload?.purpose !== PENDING_ROLE_GRANT_PURPOSE ||
    !payload.userId ||
    !PENDING_ROLE_GRANT_ROLES.includes(payload.role)
  ) {
    throw new Error("This confirmation link is invalid or has expired.");
  }

  if (payload.role === "ORG_ADMIN" && !payload.organizationName?.trim()) {
    throw new Error("This confirmation link is invalid or has expired.");
  }

  const user = await findUserById(payload.userId);

  if (!user || user.isDeleted) {
    throw new Error("This confirmation link is no longer valid.");
  }

  if (["SUSPENDED", "INACTIVE"].includes(user.status)) {
    throw new Error("Your account is not active");
  }

  assertProtectedSuperAdminCanReceiveRole(user, payload.role);

  // The authoritative combination / membership-only / lifecycle checks run
  // inside addRoleToExistingUser's transaction against fresh, row-locked
  // state — a grant emailed under old account state is still rejected if the
  // account changed between the email and the click.
  await addRoleToExistingUser({
    userId: user.id,
    roleName: payload.role,
    organizationName: payload.organizationName?.trim(),
  });

  return {
    email: user.email,
    role: payload.role,
  };
};

// ========================================
// REGISTER USER
// ========================================

const registerUser = async ({
  fullName,
  email,
  password,
  role,
  organizationName,
}) => {
  // Normalize user input
  const normalizedEmail = email.trim().toLowerCase();
  assertProtectedSuperAdminCanReceiveRole({ email: normalizedEmail }, role);

  // A single User may own several role profiles, but each role is assigned once.
  const existingUser = await findUserByEmail(normalizedEmail);
  const existingRoles = existingUser ? getUserRoles(existingUser) : [];
  const requiredRoles = getRequiredRegistrationRoleNames(role);
  const missingRequiredRoles = requiredRoles.filter((requiredRole) => !existingRoles.includes(requiredRole));
  const hasAnyRequestedRole = requiredRoles.some((requiredRole) => existingRoles.includes(requiredRole));

  if (hasAnyRequestedRole && missingRequiredRoles.length === 0) {
    throw new Error("An account with this email and role already exists");
  }

  if (existingUser && !isAllowedRoleCombination([...existingRoles, ...missingRequiredRoles])) {
    throw new Error(`This role combination is not allowed: ${[...existingRoles, ...missingRequiredRoles].sort().join(" + ")}`);
  }

  // Never allow SUPER_ADMIN from public registration
  if (role === "SUPER_ADMIN") {
    throw new Error("SUPER_ADMIN cannot be created through registration");
  }

  // Organization name required for organization admins
  if (role === "ORG_ADMIN" && !organizationName?.trim()) {
    throw new Error("Organization name is required for ORG_ADMIN");
  }

  // Find requested role
  const roleRecord = await findRoleByName(role);

  if (!roleRecord) {
    throw new Error("Requested role does not exist");
  }

  if (existingUser) {
    // Phase A (V1): an existing-email registration NEVER mutates the account.
    // The requested role is only added after the person controlling this
    // email address confirms it through the emailed ownership-proof link.
    // Until that confirmation no UserRole, no EmployeeProfile/RecruiterProfile,
    // no Organization and no OrganizationMembership is created.
    if (
      existingUser.isDeleted ||
      ["SUSPENDED", "INACTIVE"].includes(existingUser.status)
    ) {
      // Deliberately indistinguishable from the "already exists" rejection so
      // the response never reveals another account's lifecycle state.
      throw new Error("An account with this email and role already exists");
    }

    // Phase A (V6) mirror of the in-transaction guard: an ACTIVE organization
    // recruiter must stay membership-only, so a personal RECRUITER
    // registration for their email is rejected up front and no confirmation
    // email is sent for an impossible request. The authoritative check runs
    // again inside addRoleToExistingUser's transaction.
    if (
      role === "RECRUITER" &&
      (existingUser.organizationMemberships ?? []).some(
        (membership) =>
          membership.role === "RECRUITER" && membership.status === "ACTIVE"
      )
    ) {
      throw new Error(
        "Organization recruiters cannot be assigned an additional global recruiter role"
      );
    }

    const pendingRoleGrantToken = issuePendingRoleGrantToken({
      userId: existingUser.id,
      role,
      organizationName: organizationName?.trim(),
    });

    await sendVerificationEmail({
      email: normalizedEmail,
      fullName: existingUser.fullName,
      token: pendingRoleGrantToken,
      subject: "Confirm your new account",
      heading: `Confirm your new ${PENDING_ROLE_GRANT_LABELS[role]} account`,
      introText:
        "A request was made to add this account to the profile registered with this email address. Confirm below to activate it. This request was not made by signing in — if you did not make it, nothing has been changed and you can safely ignore this email.",
      buttonLabel: "Confirm New Account",
      expiryText: "This confirmation link expires in 24 hours.",
      footnote:
        "Your existing accounts and password remain unchanged until you confirm.",
    });

    // Deliberately minimal: no userId or fullName of the existing account is
    // echoed back to an unauthenticated caller.
    return {
      email: normalizedEmail,
      role,
    };
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  // Generate secure verification token
  const verificationToken = crypto.randomBytes(32).toString("hex");

  // Store only the hash in database
  const verificationTokenHash = crypto
    .createHash("sha256")
    .update(verificationToken)
    .digest("hex");

  // Token expires after 24 hours
  const verificationExpiresAt = new Date(
    Date.now() + 24 * 60 * 60 * 1000
  );

  // Create user
  const user = await createUser({
    fullName: fullName.trim(),
    email: normalizedEmail,
    passwordHash,
    roleId: roleRecord.id,
    roleName: role,
    organizationName: organizationName?.trim(),
    verificationTokenHash,
    verificationExpiresAt,
  });

  // Send verification email
  await sendVerificationEmail({
    email: user.email,
    fullName: user.fullName,
    token: verificationToken,
  });

  // Never return verification token
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role,
  };
};

const becomeCandidate = async (userId) => {
  const employeeRole = await findRoleByName("EMPLOYEE");

  if (!employeeRole) {
    throw new Error("EMPLOYEE role is not configured");
  }

  const user = await ensureEmployeeAccount(userId, employeeRole.id);

  if (!user) {
    throw new Error("User not found");
  }

  return user;
};

// ========================================
// VERIFY EMAIL
// ========================================

const verifyEmail = async (token) => {
  if (!token) {
    throw new Error("Verification token is required");
  }

  // Phase A (V1): pending role-grant tokens are signed JWTs (they contain
  // dots); legacy email-verification tokens are opaque 64-character hashes.
  // Both share the same frontend /verify-email page and this endpoint — only
  // the backend resolution differs.
  if (token.includes(".")) {
    return claimPendingRoleGrant(token);
  }

  // Hash token received from email
  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  // Find token
  const verificationToken = await findVerificationToken(tokenHash);

  if (!verificationToken) {
    throw new Error("Invalid or expired verification token");
  }

  // Check expiration
  if (verificationToken.expiresAt < new Date()) {
    throw new Error("Verification token has expired");
  }

  // Check if already verified
  if (verificationToken.user.emailVerified) {
    throw new Error("Email is already verified");
  }

  // Verify user and invalidate token
  const user = await verifyUserEmail(
    verificationToken.user.id,
    verificationToken.id
  );

  return {
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    status: user.status,
  };
};


const loginUser = async ({
  email,
  password,
  requestedRole,
  ipAddress,
  userAgent,
}) => {
  const normalizedEmail = email.trim().toLowerCase();

  const users = await findUsersByEmail(normalizedEmail);

  // Do not reveal whether the email exists.
  if (users.length === 0) {
    throw new Error("Invalid email or password");
  }

  for (const candidate of users) {
    if (!hasValidRoleConfiguration(candidate)) {
      throw new Error("Your account has an invalid role configuration");
    }
  }

  const matchingUsers = [];
  for (const candidate of users) {
    if (
      candidate.passwordHash &&
      (await comparePassword(password, candidate.passwordHash))
    ) {
      matchingUsers.push(candidate);
    }
  }

  const user = matchingUsers.find((candidate) => {
    const accounts = getProfileAccounts(candidate);
    return !requestedRole || accounts.some(({ role }) => role === requestedRole);
  });

  if (!user) {
    throw new Error("Invalid email or password");
  }

  // Check whether account is temporarily locked.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new Error(
      "Too many failed login attempts. Please try again later."
    );
  }

  // Account must have verified email.
  if (!user.emailVerified) {
    throw new Error("Please verify your email before logging in");
  }

  // Check account lifecycle.
  if (
    user.status === "SUSPENDED" ||
    user.status === "INACTIVE"
  ) {
    throw new Error("Your account is not active");
  }

  // Local authentication requires a password.
  if (!user.passwordHash) {
    throw new Error("This account does not use password authentication");
  }

  const passwordValid = await comparePassword(
  password,
  user.passwordHash
);

if (!passwordValid) {
  const newAttempts = user.loginAttempts + 1;

  const MAX_LOGIN_ATTEMPTS = 5;
  const LOCK_DURATION_MS = 15 * 60 * 1000;

  if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
    await updateLoginSecurity(user.id, {
      loginAttempts: 0,
      lockedUntil: new Date(Date.now() + LOCK_DURATION_MS),
    });

    throw new Error(
      "Too many failed login attempts. Please try again later."
    );
  }

  await updateLoginSecurity(user.id, {
    loginAttempts: newAttempts,
  });

  throw new Error("Invalid email or password");
}

// ✅ PASSWORD IS CORRECT — PUT IT HERE
await updateLoginSecurity(user.id, {
  loginAttempts: 0,
  lockedUntil: null,
  lastLogin: new Date(),
});

// Then continue with your existing code:
const { role } = getRoleState(user, requestedRole, false);

const accessToken = generateAccessToken({
  userId: user.id,
  role,
});

// Never redirect based on user.status alone: it lands on PENDING_PROFILE
// immediately after email verification regardless of payment state, so the
// real subscription record is the source of truth for "needs payment".
const onboarding = await getOnboardingState(user.id, role, user.mustChangePassword);

  // A selector is issued only after successful credential validation. It is
  // scoped to this browser tab by sessionStorage, while the matching refresh
  // secret remains HttpOnly in the browser cookie jar.
  const sessionSelector = generateSessionSelector();
  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await createAuthenticatedSession({
    userId: user.id,
    sessionSelectorHash: hashSecret(sessionSelector),
    sessionExpiresAt: refreshExpiresAt,
    refreshTokenHash: hashSecret(refreshToken),
    refreshExpiresAt,
    ipAddress,
    userAgent,
  });

  return {
    accessToken,
    refreshToken,
    sessionSelector,
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      profileImage: user.profileImage,
      city: user.city,
      country: user.country,
      role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      onboarding,
      roles: getAvailableAccounts(user).map(({ role: accountRole }) => accountRole),
      accounts: getAvailableAccounts(user),
      activationRoles: getActivationRoles(user),
    },
  };
};


const refreshAccessToken = async ({
  sessionSelector,
  refreshToken,
  requestedRole,
}) => {
  if (!isValidSessionSelector(sessionSelector) || !refreshToken) {
    throw new Error("Invalid authentication session");
  }

  const selectorHash = hashSecret(sessionSelector);
  const storedToken = await findRefreshTokenForSession({
    tokenHash: hashSecret(refreshToken),
    sessionSelectorHash: selectorHash,
  });

  if (!storedToken) {
    throw new Error("Invalid refresh token");
  }

  const loginSession = storedToken.loginSession;
  const user = storedToken.user;

  // A presented, already-used token is a replay attempt. Revoke only its own
  // session, never every session belonging to the same user.
  if (storedToken.revoked || storedToken.usedAt) {
    await revokeLoginSession(loginSession.id);
    throw new Error("Refresh token reuse detected");
  }

  if (
    loginSession.revokedAt ||
    loginSession.expiresAt < new Date() ||
    storedToken.expiresAt < new Date()
  ) {
    await revokeLoginSession(loginSession.id);
    throw new Error("Refresh token has expired");
  }

  if (
    user.isDeleted ||
    user.status === "SUSPENDED" ||
    user.status === "INACTIVE"
  ) {
    await revokeLoginSession(loginSession.id);
    throw new Error("Your account is not active");
  }

  let role;
  try {
    // Preferred: resolve the presented X-Active-Role hint against USABLE
    // accounts, so the refreshed session's role (and the access token minted
    // from it) never disagrees with the accounts/roles/onboarding shipped in
    // the same response. login deliberately grants the default role from
    // PROFILE accounts (so PAYMENT onboarding keeps e.g. RECRUITER), which is
    // exactly when the hint can be a role getAvailableAccounts no longer
    // contains.
    ({ role } = getRoleState(user, requestedRole, true));
  } catch {
    try {
      // Hint is stale/no-longer-usable but usable accounts exist: fall back
      // to the existing default role-selection logic over usable accounts.
      ({ role } = getRoleState(user, null, true));
    } catch {
      // Treat X-Active-Role as a hint only. A stale or mismatched browser role
      // should not revoke a still-valid login session; instead, resolve the
      // user's current valid account context and continue the refresh.
      // Last resort (no usable account at all — a legitimate PAYMENT
      // onboarding state): keep the previous PROFILE-based resolution so
      // PAYMENT onboarding is still computed for the requested role.
      const fallback = getRoleState(user, requestedRole ?? null, false);
      role = fallback.role;
    }
  }

  const nextRefreshToken = generateRefreshToken();
  const replacement = await rotateRefreshToken({
    refreshTokenId: storedToken.id,
    loginSessionId: loginSession.id,
    userId: user.id,
    tokenHash: hashSecret(nextRefreshToken),
    expiresAt: loginSession.expiresAt,
  });

  if (!replacement) {
    await revokeLoginSession(loginSession.id);
    throw new Error("Refresh token reuse detected");
  }

  const onboarding = await getOnboardingState(user.id, role, user.mustChangePassword);

  return {
    accessToken: generateAccessToken({ userId: user.id, role }),
    refreshToken: nextRefreshToken,
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      profileImage: user.profileImage,
      city: user.city,
      country: user.country,
      role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      onboarding,
      roles: getAvailableAccounts(user).map(({ role: accountRole }) => accountRole),
      accounts: getAvailableAccounts(user),
      activationRoles: getActivationRoles(user),
    },
  };
};

const saveCandidateProfile = async ({ userId, profileData }) => {
  const user = await findUserById(userId);

  if (!user || user.isDeleted || ["SUSPENDED", "INACTIVE"].includes(user.status)) {
    throw new Error("Your account is not active");
  }

  if (!user.roles?.some(({ role }) => role?.name === "EMPLOYEE")) {
    throw new Error("Only Candidate accounts can complete a candidate profile");
  }

  const normalizedProfile = profileData && typeof profileData === "object" ? profileData : {};
  const accountFieldUpdate = getUserAccountFieldUpdate(user, normalizedProfile);
  if (Object.keys(accountFieldUpdate).length > 0) {
    await updateEmployeeUserProfile(userId, accountFieldUpdate);
  }

  const currentProfile = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const currentUser = await findUserById(userId);
  const completion = evaluateEmployeeProfileCompletion({ user: currentUser, profile: currentProfile, profileData: normalizedProfile });
  const employeeProfile = await saveEmployeeProfile({
    userId,
    profileData: normalizedProfile,
    completionStatus: completion.isComplete,
  });

  const isComplete = completion.isComplete;

  return {
    profile: {
      ...employeeProfile,
      profileData: normalizedProfile,
      isComplete,
      profileCompletedAt: employeeProfile.profileCompletedAt,
    },
    onboarding: {
      hasActiveSubscription: true,
      nextStep: isComplete ? "EMPLOYEE_DASHBOARD" : "EMPLOYEE_PROFILE_SETUP",
    },
  };
};

const getCandidateProfile = async (userId) => {
  const employeeProfile = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const user = await findUserById(userId);
  const isComplete = evaluateEmployeeProfileCompletion({
    user,
    profile: employeeProfile,
    profileData: employeeProfile?.profileData ?? {},
  }).isComplete;

  return {
    profile: employeeProfile ?? null,
    isComplete,
  };
};

const normalizeCareerLink = (value) => typeof value === "string" ? value.trim() : "";

const validateCareerUrl = (value, provider) => {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    const error = new Error(`${provider} URL must be valid`);
    error.status = 400;
    throw error;
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const expectedHost = provider === "GitHub" ? "github.com" : "linkedin.com";
  if (url.protocol !== "https:" || hostname !== expectedHost) {
    const error = new Error(`${provider} URL must point to ${expectedHost}`);
    error.status = 400;
    throw error;
  }

  return url.toString();
};

const getCandidateCareerLinks = async (userId) => {
  const profile = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const profileData = profile.profileData && typeof profile.profileData === "object" ? profile.profileData : {};
  const storedLinks = profileData.careerLinks && typeof profileData.careerLinks === "object" ? profileData.careerLinks : {};
  let resume = null;
  let resumeFileId = typeof storedLinks.resumeFileId === "string" ? storedLinks.resumeFileId : "";

  if (resumeFileId) {
    try {
      const file = await findOwnedFile({ userId, role: "EMPLOYEE", id: resumeFileId });
      if (file.category === "OTHER" && file.employeeProfileId === profile.id) {
        resume = toDashboardFile(file);
      } else {
        resumeFileId = "";
      }
    } catch (error) {
      if (error.status === 404) resumeFileId = "";
      else throw error;
    }
  }

  if (resumeFileId !== storedLinks.resumeFileId) {
    const nextProfileData = {
      ...profileData,
      careerLinks: { ...storedLinks, resumeFileId: "" },
    };
    await updateEmployeeProfileData(userId, { profileData: nextProfileData });
  }

  return {
    careerLinks: {
      githubUrl: normalizeCareerLink(storedLinks.githubUrl),
      linkedInUrl: normalizeCareerLink(storedLinks.linkedInUrl),
      resumeFileId,
    },
    resume,
  };
};

const saveCandidateCareerLinks = async ({ userId, data = {} }) => {
  const profile = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const profileData = profile.profileData && typeof profile.profileData === "object" ? profile.profileData : {};
  const currentLinks = profileData.careerLinks && typeof profileData.careerLinks === "object" ? profileData.careerLinks : {};
  const nextLinks = {
    ...currentLinks,
    ...(Object.prototype.hasOwnProperty.call(data, "githubUrl")
      ? { githubUrl: validateCareerUrl(normalizeCareerLink(data.githubUrl), "GitHub") }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(data, "linkedInUrl")
      ? { linkedInUrl: validateCareerUrl(normalizeCareerLink(data.linkedInUrl), "LinkedIn") }
      : {}),
  };
  await updateEmployeeProfileData(userId, { profileData: { ...profileData, careerLinks: nextLinks } });
  return getCandidateCareerLinks(userId);
};

const linkCandidateResume = async ({ userId, fileId }) => {
  const profile = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const file = await findOwnedFile({ userId, role: "EMPLOYEE", id: fileId });
  if (file.category !== "OTHER" || file.employeeProfileId !== profile.id) {
    const error = new Error("This file cannot be used as a Candidate resume");
    error.status = 400;
    throw error;
  }

  const profileData = profile.profileData && typeof profile.profileData === "object" ? profile.profileData : {};
  const currentLinks = profileData.careerLinks && typeof profileData.careerLinks === "object" ? profileData.careerLinks : {};
  const oldFileId = typeof currentLinks.resumeFileId === "string" ? currentLinks.resumeFileId : "";
  await updateEmployeeProfileData(userId, { profileData: { ...profileData, careerLinks: { ...currentLinks, resumeFileId: file.id } } });
  if (oldFileId && oldFileId !== file.id) {
    try { await deleteOwnedFile({ userId, role: "EMPLOYEE", id: oldFileId }); } catch (error) { if (error.status !== 404) throw error; }
  }
  return getCandidateCareerLinks(userId);
};

const deleteCandidateResume = async (userId) => {
  const links = await getCandidateCareerLinks(userId);
  if (links.resumeFileId) {
    await deleteOwnedFile({ userId, role: "EMPLOYEE", id: links.resumeFileId });
  }
  const profile = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const profileData = profile.profileData && typeof profile.profileData === "object" ? profile.profileData : {};
  const currentLinks = profileData.careerLinks && typeof profileData.careerLinks === "object" ? profileData.careerLinks : {};
  await updateEmployeeProfileData(userId, { profileData: { ...profileData, careerLinks: { ...currentLinks, resumeFileId: "" } } });
  return getCandidateCareerLinks(userId);
};

const getRecruiterProfile = async (userId) => {
  const user = await findUserById(userId);
  const canAccessRecruiterProfile = user?.roles?.some(({ role }) => role?.name === "RECRUITER") ||
    user?.organizationMemberships?.some(({ role, status }) => role === "RECRUITER" && status === "ACTIVE");
  if (!user || !canAccessRecruiterProfile) {
    const error = new Error("Only recruiter accounts can access recruiter profiles");
    error.status = 403;
    throw error;
  }

  const profile = await findRecruiterProfileByUserId(userId) ?? await upsertRecruiterProfile({ userId, data: {} });
  return {
    profile: { ...profile, name: user.fullName },
    isComplete: isRecruiterProfileComplete(
      profile,
      user.organizationMemberships?.some(
        ({ role, status }) => role === "RECRUITER" && status === "ACTIVE"
      ),
      user
    ),
  };
};

const saveRecruiterProfile = async ({ userId, data = {} }) => {
  const user = await findUserById(userId);
  const isOrganizationRecruiter = user?.organizationMemberships?.some(
    ({ role, status }) => role === "RECRUITER" && status === "ACTIVE"
  );
  const canAccessRecruiterProfile = user?.roles?.some(({ role }) => role?.name === "RECRUITER") || isOrganizationRecruiter;
  if (!user || !canAccessRecruiterProfile) {
    const error = new Error("Only recruiter accounts can update recruiter profiles");
    error.status = 403;
    throw error;
  }

  const accountFieldUpdate = getUserAccountFieldUpdate(user, data);
  if (Object.keys(accountFieldUpdate).length > 0) {
    await updateEmployeeUserProfile(userId, accountFieldUpdate);
  }

  const current = await findRecruiterProfileByUserId(userId);
  const fields = [
    "jobTitle",
    "linkedInUrl",
    "bio",
    "location",
    "yearsExperience",
    "specialties",
  ];
  if (!isOrganizationRecruiter) {
    fields.unshift("companyName", "businessEmail", "businessPhone", "companyWebsite");
  }
  const normalized = {};

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      normalized[field] = typeof data[field] === "string" ? data[field].trim() || null : data[field] ?? null;
    }
  }

  const nextCompanyName = normalized.companyName ?? current?.companyName;
  const nextJobTitle = normalized.jobTitle ?? current?.jobTitle;
  const profile = await upsertRecruiterProfile({ userId, data: normalized });
  const refreshedUser = await findUserById(userId);
  return {
    profile: { ...profile, name: refreshedUser?.fullName ?? user.fullName },
    isComplete: isRecruiterProfileComplete(
      { companyName: nextCompanyName, jobTitle: nextJobTitle },
      isOrganizationRecruiter,
      refreshedUser
    ),
  };
};

const getCandidateProfileCompletionStatus = async (userId) => {
  const completion = await getEmployeeProfileCompletionStatus(userId);
  return {
    ...completion,
    missingFields: completion.missingFields,
  };
};

const saveCandidateProfileSection = async ({ userId, section, data = {} }) => {
  const current = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const profileData = current?.profileData && typeof current.profileData === "object" ? current.profileData : {};
  const nextProfileData = {
    ...profileData,
    [section]: {
      ...(profileData[section] ?? {}),
      ...data,
    },
  };

  let currentUser = await findUserById(userId);
  if (section === "personalInformation") {
    const userFields = getUserAccountFieldUpdate(currentUser, data);
    if (Object.keys(userFields).length > 0) {
      await updateEmployeeUserProfile(userId, userFields);
      currentUser = await findUserById(userId);
    }
  }
  const completion = evaluateEmployeeProfileCompletion({ user: currentUser, profile: current, profileData: nextProfileData });
  const employeeProfile = await saveEmployeeProfile({
    userId,
    profileData: nextProfileData,
    completionStatus: completion.isComplete,
  });

  return {
    profile: employeeProfile,
    isComplete: completion.isComplete,
    onboarding: {
      hasActiveSubscription: true,
      nextStep: completion.isComplete ? "EMPLOYEE_DASHBOARD" : "EMPLOYEE_PROFILE_SETUP",
    },
  };
};

const upsertCandidateEducation = async ({ userId, educationId, data }) => {
  const row = await upsertEmployeeProfileEducation({ userId, educationId, data });
  return { id: row.id, item: row };
};

const deleteCandidateEducation = async ({ userId, educationId }) => {
  await deleteEmployeeProfileEducation({ userId, educationId });
  return { deleted: true, id: educationId };
};

const upsertCandidateSkill = async ({ userId, skillId, data }) => {
  const row = await upsertEmployeeProfileSkill({ userId, skillId, data });
  return { id: row.id, item: row };
};

const deleteCandidateSkill = async ({ userId, skillId }) => {
  await deleteEmployeeProfileSkill({ userId, skillId });
  return { deleted: true, id: skillId };
};

const upsertCandidateProject = async ({ userId, projectId, data }) => {
  const row = await upsertEmployeeProfileProject({ userId, projectId, data });
  return { id: row.id, item: row };
};

const deleteCandidateProject = async ({ userId, projectId }) => {
  await deleteEmployeeProfileProject({ userId, projectId });
  return { deleted: true, id: projectId };
};

const upsertCandidateProjectSkill = async ({ userId, projectId, projectSkillId, data }) => {
  const row = await upsertEmployeeProfileProjectSkill({ userId, projectId, projectSkillId, data });
  return { id: row.id, item: row };
};

const deleteCandidateProjectSkill = async ({ userId, projectId, projectSkillId }) => {
  await deleteEmployeeProfileProjectSkill({ userId, projectId, projectSkillId });
  return { deleted: true, id: projectSkillId };
};

const upsertCandidateCertificate = async ({ userId, certificateId, data }) => {
  const row = await upsertEmployeeProfileCertificate({ userId, certificateId, data });
  return { id: row.id, item: row };
};

const deleteCandidateCertificate = async ({ userId, certificateId }) => {
  await deleteEmployeeProfileCertificate({ userId, certificateId });
  return { deleted: true, id: certificateId };
};

const setCandidateExperienceLevel = async ({ userId, experienceLevel }) => {
  const current = await getEmployeeProfileWithRelations(userId) ?? await ensureEmployeeProfile(userId);
  const profileData = current?.profileData && typeof current.profileData === "object" ? current.profileData : {};
  const nextProfileData = {
    ...profileData,
    experienceLevel,
  };

  const currentUser = await findUserById(userId);
  const completion = evaluateEmployeeProfileCompletion({ user: currentUser, profile: current, profileData: nextProfileData });
  const employeeProfile = await saveEmployeeProfile({
    userId,
    profileData: nextProfileData,
    completionStatus: completion.isComplete,
  });

  return {
    profile: employeeProfile,
    isComplete: completion.isComplete,
  };
};

const switchRole = async (userId, requestedRole) => {
  const user = await findUserById(userId);

  if (!user || user.isDeleted || ["SUSPENDED", "INACTIVE"].includes(user.status)) {
    throw new Error("Your account is not active");
  }

  validateRoleSwitchEligibility(user, requestedRole);

  const { role, roles, accounts } = getRoleState(user, requestedRole);
  const onboarding = await getOnboardingState(user.id, role, user.mustChangePassword);

  return {
    accessToken: generateAccessToken({ userId: user.id, role }),
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      profileImage: user.profileImage,
      city: user.city,
      country: user.country,
      role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      onboarding,
      roles,
      accounts,
      activationRoles: getActivationRoles(user),
    },
  };
};

// ========================================
// LOGOUT
// ========================================

// Idempotent by design: a missing cookie, an already-revoked token, an
// already-expired token, or a token that never existed all resolve the same
// way (silently do nothing) — the caller never learns which case applied.
// Only an existing, not-yet-revoked token actually gets updated.
const logoutUser = async ({ sessionSelector, refreshToken }) => {
  if (!isValidSessionSelector(sessionSelector) || !refreshToken) {
    return;
  }

  const storedToken = await findRefreshTokenForSession({
    tokenHash: hashSecret(refreshToken),
    sessionSelectorHash: hashSecret(sessionSelector),
  });

  if (storedToken?.loginSession) {
    await revokeLoginSession(storedToken.loginSession.id);
  }
};

// ========================================
// RESEND VERIFICATION EMAIL
// ========================================

const resendVerificationEmail = async (email) => {
  if (!email) {
    throw new Error("Email is required");
  }

  const normalizedEmail = email.trim().toLowerCase();

  const user = await findUserByEmail(normalizedEmail);

  // Do not reveal whether the email exists.
  if (!user) {
    throw new Error("If this email is registered, a verification link has been sent");
  }

  if (user.emailVerified) {
    throw new Error("Email is already verified");
  }

  // Invalidate any previous verification tokens.
  await deleteVerificationTokens(user.id);

  // Generate a new secure verification token.
  const verificationToken = crypto.randomBytes(32).toString("hex");

  const verificationTokenHash = crypto
    .createHash("sha256")
    .update(verificationToken)
    .digest("hex");

  const verificationExpiresAt = new Date(
    Date.now() + 24 * 60 * 60 * 1000
  );

  await createVerificationToken({
    userId: user.id,
    tokenHash: verificationTokenHash,
    expiresAt: verificationExpiresAt,
  });

  await sendVerificationEmail({
    email: user.email,
    fullName: user.fullName,
    token: verificationToken,
  });

  return {
    message: "If this email is registered, a verification link has been sent",
  };
};

// ========================================
// FORGOT PASSWORD
// ========================================

const FORGOT_PASSWORD_MESSAGE =
  "If an account with that email exists and is verified, a password reset link has been sent.";

const forgotPassword = async (email) => {
  if (!email) {
    throw new Error("Email is required");
  }

  const normalizedEmail = email.trim().toLowerCase();

  const user = await findUserByEmail(normalizedEmail);

  // Only send a reset link for existing, verified accounts — but never
  // reveal that to the caller. Any failure here is logged, not thrown,
  // so the response is identical in every case.
  if (user && user.emailVerified) {
    try {
      const resetToken = crypto.randomBytes(32).toString("hex");

      const resetTokenHash = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await deletePasswordResetTokens(user.id);

      await createPasswordResetToken({
        userId: user.id,
        tokenHash: resetTokenHash,
        expiresAt,
      });

      await sendPasswordResetEmail({
        email: user.email,
        fullName: user.fullName,
        token: resetToken,
      });
    } catch (error) {
      console.error("Forgot password error:", error);
    }
  }

  return { message: FORGOT_PASSWORD_MESSAGE };
};

// ========================================
// RESET PASSWORD
// ========================================

const validatePasswordStrength = (password) => {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (!/[A-Z]/.test(password)) {
    throw new Error("Password must contain at least one uppercase letter");
  }
  if (!/[a-z]/.test(password)) {
    throw new Error("Password must contain at least one lowercase letter");
  }
  if (!/[0-9]/.test(password)) {
    throw new Error("Password must contain at least one number");
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    throw new Error("Password must contain at least one special character");
  }
};

// Rejects a candidate password that matches any of the user's last
// PASSWORD_HISTORY_DEPTH passwords. Applied only to user-chosen password
// paths (forgot/reset password, authenticated change-password) — not to
// registration (no history yet to compare against) or to organization
// recruiter temporary passwords (server-generated random, not user-chosen;
// a reuse check there has no real security value — see
// resetRecruiterPassword in organization.repository.js, which records
// history but never calls this).
const assertPasswordNotReused = async (userId, newPassword) => {
  const history = await findRecentPasswordHistory(userId, PASSWORD_HISTORY_DEPTH);

  for (const entry of history) {
    const matches = await comparePassword(newPassword, entry.passwordHash);

    if (matches) {
      throw new Error(
        `Your new password can't match any of your last ${PASSWORD_HISTORY_DEPTH} passwords.`
      );
    }
  }
};

const resetPassword = async ({ token, password }) => {
  if (!token) {
    throw new Error("Reset token is required");
  }

  if (!password) {
    throw new Error("Password is required");
  }

  validatePasswordStrength(password);

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const resetToken = await findPasswordResetToken(tokenHash);

  if (!resetToken) {
    throw new Error("This password reset link is invalid.");
  }

  if (resetToken.used) {
    throw new Error("This password reset link has already been used.");
  }

  if (resetToken.expiresAt < new Date()) {
    throw new Error(
      "This password reset link has expired. Please request a new one."
    );
  }

  await assertPasswordNotReused(resetToken.userId, password);

  const passwordHash = await hashPassword(password);

  await updateUserPassword(resetToken.userId, passwordHash);
  await markPasswordResetTokenUsed(resetToken.id);

  return { message: "Password reset successfully." };
};

// ========================================
// CHANGE PASSWORD (authenticated)
// ========================================

// For an already-logged-in user, e.g. clearing a server-issued temporary
// password (mustChangePassword). Requires the current password — the caller
// already has a valid access token, but re-checking the password guards
// against a stolen/short-lived token being enough to lock the real owner
// out. updateUserPassword clears mustChangePassword as a side effect.
const changePassword = async ({ userId, currentPassword, newPassword }) => {
  const user = await findUserById(userId);

  if (!user) {
    throw new Error("User not found");
  }

  if (!user.passwordHash) {
    throw new Error("This account does not use password authentication");
  }

  const currentPasswordValid = await comparePassword(
    currentPassword,
    user.passwordHash
  );

  if (!currentPasswordValid) {
    throw new Error("Current password is incorrect");
  }

  validatePasswordStrength(newPassword);

  await assertPasswordNotReused(userId, newPassword);

  const passwordHash = await hashPassword(newPassword);

  await updateUserPassword(userId, passwordHash);

  return { message: "Password changed successfully." };
};

// ========================================
// EXPORTS
// ========================================

module.exports = {
  registerUser,
  becomeCandidate,
  verifyEmail,
  loginUser,
  refreshAccessToken,
  logoutUser,
  resendVerificationEmail,
  forgotPassword,
  resetPassword,
  changePassword,
  getMyOnboardingState,
  getUserRoles,
  selectDefaultRole,
  getProfileAccounts,
  getAvailableAccounts,
  getActivationRoles,
  getRoleState,
  isAllowedRoleCombination,
  getAllowedActivationRoles,
  getCandidateProfileCompletionStatus,
  getEmployeeProfileCompletionStatus,
  getEmployeeDashboard,
  getCandidateCareerLinks,
  saveCandidateCareerLinks,
  linkCandidateResume,
  deleteCandidateResume,
  isRecruiterProfileComplete,
  getCandidateProfile,
  getRecruiterProfile,
  saveRecruiterProfile,
  saveCandidateProfile,
  isCandidateProfileComplete,
  evaluateEmployeeProfileCompletion,
  saveCandidateProfileSection,
  upsertCandidateEducation,
  deleteCandidateEducation,
  upsertCandidateSkill,
  deleteCandidateSkill,
  upsertCandidateProject,
  deleteCandidateProject,
  upsertCandidateProjectSkill,
  deleteCandidateProjectSkill,
  upsertCandidateCertificate,
  deleteCandidateCertificate,
  setCandidateExperienceLevel,
  switchRole,
  validatePasswordStrength,
  getRefreshCookieName,
  updateAccountDetails,
  getUserAccountFieldUpdate,
};
