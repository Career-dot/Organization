const jwt = require("jsonwebtoken");

const paymentGateway = require("./gateway/paymentGateway");

const {
  findLatestUserSubscription,
  findLatestOrganizationSubscription,
  findActiveOrganizationMembership,
  findOrgAdminMembership,
  findActivePlans,
  findPlanById,
  createActiveSubscription,
} = require("./subscription.repository");

const {
  findUserById,
  findRoleByName,
} = require("../auth/auth.repository");

// The single source of truth for legal role combinations — reused by
// resolveOwnerContext below so the subscription transition guard can never
// drift from the account rules.
const { isAllowedRoleCombination } = require("../auth/role-policy");

// Used only to fold Organization.status into resolveSubscriptionAccess (see
// below) — no reverse dependency exists (organization.repository.js does
// not import anything from this module), so this doesn't create a cycle.
const { findOrganizationById } = require("../organization/organization.repository");

const CHECKOUT_TOKEN_PURPOSE = "subscription_checkout";
const CHECKOUT_TOKEN_TTL = "15m";

const USABLE_STATUSES = ["ACTIVE", "TRIAL"];

// A subscription is usable only when status is ACTIVE/TRIAL and it has not
// expired. expiryDate is checked independently of status because nothing in
// this codebase transitions status to EXPIRED on a schedule.
const isSubscriptionUsable = (subscription) => {
  if (!subscription) {
    return false;
  }

  if (!USABLE_STATUSES.includes(subscription.status)) {
    return false;
  }

  if (subscription.expiryDate && subscription.expiryDate <= new Date()) {
    return false;
  }

  return true;
};

// Determines whose subscription governs this user's access, and whether it's
// usable. Organization-affiliated users (any role, via an ACTIVE membership)
// are checked against the organization's subscription, never their own.
const resolveSubscriptionAccess = async (user) => {
  if (user.role === "SUPER_ADMIN") {
    return {
      allowed: true,
      scope: "bypass",
      subscription: null,
    };
  }

  const membership = await findActiveOrganizationMembership(user.id);

  if (membership) {
    const [subscription, organization] = await Promise.all([
      findLatestOrganizationSubscription(membership.organizationId),
      findOrganizationById(membership.organizationId),
    ]);

    // A SUPER_ADMIN-suspended organization (see admin.service.js's
    // updateOrganizationStatus) must block every member's access
    // immediately, the same way an unusable subscription already does —
    // otherwise "suspend organization" would have no real effect. Checked
    // independently of subscription usability: a suspended org with an
    // otherwise-valid subscription is still not allowed.
    const allowed =
      organization?.status !== "SUSPENDED" && isSubscriptionUsable(subscription);

    return {
      allowed,
      scope: "organization",
      organizationId: membership.organizationId,
      subscription,
    };
  }

  if (user.role === "RECRUITER") {
    const subscription = await findLatestUserSubscription(user.id);

    return {
      allowed: isSubscriptionUsable(subscription),
      scope: "user",
      subscription,
    };
  }

  if (user.role === "ORG_ADMIN") {
    // No ACTIVE membership (e.g. still INVITED, or removed) means there is
    // no organization to check a subscription against — access is correctly
    // denied. scope stays "organization" (not "none") so
    // determineOnboardingNextStep resolves this to PAYMENT, never
    // PROFILE_SETUP (which ORG_ADMIN must never reach).
    return {
      allowed: false,
      scope: "organization",
      organizationId: null,
      subscription: null,
    };
  }

  return {
    allowed: false,
    scope: "none",
    subscription: null,
  };
};

// Small local helper so the controller can pick an HTTP status without this
// module needing a shared ApiError class (none exists elsewhere in the codebase).
const httpError = (status, message, extra) => {
  const error = new Error(message);
  error.status = status;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
};

const getAvailablePlans = async () => {
  return findActivePlans();
};

