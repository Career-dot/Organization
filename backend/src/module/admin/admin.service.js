const {
  countOrganizationsByStatus,
  countTotalUsers,
  countUsersByRole,
  countOrganizationRecruiters,
  countIndependentRecruiters,
  countAllRecruiters,
  countSubscriptionStatistics,
  countActivePlans,
  getSubscriptionPlanDistribution,
  getPlatformGrowthTimestamps,
  listExpiringSubscriptions,
  getRecentAuditEvents,
  listOrganizationsSummary,
  findOrganizationDetailById,
  listAllRecruitersSummary,
  findRecruiterDetailById,
  createPlanWithAudit,
  updatePlanWithAudit,
  listAuditLogs,
} = require("./admin.repository");

const {
  findPlanById,
  findAllPlansForAdmin,
  findLatestOrganizationSubscription,
} = require("../subscription/subscription.repository");
const { isSubscriptionUsable } = require("../subscription/subscription.service");

const httpError = (status, message, extra) => {
  const error = new Error(message);
  error.status = status;
  if (extra) {
    Object.assign(error, extra);
  }
  return error;
};

const formatSubscriptionSummary = (subscription) => {
  if (!subscription) {
    return { status: null, planId: null, planName: null, maxUsers: null, startDate: null, expiryDate: null, usable: false };
  }

  return {
    id: subscription.id,
    status: subscription.status,
    planId: subscription.planId,
    planName: subscription.plan?.name ?? null,
    maxUsers: subscription.plan?.maxUsers ?? null,
    price: subscription.plan ? Number(subscription.plan.price) : null,
    startDate: subscription.startDate,
    expiryDate: subscription.expiryDate,
    usable: isSubscriptionUsable(subscription),
  };
};

const formatOrganizationSummary = (org) => ({
  id: org.id,
  name: org.name,
  status: org.status,
  website: org.website,
  businessEmail: org.businessEmail,
  owner: org.owner ? { id: org.owner.id, fullName: org.owner.fullName, email: org.owner.email } : null,
  subscription: formatSubscriptionSummary(org.subscriptions?.[0]),
  memberCounts: org.memberCounts,
  createdAt: org.createdAt,
});

const listOrganizations = async (filters = {}) => {
  const organizations = await listOrganizationsSummary(filters);
  return organizations.map(formatOrganizationSummary);
};

