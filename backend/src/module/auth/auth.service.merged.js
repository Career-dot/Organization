const crypto = require("crypto");

const {
  findUserByEmail,
  findUsersByEmail,
  findRoleByName,
  findUserById,
  findRecruiterProfileByUserId,
  createUser,
  addRoleToExistingUser,
  findVerificationToken,
  verifyUserEmail,
  createAuthenticatedSession,
  updateLoginSecurity,
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
  resolveSubscriptionAccess,
  isSubscriptionUsable,
} = require("../subscription/subscription.service");

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

const selectDefaultRole = (roles) =>
  ROLE_PRIORITY.find((role) => roles.includes(role));

const getProfileAccounts = (user) => {
  const assignedRoles = getUserRoles(user);
  const accounts = [];

  if (assignedRoles.includes("EMPLOYEE") && user.employeeProfile) {
    accounts.push({ role: "EMPLOYEE", scope: "user" });
  }

  if (assignedRoles.includes("RECRUITER") && user.recruiterProfile) {
    accounts.push({ role: "RECRUITER", scope: "user" });
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

  if (assignedRoles.includes("EMPLOYEE") && user.employeeProfile) {
    accounts.push({ role: "EMPLOYEE", scope: "user" });
  }

  if (assignedRoles.includes("RECRUITER") && user.recruiterProfile) {
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

const getRoleState = (user, selectedRole, usableOnly = true) => {
  const accounts = usableOnly ? getAvailableAccounts(user) : getProfileAccounts(user);
  const roles = accounts.map(({ role }) => role);
  const role = selectedRole ?? selectDefaultRole(roles);

  if (!role || !roles.includes(role)) {
    throw new Error("No usable account is available");
  }

  return { role, roles, accounts };
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
// completion field, companyName + jobTitle are treated as the minimal
// required identity of a usable recruiter profile — the same two fields a
// recruiter dashboard would need to display who they are. Not a new schema
// field, just a convention over the existing columns.
const isRecruiterProfileComplete = (profile) => {
  return Boolean(
    profile &&
      profile.companyName &&
      profile.companyName.trim() &&
      profile.jobTitle &&
      profile.jobTitle.trim()
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
    // No organization-profile-completion concept exists yet (unlike
    // RecruiterProfile) — an active org subscription goes straight to
    // DASHBOARD for now.
    return subscriptionAccess.allowed ? "DASHBOARD" : "PAYMENT";
  }

  return "PROFILE_SETUP";
};

// Shared by loginUser and getMyOnboardingState (the /me endpoint) so both
// return the exact same, freshly-computed onboarding state — never a value
// trusted from the client, always re-derived from live DB state.
const getOnboardingState = async (userId, role, mustChangePassword) => {
  // EMPLOYEE has no subscription/profile gate at all — resolving
  // subscriptionAccess for it falls through resolveSubscriptionAccess's
  // final "none" branch, which determineOnboardingNextStep has no explicit
  // case for either. Short-circuit here rather than relying on that
  // fallthrough, so EMPLOYEE always and unambiguously lands on DASHBOARD
  // (or PASSWORD_CHANGE_REQUIRED, though EMPLOYEE never has that flag set
  // today — this stays correct if that ever changes).
  if (role === "EMPLOYEE") {
    return {
      hasActiveSubscription: true,
      nextStep: mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "DASHBOARD",
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
    const recruiterProfile = await findRecruiterProfileByUserId(userId);
    hasCompletedRecruiterProfile = isRecruiterProfileComplete(recruiterProfile);
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
const getMyOnboardingState = async (userId, role) => {
  const user = await findUserById(userId);

  if (!user) {
    throw new Error("User not found");
  }

  const onboarding = await getOnboardingState(userId, role, user.mustChangePassword);

  return {
    fullName: user.fullName,
    email: user.email,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    onboarding,
    accounts: getAvailableAccounts(user),
    roles: getAvailableAccounts(user).map(({ role }) => role),
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

  // A single User may own several role profiles, but each role is assigned once.
  const existingUser = await findUserByEmail(normalizedEmail);
  const hasRequestedRole = existingUser
    ? getUserRoles(existingUser).includes(role)
    : false;

  if (hasRequestedRole) {
    throw new Error("An account with this email and role already exists");
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
    await addRoleToExistingUser({
      userId: existingUser.id,
      roleId: roleRecord.id,
      roleName: role,
      organizationName: organizationName?.trim(),
    });

    return {
      userId: existingUser.id,
      email: existingUser.email,
      fullName: existingUser.fullName,
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

// ========================================
// VERIFY EMAIL
// ========================================

const verifyEmail = async (token) => {
  if (!token) {
    throw new Error("Verification token is required");
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
      role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      onboarding,
      roles: getAvailableAccounts(user).map(({ role: accountRole }) => accountRole),
      accounts: getAvailableAccounts(user),
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
    ({ role } = getRoleState(user, requestedRole, false));
  } catch (error) {
    await revokeLoginSession(loginSession.id);
    throw error;
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

  return {
    accessToken: generateAccessToken({ userId: user.id, role }),
    refreshToken: nextRefreshToken,
  };
};

const switchRole = async (userId, requestedRole) => {
  const user = await findUserById(userId);

  if (!user || user.isDeleted || ["SUSPENDED", "INACTIVE"].includes(user.status)) {
    throw new Error("Your account is not active");
  }

  const { role, roles, accounts } = getRoleState(user, requestedRole);

  return {
    accessToken: generateAccessToken({ userId: user.id, role }),
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role,
      roles,
      accounts,
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
  getRoleState,
  switchRole,
  validatePasswordStrength,
  getRefreshCookieName,
}; 