// Resolves who is buying and what SubscriptionType they're allowed to buy,
// entirely from the authenticated user + DB state. Never trusts client input.
const resolveOwnerContext = async (user, targetRole) => {
  const account = await findUserById(user.id);
  const roles = (account?.roles ?? []).map(({ role }) => role?.name);
  const effectiveRole = targetRole ?? user.role;

  if (targetRole && !["RECRUITER", "ORG_ADMIN"].includes(targetRole)) {
    throw httpError(400, "Invalid subscription role");
  }

  // Transition guard for the explicit targetRole purchase path. role-policy.js
  // is the single source of truth for which combinations are legal; this is its
  // subscription-level projection. Beyond the explicit direction rules, two
  // combination checks apply:
  //   * the account's CURRENT set must itself be a legal combination, which
  //     keeps role-less accounts (e.g. a membership-only organization
  //     recruiter) exactly as ineligible as before; and
  //   * the RESULTING set must be legal, using the shared helper — so an
  //     ORG_ADMIN-only account renews/activates ORG_ADMIN without needing an
  //     EMPLOYEE role that no longer exists for it.
  // SUPER_ADMIN is rejected explicitly and must stay explicit:
  // isAllowedRoleCombination (via normalizeRoleSet) deliberately drops
  // SUPER_ADMIN because it is not a NORMAL_USER_ROLE, so a combination-only
  // check would silently treat a platform admin as an ordinary account.
  if (
    targetRole &&
    (roles.includes("SUPER_ADMIN") ||
      (targetRole === "RECRUITER" && roles.includes("ORG_ADMIN")) ||
      (targetRole === "ORG_ADMIN" && roles.includes("RECRUITER")) ||
      !isAllowedRoleCombination(roles) ||
      !isAllowedRoleCombination([...roles, targetRole]))
  ) {
    throw httpError(403, "This role transition is not allowed");
  }

  if (effectiveRole === "RECRUITER") {
    // An organization recruiter's access is paid for by their organization
    // (see resolveSubscriptionAccess) — they must never be able to buy a
    // personal RECRUITER subscription on top of/instead of that.
    const membership = await findActiveOrganizationMembership(user.id);

    if (membership) {
      throw httpError(
        403,
        "Organization recruiters cannot purchase an individual subscription"
      );
    }

    return {
      ownerType: "user",
      ownerId: user.id,
      subscriptionType: "RECRUITER",
      targetRole,
    };
  }

  if (effectiveRole === "ORG_ADMIN") {
    // Deliberately not requiring an ACTIVE membership here: the ORG_ADMIN's
    // own membership only becomes ACTIVE once the organization's first
    // subscription payment succeeds (see createActiveSubscription), so
    // requiring ACTIVE here would make that first purchase impossible.
    // findOrgAdminMembership still strictly scopes to *this* user's own
    // ORG_ADMIN membership (excluding REMOVED) — an unrelated user or an
    // invited/removed recruiter can never resolve an organization this way.
    const membership = await findOrgAdminMembership(user.id);

    if (!membership && !targetRole) {
      throw httpError(403, "ORGANIZATION_MEMBERSHIP_REQUIRED");
    }

    return {
      ownerType: membership ? "organization" : "new-organization",
      ownerId: membership?.organizationId ?? user.id,
      subscriptionType: "ORGANIZATION",
      orgAdminUserId: user.id,
      targetRole,
    };
  }

  throw httpError(403, "This role is not eligible to purchase a subscription");
};

const findOwnerSubscription = async (ownerType, ownerId) => {
  if (ownerType === "user") {
    return findLatestUserSubscription(ownerId);
  }

  return findLatestOrganizationSubscription(ownerId);
};

const assertNoActiveSubscription = async (ownerType, ownerId) => {
  const existing = await findOwnerSubscription(ownerType, ownerId);

  if (isSubscriptionUsable(existing)) {
    throw httpError(409, "An active subscription already exists", {
      subscription: existing,
    });
  }
};

const loadPurchasablePlan = async (planId, subscriptionType) => {
  const plan = await findPlanById(planId);

  if (!plan || !plan.isActive) {
    throw httpError(404, "Subscription plan not found");
  }

  if (plan.type !== subscriptionType) {
    throw httpError(400, "This plan is not available for your account type");
  }

  return plan;
};

