const prisma = require("../../config/prisma");
const { isAllowedRoleCombination } = require("../auth/role-policy");
const { assertProtectedSuperAdminCanReceiveRole } = require("../auth/super-admin-protection");

const findLatestUserSubscription = async (userId) => {
  return prisma.subscription.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
};

// Includes `plan` (specifically for plan.maxUsers) — needed by
// organization.service.js's recruiter seat-limit check. Safe to include
// unconditionally: every other caller (resolveSubscriptionAccess,
// getOrganizationSummary, assertNoActiveSubscription) either destructures
// specific fields or only checks isSubscriptionUsable(), neither of which
// is affected by the extra relation.
const findLatestOrganizationSubscription = async (organizationId) => {
  return prisma.subscription.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
};

const findActiveOrganizationMembership = async (userId) => {
  return prisma.organizationMembership.findFirst({
    where: {
      userId,
      status: "ACTIVE",
    },
  });
};

// Deliberately NOT filtered to status: "ACTIVE" — this resolves "is this
// authenticated user the legitimate ORG_ADMIN of some organization" for the
// purpose of letting them buy that organization's *first* subscription,
// which is exactly the moment their membership is still INVITED (see
// createUser in auth.repository.js: an ORG_ADMIN's own membership starts
// INVITED and only flips to ACTIVE once payment succeeds — otherwise
// checkout would have a circular dependency on the very subscription it's
// meant to create). REMOVED is excluded so a former admin can't re-purchase.
const findOrgAdminMembership = async (userId) => {
  return prisma.organizationMembership.findFirst({
    where: {
      userId,
      role: "ORG_ADMIN",
      status: { not: "REMOVED" },
    },
  });
};

const findActivePlans = async () => {
  return prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: [{ type: "asc" }, { price: "asc" }],
  });
};

const findPlanById = async (planId) => {
  return prisma.subscriptionPlan.findUnique({
    where: { id: planId },
  });
};

// Unlike findActivePlans (isActive-only, used by the public
// GET /api/subscriptions/plans a recruiter/org-admin buys from), this
// returns EVERY plan including deactivated ones — SUPER_ADMIN's plan
// management needs to see and reactivate inactive plans, not just the
// purchasable catalog.
const findAllPlansForAdmin = async () => {
  return prisma.subscriptionPlan.findMany({
    include: {
      subscriptions: {
        where: {
          status: { in: ["ACTIVE", "TRIAL"] },
          OR: [
            { expiryDate: null },
            { expiryDate: { gt: new Date() } },
          ],
        },
        select: {
          id: true,
        },
      },
    },
    orderBy: [{ type: "asc" }, { price: "asc" }],
  });
};

// Phase B (V3): local usability rule for the in-transaction duplicate-
// subscription re-check. Deliberately a copy of subscription.service.js's
// isSubscriptionUsable (USABLE_STATUSES + independent expiry check) because
// the service imports this repository — a reverse import would create a
// require cycle. The semantics MUST stay identical to the pre-transaction
// assertNoActiveSubscription check (latest subscription per owner).
const USABLE_SUBSCRIPTION_STATUSES = ["ACTIVE", "TRIAL"];

const isSubscriptionRowUsable = (subscription) =>
  Boolean(
    subscription &&
      USABLE_SUBSCRIPTION_STATUSES.includes(subscription.status) &&
      (!subscription.expiryDate || subscription.expiryDate > new Date())
  );

// error.status mirrors subscription.service.js's httpError so the controller
// keeps returning the same HTTP codes (409 for a duplicate subscription).
const duplicateSubscriptionError = () => {
  const error = new Error("An active subscription already exists");
  error.status = 409;
  return error;
};

// Same message/status confirmPayment uses when the resolved ownership shape
// no longer matches the checkout token — a checkout that raced against an
// ownership change is stale, not a business rejection.
const staleCheckoutSessionError = () => {
  const error = new Error("Checkout session is invalid or expired");
  error.status = 400;
  return error;
};