const getOrganizationDetail = async (organizationId) => {
  const organization = await findOrganizationDetailById(organizationId);

  if (!organization) {
    throw httpError(404, "Organization not found");
  }

  return {
    id: organization.id,
    name: organization.name,
    status: organization.status,
    website: organization.website,
    businessEmail: organization.businessEmail,
    owner: organization.owner,
    subscription: formatSubscriptionSummary(organization.subscriptions?.[0]),
    members: organization.memberships.map((m) => ({
      membershipId: m.id,
      userId: m.user.id,
      fullName: m.user.fullName,
      email: m.user.email,
      role: m.role,
      membershipStatus: m.status,
      userStatus: m.user.status,
      emailVerified: m.user.emailVerified,
      permissions: m.permissions,
      lastLogin: m.user.lastLogin,
      joinedAt: m.createdAt,
    })),
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
};

const getOrganizationSubscription = async (organizationId) => {
  const organization = await findOrganizationDetailById(organizationId);

  if (!organization) {
    throw httpError(404, "Organization not found");
  }

  const subscription = await findLatestOrganizationSubscription(organizationId);

  return {
    organizationId,
    organizationName: organization.name,
    subscription: formatSubscriptionSummary(subscription),
  };
};

const listRecruiters = async (filters = {}) => {
  return listAllRecruitersSummary(filters);
};

const getRecruiterDetail = async (recruiterId) => {
  const recruiter = await findRecruiterDetailById(recruiterId);

  if (!recruiter) {
    throw httpError(404, "Recruiter not found");
  }

  return recruiter;
};

const listPlans = async () => {
  return findAllPlansForAdmin();
};

const createPlan = async (actorUser, planInput, ipAddress) => {
  const plan = await createPlanWithAudit(planInput, {
    actorUserId: actorUser.id,
    action: "SUBSCRIPTION_PLAN_CREATED",
    targetType: "SubscriptionPlan",
    metadata: {
      name: planInput.name,
      type: planInput.type,
      price: planInput.price,
      billingCycle: planInput.billingCycle,
      maxUsers: planInput.maxUsers,
      jobPostingLimit: planInput.jobPostingLimit,
    },
    ipAddress: ipAddress ?? null,
  });

  return plan;
};

const updatePlan = async (actorUser, planId, updates, ipAddress) => {
  const existingPlan = await findPlanById(planId);

  if (!existingPlan) {
    throw httpError(404, "Subscription plan not found");
  }

  const changedFields = {};
  for (const key of Object.keys(updates)) {
    const oldValue = key === "price" ? Number(existingPlan.price) : existingPlan[key];
    const newValue = updates[key];

    if (oldValue !== newValue) {
      changedFields[key] = { from: oldValue, to: newValue };
    }
  }

  let action = "SUBSCRIPTION_PLAN_UPDATED";
  if ("isActive" in changedFields) {
    action = changedFields.isActive.to === true ? "SUBSCRIPTION_PLAN_ACTIVATED" : "SUBSCRIPTION_PLAN_DEACTIVATED";
  }

  const updated = await updatePlanWithAudit(planId, updates, {
    actorUserId: actorUser.id,
    action,
    targetType: "SubscriptionPlan",
    targetId: planId,
    metadata: { changes: changedFields },
    ipAddress: ipAddress ?? null,
  });

  return updated;
};

const DEFAULT_AUDIT_LOG_PAGE_SIZE = 50;
const MAX_AUDIT_LOG_PAGE_SIZE = 200;

const listAuditLogsForAdmin = async (filters) => {
  const requestedLimit = Number(filters.limit);
  const take = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_AUDIT_LOG_PAGE_SIZE)
    : DEFAULT_AUDIT_LOG_PAGE_SIZE;

  const requestedOffset = Number(filters.offset);
  const skip = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

  const { logs, total } = await listAuditLogs({
    action: filters.action || undefined,
    targetType: filters.targetType || undefined,
    targetId: filters.targetId || undefined,
    actorUserId: filters.actorUserId || undefined,
    take,
    skip,
  });

  return {
    logs: logs.map((log) => ({
      id: log.id,
      actor: log.actor,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      ipAddress: log.ipAddress,
      createdAt: log.createdAt,
    })),
    total,
    take,
    skip,
  };
};

// Calculate date cutoff based on timeRange filter ("today", "7d", "30d", "90d", "all")
const computeDateCutoff = (timeRange) => {
  const now = new Date();
  if (timeRange === "today") {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return today;
  }
  if (timeRange === "7d") {
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }
  if (timeRange === "30d") {
    return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }
  if (timeRange === "90d") {
    return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  }
  return null;
};

