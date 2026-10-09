const prisma = require("../../config/prisma");
const { isRecruiterProfileComplete } = require("../auth/auth.service");

// The single write path for AuditLog rows — every SUPER_ADMIN privileged
// action goes through this, never a raw `tx.auditLog.create` at the call
// site, so the shape (and the "never log secrets" rule) stays enforced in
// one place. `tx` is required, not defaulted to `prisma`, so every call site
// is forced to write its audit row inside the same transaction as the
// mutation it records. `metadata` must never contain passwords, hashes, tokens, or
// other secrets.
const writeAuditLog = async (
  tx,
  { actorUserId, action, targetType, targetId, metadata, ipAddress }
) => {
  return tx.auditLog.create({
    data: {
      actorUserId,
      action,
      targetType,
      targetId,
      metadata: metadata ?? undefined,
      ipAddress: ipAddress ?? null,
    },
  });
};

const countOrganizationsByStatus = async () => {
  const grouped = await prisma.organization.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  const counts = { total: 0, active: 0, pending: 0, suspended: 0 };

  for (const row of grouped) {
    counts.total += row._count._all;
    if (row.status === "ACTIVE") counts.active = row._count._all;
    if (row.status === "PENDING_VERIFICATION") counts.pending = row._count._all;
    if (row.status === "SUSPENDED") counts.suspended = row._count._all;
  }

  return counts;
};

const countTotalUsers = async () => {
  return prisma.user.count({ where: { isDeleted: false } });
};

const countUsersByRole = async (roleName) => {
  return prisma.user.count({
    where: {
      isDeleted: false,
      roles: { some: { role: { name: roleName } } },
    },
  });
};

const countAllRecruiters = async () => {
  return prisma.user.count({
    where: {
      isDeleted: false,
      OR: [
        { roles: { some: { role: { name: "RECRUITER" } } } },
        { organizationMemberships: { some: { role: "RECRUITER", status: "ACTIVE" } } },
      ],
    },
  });
};

// A RECRUITER-role user counts as an "organization recruiter" iff they have
// an ACTIVE OrganizationMembership right now.
const countOrganizationRecruiters = async () => {
  return prisma.user.count({
    where: {
      isDeleted: false,
      organizationMemberships: { some: { role: "RECRUITER", status: "ACTIVE" } },
    },
  });
};

// The inverse of the above — no ACTIVE OrganizationMembership.
const countIndependentRecruiters = async () => {
  return prisma.user.count({
    where: {
      isDeleted: false,
      roles: { some: { role: { name: "RECRUITER" } } },
      organizationMemberships: { none: { role: "RECRUITER", status: "ACTIVE" } },
    },
  });
};

// Returns distinct counts for every status + usable count + expiring counts.
const countSubscriptionStatistics = async () => {
  const now = new Date();
  const fourteenDaysFromNow = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const [byStatus, usable, expiredByDate, expiringSoon] = await Promise.all([
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.subscription.count({
      where: {
        status: { in: ["ACTIVE", "TRIAL"] },
        OR: [{ expiryDate: null }, { expiryDate: { gt: now } }],
      },
    }),
    prisma.subscription.count({
      where: {
        status: { in: ["ACTIVE", "TRIAL"] },
        expiryDate: { lt: now },
      },
    }),
    prisma.subscription.count({
      where: {
        status: { in: ["ACTIVE", "TRIAL"] },
        expiryDate: {
          gt: now,
          lte: fourteenDaysFromNow,
        },
      },
    }),
  ]);

  const counts = { total: 0, trial: 0, active: 0, expired: 0, cancelled: 0, suspended: 0 };

  for (const row of byStatus) {
    counts.total += row._count._all;
    const key = row.status.toLowerCase();
    if (key in counts) counts[key] = row._count._all;
  }

  return {
    byStatus: counts,
    usable,
    expiredByDate,
    expiringSoon,
  };
};

const countActivePlans = async () => {
  return prisma.subscriptionPlan.count({
    where: { isActive: true },
  });
};

// Subscriber density per subscription plan
const getSubscriptionPlanDistribution = async () => {
  const plans = await prisma.subscriptionPlan.findMany({
    select: {
      id: true,
      name: true,
      type: true,
      price: true,
      billingCycle: true,
      maxUsers: true,
      isActive: true,
      subscriptions: {
        where: {
          status: { in: ["ACTIVE", "TRIAL"] },
          OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
        },
        select: { id: true },
      },
    },
    orderBy: { price: "asc" },
  });

  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    type: plan.type,
    price: Number(plan.price),
    billingCycle: plan.billingCycle,
    maxUsers: plan.maxUsers,
    isActive: plan.isActive,
    subscriberCount: plan.subscriptions.length,
  }));
};