const initiateCheckout = async (user, planId, targetRole, organizationName) => {
  const { ownerType, ownerId, subscriptionType } = await resolveOwnerContext(
    user,
    targetRole
  );

  if (targetRole === "ORG_ADMIN" && !organizationName?.trim()) {
    throw httpError(400, "Organization name is required for this upgrade");
  }

  const plan = await loadPurchasablePlan(planId, subscriptionType);

  await assertNoActiveSubscription(ownerType, ownerId);

  const checkoutToken = jwt.sign(
    {
      purpose: CHECKOUT_TOKEN_PURPOSE,
      planId: plan.id,
      ownerType,
      ownerId,
      targetRole,
      organizationName: organizationName?.trim(),
    },
    process.env.JWT_SECRET,
    { expiresIn: CHECKOUT_TOKEN_TTL }
  );

  return { checkoutToken, plan, amount: plan.price };
};

const verifyCheckoutToken = (checkoutToken) => {
  let payload;

  try {
    payload = jwt.verify(checkoutToken, process.env.JWT_SECRET);
  } catch (error) {
    throw httpError(400, "Checkout session is invalid or expired");
  }

  if (payload.purpose !== CHECKOUT_TOKEN_PURPOSE) {
    throw httpError(400, "Checkout session is invalid or expired");
  }

  return payload;
};

const addOneMonth = (date) => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1);
  return result;
};

const confirmPayment = async (user, checkoutToken) => {
  const tokenPayload = verifyCheckoutToken(checkoutToken);

  const current = await resolveOwnerContext(user, tokenPayload.targetRole);

  if (
    current.ownerType !== tokenPayload.ownerType ||
    current.ownerId !== tokenPayload.ownerId ||
    current.targetRole !== tokenPayload.targetRole
  ) {
    throw httpError(400, "Checkout session is invalid or expired");
  }

  const plan = await loadPurchasablePlan(
    tokenPayload.planId,
    current.subscriptionType
  );

  await assertNoActiveSubscription(current.ownerType, current.ownerId);

  const paymentResult = await paymentGateway.charge({
    amount: plan.price,
    currency: "USD",
    metadata: {
      planId: plan.id,
      ownerType: current.ownerType,
      ownerId: current.ownerId,
    },
  });

  if (!paymentResult.success) {
    throw httpError(402, "Payment was not successful");
  }

  const startDate = new Date();
  const expiryDate = addOneMonth(startDate);
  const targetRoleRecord = tokenPayload.targetRole
    ? await findRoleByName(tokenPayload.targetRole)
    : null;

  if (tokenPayload.targetRole && !targetRoleRecord) {
    throw httpError(500, "Requested role is not configured");
  }

  const subscription = await createActiveSubscription({
    planId: plan.id,
    userId: current.ownerType === "user" ? current.ownerId : null,
    organizationId:
      current.ownerType === "organization" ? current.ownerId : null,
    // The buyer's own ORG_ADMIN membership must be activated for BOTH purchase
    // shapes: the first activation ("new-organization" — no membership/org
    // existed at checkout, so ownerType is "new-organization" and ownerId is
    // the user id, not an organization id) and a re-purchase on an existing
    // organization. Passing orgAdminUserId only for the "organization" shape
    // left the first activation's membership stuck INVITED after a successful
    // payment, so resolveSubscriptionAccess never allowed ORG_ADMIN access and
    // onboarding routing (payment → profile setup → dashboard) never advanced.
    // createActiveSubscription itself guards the flip with
    // resolvedOrganizationId && orgAdminUserId, so non-ORG_ADMIN purchases
    // (orgAdminUserId undefined → null) are unaffected.
    orgAdminUserId: current.orgAdminUserId ?? null,
    targetRole: tokenPayload.targetRole,
    targetRoleId: targetRoleRecord?.id,
    targetUserId: user.id,
    organizationName: tokenPayload.organizationName,
    startDate,
    expiryDate,
  });

  return { subscription, plan };
};

module.exports = {
  isSubscriptionUsable,
  resolveSubscriptionAccess,
  getAvailablePlans,
  initiateCheckout,
  confirmPayment,
  // Reused by admin.service.js's subscription-extend action, so "one billing
  // cycle" stays defined in exactly one place — currently 1 month, matching
  // every existing plan's billingCycle: "MONTHLY".
  addOneMonth,
};