// Platform-level aggregates and charts for the SUPER_ADMIN dashboard
const getDashboardStatistics = async (timeRange = "all") => {
  const sinceDate = computeDateCutoff(timeRange);

  const [
    organizations,
    totalUsers,
    totalEmployees,
    totalOrgAdmins,
    totalRecruiters,
    organizationRecruiters,
    independentRecruiters,
    subscriptions,
    activePlansCount,
    planDistribution,
    growthTimestamps,
    expiringSubscriptions,
    recentEvents,
  ] = await Promise.all([
    countOrganizationsByStatus(),
    countTotalUsers(),
    countUsersByRole("EMPLOYEE"),
    countUsersByRole("ORG_ADMIN"),
    countAllRecruiters(),
    countOrganizationRecruiters(),
    countIndependentRecruiters(),
    countSubscriptionStatistics(),
    countActivePlans(),
    getSubscriptionPlanDistribution(),
    getPlatformGrowthTimestamps(sinceDate),
    listExpiringSubscriptions(10),
    getRecentAuditEvents(8),
  ]);

  // Aggregate growth timeline points by date bucket for charts
  const growthTimeline = formatGrowthTimeline(growthTimestamps, timeRange);

  const formattedExpiring = expiringSubscriptions.map((sub) => {
    const isOrg = Boolean(sub.organizationId);
    const customerName = isOrg
      ? sub.organization?.name ?? "Unknown Organization"
      : sub.user?.fullName ?? "Independent Recruiter";
    const customerEmail = isOrg
      ? sub.organization?.businessEmail ?? ""
      : sub.user?.email ?? "";

    const daysRemaining = sub.expiryDate
      ? Math.max(0, Math.ceil((new Date(sub.expiryDate) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;

    return {
      id: sub.id,
      customer: customerName,
      email: customerEmail,
      type: isOrg ? "ORGANIZATION" : "INDEPENDENT",
      planName: sub.plan?.name ?? "Standard",
      status: sub.status,
      expiryDate: sub.expiryDate,
      daysRemaining,
    };
  });

  return {
    timeRange,
    kpis: {
      totalOrganizations: organizations.total,
      activeOrganizations: organizations.active,
      suspendedOrganizations: organizations.suspended,
      pendingOrganizations: organizations.pending,
      totalRecruiters,
      organizationRecruiters,
      independentRecruiters,
      totalCandidates: totalEmployees,
      totalOrgAdmins,
      totalUsers,
      activeSubscriptions: subscriptions.usable,
      expiringSoonSubscriptions: subscriptions.expiringSoon,
      suspendedOrExpiredSubscriptions: subscriptions.expiredByDate + subscriptions.byStatus.expired + subscriptions.byStatus.suspended,
      activePlansCount,
    },
    subscriptions: {
      total: subscriptions.byStatus.total,
      active: subscriptions.byStatus.active,
      trial: subscriptions.byStatus.trial,
      expired: subscriptions.byStatus.expired + subscriptions.expiredByDate,
      suspended: subscriptions.byStatus.suspended,
      cancelled: subscriptions.byStatus.cancelled,
      usable: subscriptions.usable,
      expiringSoon: subscriptions.expiringSoon,
    },
    planDistribution,
    growthTimeline,
    expiringSubscriptions: formattedExpiring,
    recentActivity: recentEvents.map((evt) => ({
      id: evt.id,
      action: evt.action,
      actorName: evt.actor?.fullName ?? "System",
      actorEmail: evt.actor?.email ?? "",
      targetType: evt.targetType,
      targetId: evt.targetId,
      metadata: evt.metadata,
      createdAt: evt.createdAt,
    })),
    paymentGatewayStatus: {
      provider: process.env.PAYMENT_GATEWAY_PROVIDER || "simulated",
      isLive: process.env.NODE_ENV === "production" && process.env.PAYMENT_GATEWAY_PROVIDER !== "simulated",
      message: "Payment gateway is operating in simulated mode. Awaiting production payment gateway integration.",
    },
  };
};

// Helper to group creation timestamps into daily timeline points
const formatGrowthTimeline = ({ organizations, candidates, recruiters }, timeRange) => {
  const dateMap = new Map();

  const getDateKey = (date) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const ensureEntry = (key) => {
    if (!dateMap.has(key)) {
      dateMap.set(key, { date: key, organizations: 0, candidates: 0, recruiters: 0 });
    }
    return dateMap.get(key);
  };

  for (const item of organizations) {
    const key = getDateKey(item.createdAt);
    ensureEntry(key).organizations += 1;
  }

  for (const item of candidates) {
    const key = getDateKey(item.createdAt);
    ensureEntry(key).candidates += 1;
  }

  for (const item of recruiters) {
    const key = getDateKey(item.createdAt);
    ensureEntry(key).recruiters += 1;
  }

  const sorted = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return sorted;
};

module.exports = {
  getDashboardStatistics,
  listOrganizations,
  getOrganizationDetail,
  getOrganizationSubscription,
  listRecruiters,
  getRecruiterDetail,
  listPlans,
  createPlan,
  updatePlan,
  listAuditLogsForAdmin,
};