// Returns creation timestamps for platform entities within a date cutoff for growth charts
const getPlatformGrowthTimestamps = async (sinceDate) => {
  const whereCreatedAt = sinceDate ? { createdAt: { gte: sinceDate } } : {};

  const [organizations, candidates, recruiters] = await Promise.all([
    prisma.organization.findMany({
      where: whereCreatedAt,
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.user.findMany({
      where: {
        isDeleted: false,
        roles: { some: { role: { name: "EMPLOYEE" } } },
        ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
      },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.user.findMany({
      where: {
        isDeleted: false,
        OR: [
          { roles: { some: { role: { name: "RECRUITER" } } } },
          { organizationMemberships: { some: { role: "RECRUITER", status: "ACTIVE" } } },
        ],
        ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
      },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return { organizations, candidates, recruiters };
};

// Subscriptions requiring attention (expiring within next 30 days)
const listExpiringSubscriptions = async (limit = 10) => {
  const now = new Date();
  const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const subscriptions = await prisma.subscription.findMany({
    where: {
      status: { in: ["ACTIVE", "TRIAL"] },
      expiryDate: {
        gt: now,
        lte: thirtyDaysFromNow,
      },
    },
    include: {
      plan: true,
      user: { select: { id: true, fullName: true, email: true } },
      organization: { select: { id: true, name: true, businessEmail: true } },
    },
    orderBy: { expiryDate: "asc" },
    take: limit,
  });

  return subscriptions;
};

// Recent platform audit events
const getRecentAuditEvents = async (limit = 10) => {
  return prisma.auditLog.findMany({
    take: limit,
    orderBy: { createdAt: "desc" },
    include: {
      actor: { select: { id: true, fullName: true, email: true } },
    },
  });
};

// Organization summary list with membership counts and subscription
const listOrganizationsSummary = async ({ search, status } = {}) => {
  const where = {};
  if (status && status !== "ALL") {
    where.status = status;
  }
  if (search && search.trim()) {
    where.name = { contains: search.trim(), mode: "insensitive" };
  }

  const organizations = await prisma.organization.findMany({
    where,
    include: {
      owner: { select: { id: true, fullName: true, email: true } },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1, include: { plan: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const orgIds = organizations.map((o) => o.id);

  // Group memberships to get exact counts: total members (owner/admin + recruiters)
  const membershipCounts = await prisma.organizationMembership.groupBy({
    by: ["organizationId", "role", "status"],
    where: { organizationId: { in: orgIds } },
    _count: { _all: true },
  });

  const countsByOrg = {};
  for (const row of membershipCounts) {
    const bucket = (countsByOrg[row.organizationId] ??= {
      totalActiveMembers: 0,
      activeRecruiters: 0,
      invitedRecruiters: 0,
      removedRecruiters: 0,
      hasActiveAdmin: false,
    });

    if (row.status === "ACTIVE") {
      bucket.totalActiveMembers += row._count._all;
      if (row.role === "RECRUITER") {
        bucket.activeRecruiters += row._count._all;
      }
      if (row.role === "ORG_ADMIN") {
        bucket.hasActiveAdmin = true;
      }
    } else if (row.status === "INVITED" && row.role === "RECRUITER") {
      bucket.invitedRecruiters += row._count._all;
    } else if (row.status === "REMOVED" && row.role === "RECRUITER") {
      bucket.removedRecruiters += row._count._all;
    }
  }

  return organizations.map((org) => {
    const counts = countsByOrg[org.id] ?? {
      totalActiveMembers: 0,
      activeRecruiters: 0,
      invitedRecruiters: 0,
      removedRecruiters: 0,
      hasActiveAdmin: false,
    };
    return {
      ...org,
      memberCounts: counts,
    };
  });
};

// Full organization detail including all members and permissions
const findOrganizationDetailById = async (organizationId) => {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      owner: { select: { id: true, fullName: true, email: true, status: true, lastLogin: true } },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1, include: { plan: true } },
      memberships: {
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              status: true,
              emailVerified: true,
              lastLogin: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return organization;
};

// List all recruiters with clear distinction between independent vs organization recruiter
const listAllRecruitersSummary = async ({ type = "all", search = "" } = {}) => {
  const where = {
    isDeleted: false,
    OR: [
      { roles: { some: { role: { name: "RECRUITER" } } } },
      { organizationMemberships: { some: { role: "RECRUITER", status: "ACTIVE" } } },
    ],
  };

  const filters = [];
  if (search && search.trim()) {
    const q = search.trim();
    filters.push({ OR: [
      { fullName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    ] });
  }

  const normalizedType = (type || "").toLowerCase();
  if (normalizedType === "independent") {
    filters.push({
      roles: { some: { role: { name: "RECRUITER" } } },
      organizationMemberships: { none: { role: "RECRUITER", status: "ACTIVE" } },
    });
  } else if (normalizedType === "organization") {
    filters.push({ organizationMemberships: { some: { role: "RECRUITER", status: "ACTIVE" } } });
  }

  if (filters.length > 0) {
    where.AND = filters;
  }

  const recruiters = await prisma.user.findMany({
    where,
    select: {
      id: true,
      fullName: true,
      email: true,
      status: true,
      emailVerified: true,
      createdAt: true,
      lastLogin: true,
      recruiterProfile: true,
      organizationMemberships: {
        where: { status: "ACTIVE" },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              status: true,
              subscriptions: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { plan: true },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const userIds = recruiters.map((r) => r.id);

  // Fetch latest personal subscription for each recruiter in one batch query
  const latestSubscriptions = await prisma.subscription.findMany({
    where: { userId: { in: userIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["userId"],
    include: { plan: true },
  });

  const subscriptionByUserId = new Map(latestSubscriptions.map((s) => [s.userId, s]));

  return recruiters.map((recruiter) => {
    const activeMembership = recruiter.organizationMemberships?.[0] ?? null;
    const isOrgRecruiter = Boolean(activeMembership);
    const recruiterProfileComplete = isRecruiterProfileComplete(
      recruiter.recruiterProfile,
      false
    );

    const sub = isOrgRecruiter
      ? activeMembership.organization.subscriptions?.[0] ?? null
      : subscriptionByUserId.get(recruiter.id) ?? null;

    return {
      id: recruiter.id,
      fullName: recruiter.fullName,
      email: recruiter.email,
      status: isOrgRecruiter
        ? recruiter.status
        : recruiterProfileComplete && !["SUSPENDED", "INACTIVE"].includes(recruiter.status)
          ? "ACTIVE"
          : recruiter.status === "SUSPENDED" || recruiter.status === "INACTIVE"
            ? recruiter.status
            : "PENDING_PROFILE",
      emailVerified: recruiter.emailVerified,
      createdAt: recruiter.createdAt,
      lastLogin: recruiter.lastLogin,
      recruiterType: isOrgRecruiter ? "ORGANIZATION" : "INDEPENDENT",
      organization: activeMembership
        ? {
            id: activeMembership.organization.id,
            name: activeMembership.organization.name,
            role: activeMembership.role,
            status: activeMembership.organization.status,
            permissions: activeMembership.permissions,
          }
        : null,
      subscription: sub
        ? {
            id: sub.id,
            status: sub.status,
            planName: sub.plan?.name ?? null,
            price: sub.plan ? Number(sub.plan.price) : null,
            expiryDate: sub.expiryDate,
            usable: sub.status === "ACTIVE" || sub.status === "TRIAL",
          }
        : null,
    };
  });
};

// Full detail for a single recruiter
const findRecruiterDetailById = async (userId) => {
  const recruiter = await prisma.user.findFirst({
    where: {
      id: userId,
      isDeleted: false,
      OR: [
        { roles: { some: { role: { name: "RECRUITER" } } } },
        { organizationMemberships: { some: { role: "RECRUITER", status: "ACTIVE" } } },
      ],
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      status: true,
      emailVerified: true,
      createdAt: true,
      lastLogin: true,
      recruiterProfile: true,
      organizationMemberships: {
        include: {
          organization: {
            include: {
              subscriptions: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { plan: true },
              },
            },
          },
        },
      },
      subscriptions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { plan: true },
      },
    },
  });

  if (!recruiter) {
    return null;
  }

  const activeMembership = recruiter.organizationMemberships?.find((m) => m.status === "ACTIVE") ?? null;
  const isOrgRecruiter = Boolean(activeMembership);

  const sub = isOrgRecruiter
    ? activeMembership.organization.subscriptions?.[0] ?? null
    : recruiter.subscriptions?.[0] ?? null;

  return {
    id: recruiter.id,
    fullName: recruiter.fullName,
    email: recruiter.email,
    status: recruiter.status,
    emailVerified: recruiter.emailVerified,
    lastLogin: recruiter.lastLogin,
    createdAt: recruiter.createdAt,
    recruiterType: isOrgRecruiter ? "ORGANIZATION" : "INDEPENDENT",
    organization: activeMembership
      ? {
          id: activeMembership.organization.id,
          name: activeMembership.organization.name,
          role: activeMembership.role,
          membershipStatus: activeMembership.status,
          permissions: activeMembership.permissions,
        }
      : null,
    subscription: sub
      ? {
          id: sub.id,
          status: sub.status,
          planName: sub.plan?.name ?? null,
          price: sub.plan ? Number(sub.plan.price) : null,
          expiryDate: sub.expiryDate,
          usable: sub.status === "ACTIVE" || sub.status === "TRIAL",
        }
      : null,
  };
};

const createPlanWithAudit = async (planData, auditEntry) => {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.subscriptionPlan.create({ data: planData });
    await writeAuditLog(tx, { ...auditEntry, targetId: plan.id });
    return plan;
  });
};

const updatePlanWithAudit = async (planId, planData, auditEntry) => {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.subscriptionPlan.update({
      where: { id: planId },
      data: planData,
    });
    await writeAuditLog(tx, auditEntry);
    return plan;
  });
};

const listAuditLogs = async ({ action, targetType, targetId, actorUserId, take, skip }) => {
  const where = {};
  if (action) where.action = action;
  if (targetType) where.targetType = targetType;
  if (targetId) where.targetId = targetId;
  if (actorUserId) where.actorUserId = actorUserId;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: { actor: { select: { id: true, fullName: true, email: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
};

module.exports = {
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
  writeAuditLog,
};