// Creates the ACTIVE subscription and, for organization subscriptions, flips
// Organization.status to ACTIVE in the same transaction — a successful
// organization payment and an active organization must never be observable
// as two separate, out-of-sync writes. For the organization's first
// purchase, orgAdminUserId also carries the buyer through so their own
// (still INVITED) membership and (still PENDING_PROFILE) user account
// activate in that same transaction — closing the loop that let them
// purchase before they had ACTIVE access in the first place.
const createActiveSubscription = async ({
  planId,
  userId,
  organizationId,
  orgAdminUserId,
  targetRole,
  targetRoleId,
  organizationName,
  targetUserId,
  startDate,
  expiryDate,
}) => {
  return prisma.$transaction(async (tx) => {
    let resolvedOrganizationId = organizationId;

    // ================================================================
    // Phase B (V3): authoritative serialization + fresh-state checks.
    // Every decision below is made from fresh, row-locked state inside
    // this transaction — never from the pre-transaction service snapshot.
    // ================================================================

    // 1) User row lock FIRST, before any read whose result affects an
    //    authorization or duplication decision. Concurrent payment
    //    confirmations for the same buyer queue here; every later read in
    //    this transaction then observes the winner's committed state
    //    (PostgreSQL default READ COMMITTED). Same established pattern as
    //    auth.repository.js (addRoleToExistingUser / ensureEmployeeAccount)
    //    and the organization.repository.js seat lock.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${targetUserId} FOR UPDATE`;

    // The buyer's own ORG_ADMIN membership activation is keyed to
    // orgAdminUserId. Today the only caller (confirmPayment) always passes
    // the same id as targetUserId; if that ever differs, lock it too so the
    // membership activation below is serialized as well.
    if (orgAdminUserId && orgAdminUserId !== targetUserId) {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${orgAdminUserId} FOR UPDATE`;
    }

    // 2) Organization row lock — consistent User → Organization ordering.
    //    Only for an EXISTING organization (renewal / re-purchase shape). A
    //    new organization does not exist yet and is protected by the User
    //    lock plus the fresh membership check below instead.
    if (organizationId) {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
    }

    // 3) Fresh read under the lock — authoritative assigned roles and
    //    memberships for every decision below.
    const lockedUser = await tx.user.findUnique({
      where: { id: targetUserId },
      include: {
        roles: { include: { role: true } },
        organizationMemberships: true,
      },
    });

    if (!lockedUser || lockedUser.isDeleted) {
      throw new Error("This account cannot be updated");
    }

    if (["SUSPENDED", "INACTIVE"].includes(lockedUser.status)) {
      throw new Error("Your account is not active");
    }

    // 4) Protected SUPER_ADMIN check BEFORE the combination check:
    //    normalizeRoleSet deliberately drops SUPER_ADMIN, so a
    //    combination-only check would treat the platform admin as an
    //    ordinary account.
    assertProtectedSuperAdminCanReceiveRole(lockedUser, targetRole);

    // 5) Fresh role-combination check (authoritative; the pre-transaction
    //    service check is only a fast-fail). Prevents Recruiter + Org Admin
    //    and Candidate + Recruiter + Org Admin while preserving every valid
    //    combination, including role-less renewals (targetRole null).
    const currentRoles = (lockedUser.roles ?? [])
      .map(({ role }) => role?.name)
      .filter(Boolean);

    if (!isAllowedRoleCombination([...currentRoles, targetRole])) {
      throw new Error(
        `This account cannot be assigned ${targetRole ?? "an additional role"} because the resulting role combination is not allowed`
      );
    }

    if (targetRole === "RECRUITER") {
      // 6) Org Recruiter membership-only invariant (Phase A mirror): an
      //    ACTIVE organization-recruiter membership IS that user's recruiter
      //    account; a global RECRUITER UserRole must never be granted on top
      //    of it. REMOVED/INVITED memberships are not affected.
      if (
        (lockedUser.organizationMemberships ?? []).some(
          (membership) =>
            membership.role === "RECRUITER" && membership.status === "ACTIVE"
        )
      ) {
        throw new Error(
          "Organization recruiters cannot be assigned an additional global recruiter role"
        );
      }
      await tx.userRole.upsert({
        where: { userId_roleId: { userId: targetUserId, roleId: targetRoleId } },
        create: { userId: targetUserId, roleId: targetRoleId },
        update: {},
      });
      await tx.recruiterProfile.upsert({
        where: { userId: targetUserId },
        create: { userId: targetUserId },
        update: {},
      });
    }

    if (targetRole === "ORG_ADMIN") {
      // 7) Ownership-shape revalidation under the lock (fresh state only).
      if (organizationId) {
        // Provided-organization shape (renewal / re-purchase): the user must
        // still hold a non-REMOVED ORG_ADMIN membership for THIS organization.
        // Otherwise the checkout token is stale and is rejected with the same
        // semantics confirmPayment already uses for owner-shape drift.
        const membership = (lockedUser.organizationMemberships ?? []).find(
          (candidate) =>
            candidate.organizationId === organizationId &&
            candidate.role === "ORG_ADMIN" &&
            candidate.status !== "REMOVED"
        );

        if (!membership) {
          throw staleCheckoutSessionError();
        }
      } else {
        // New-organization shape: reject when an ORG_ADMIN membership
        // appeared since checkout — otherwise this transaction would create
        // a second organization for the same user (tenant fork).
        const appearedMembership = (lockedUser.organizationMemberships ?? []).find(
          (candidate) =>
            candidate.role === "ORG_ADMIN" && candidate.status !== "REMOVED"
        );

        if (appearedMembership) {
          throw staleCheckoutSessionError();
        }
      }

      // The org shape is decided by the caller-resolved ownership context,
      // never by targetRole alone. organizationId is present exactly when the
      // buyer already owns an organization (resolveOwnerContext's
      // "organization" shape — e.g. an expired Org Admin renewing through
      // Switch Account, whose membership/org exist even while unusable). In
      // that shape the existing Organization, UserRole, and membership MUST
      // be reused: creating a second organization forks the tenant, and a
      // second userRole.create violates UserRole's @@unique([userId, roleId])
      // AFTER the payment charge has already succeeded, rolling back the
      // whole transaction. With organizationId absent this is a genuine
      // new-organization upgrade (e.g. Candidate → Org Admin), where nothing
      // exists yet and the original creation flow applies.
      if (organizationId) {
        resolvedOrganizationId = organizationId;

        // Idempotent: an existing ORG_ADMIN UserRole is reused untouched; a
        // missing one (drift/edge state) is created instead of crashing.
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: targetUserId, roleId: targetRoleId } },
          create: { userId: targetUserId, roleId: targetRoleId },
          update: {},
        });

        // Upsert against the EXISTING organization — never a membership on a
        // forked one. The ORG_ADMIN role is preserved; status is deliberately
        // left to the shared activation flip below (INVITED only when the row
        // must be created from scratch, mirroring registration's initial
        // INVITED membership state).
        await tx.organizationMembership.upsert({
          where: {
            userId_organizationId: {
              userId: targetUserId,
              organizationId: resolvedOrganizationId,
            },
          },
          update: { role: "ORG_ADMIN" },
          create: {
            userId: targetUserId,
            organizationId: resolvedOrganizationId,
            role: "ORG_ADMIN",
            status: "INVITED",
          },
        });
      } else {
        const organization = await tx.organization.create({
          data: {
            name: organizationName,
            ownerId: targetUserId,
            status: "PENDING_VERIFICATION",
          },
        });
        resolvedOrganizationId = organization.id;

        await tx.userRole.upsert({
          where: { userId_roleId: { userId: targetUserId, roleId: targetRoleId } },
          create: { userId: targetUserId, roleId: targetRoleId },
          update: {},
        });
        await tx.organizationMembership.create({
          data: {
            userId: targetUserId,
            organizationId: resolvedOrganizationId,
            role: "ORG_ADMIN",
            status: "INVITED",
          },
        });
      }

      await tx.user.update({
        where: { id: targetUserId },
        data: { status: "ACTIVE" },
      });
    }

    // 8) Fresh duplicate-subscription check under the lock — the exact
    //    pre-transaction semantics (latest subscription per effective owner),
    //    repeated against committed state so concurrent confirmations
    //    serialize and the loser rejects deterministically instead of
    //    creating a second ACTIVE subscription.
    if (userId) {
      const latestUserSubscription = await tx.subscription.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });

      if (isSubscriptionRowUsable(latestUserSubscription)) {
        throw duplicateSubscriptionError();
      }
    }

    if (resolvedOrganizationId) {
      const latestOrganizationSubscription = await tx.subscription.findFirst({
        where: { organizationId: resolvedOrganizationId },
        orderBy: { createdAt: "desc" },
      });

      if (isSubscriptionRowUsable(latestOrganizationSubscription)) {
        throw duplicateSubscriptionError();
      }
    }

    const subscription = await tx.subscription.create({
      data: {
        planId,
        userId: userId ?? null,
        organizationId: resolvedOrganizationId ?? null,
        status: "ACTIVE",
        startDate,
        expiryDate,
      },
      include: { plan: true },
    });

    if (resolvedOrganizationId) {
      await tx.organization.update({
        where: { id: resolvedOrganizationId },
        data: { status: "ACTIVE" },
      });
    }

    if (resolvedOrganizationId && orgAdminUserId) {
      await tx.organizationMembership.update({
        where: {
          userId_organizationId: {
            userId: orgAdminUserId,
            organizationId: resolvedOrganizationId,
          },
        },
        data: { status: "ACTIVE" },
      });

      await tx.user.update({
        where: { id: orgAdminUserId },
        data: { status: "ACTIVE" },
      });
    }

    return subscription;
  });
};

module.exports = {
  findLatestUserSubscription,
  findLatestOrganizationSubscription,
  findActiveOrganizationMembership,
  findOrgAdminMembership,
  findActivePlans,
  findPlanById,
  findAllPlansForAdmin,
  createActiveSubscription,
};
