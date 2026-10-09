const prisma = require("../../config/prisma");
const { removeStoredFileContent, removeEmptyStoredFileDirectory } = require("../storage/storage.service");
const { assertProtectedSuperAdminCanReceiveRole } = require("./super-admin-protection");
// role-policy.js is a pure module (no imports) — safe to require from the
// repository layer. The authoritative combination decision must be made from
// fresh in-transaction state (see addRoleToExistingUser / ensureEmployeeAccount
// below), so the policy helpers are needed here and not only in the service.
const { isAllowedRoleCombination } = require("./role-policy");

// How many previous passwords are rejected on reuse, and how many
// PasswordHistory rows are kept per user. A single named constant rather
// than a literal repeated at each call site — see assertPasswordNotReused in
// auth.service.js and prunePasswordHistory below.
const PASSWORD_HISTORY_DEPTH = 5;

// A registration assigns exactly the single role it was asked for. An
// ORG_ADMIN registration therefore does NOT also create EMPLOYEE (and, since
// createUser/addRoleToExistingUser gate the EmployeeProfile upsert on EMPLOYEE
// being present, no Candidate profile is created either). The Candidate
// account is added later, explicitly, through POST /api/auth/become-candidate
// (see becomeCandidate / ensureEmployeeAccount below). This helper stays the
// single source of the required role set for BOTH createUser and
// addRoleToExistingUser.
const getRequiredRegistrationRoleNames = (roleName) => {
  const normalizedRole = String(roleName ?? "").trim().toUpperCase();

  if (!normalizedRole) {
    return [];
  }

  return [normalizedRole];
};

const findUserByEmail = async (email) => {
  return prisma.user.findFirst({
    where: { email },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
      employeeProfile: true,
      recruiterProfile: true,
      organizationMemberships: {
        include: { organization: { include: { subscriptions: true } } },
      },
    },
  });
};

const findUsersByEmail = async (email) => {
  return prisma.user.findMany({
    where: { email },
    include: {
      roles: { include: { role: true } },
      employeeProfile: true,
      recruiterProfile: true,
      subscriptions: { include: { plan: true } },
      organizationMemberships: {
        include: { organization: { include: { subscriptions: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
};

const findRoleByName = async (roleName) => {
  return prisma.role.findUnique({
    where: {
      name: roleName,
    },
  });
};

const findUserById = async (id) => {
  return prisma.user.findUnique({
    where: { id },
    include: {
      roles: {
        include: { role: true },
      },
      employeeProfile: true,
      recruiterProfile: true,
      subscriptions: { include: { plan: true } },
      organizationMemberships: {
        include: { organization: { include: { subscriptions: true } } },
      },
    },
  });
};

const findUserRole = async (userId, roleName) => {
  return prisma.userRole.findFirst({
    where: {
      userId,
      role: { name: roleName },
    },
    include: { role: true },
  });
};

const findRecruiterProfileByUserId = async (userId) => {
  return prisma.recruiterProfile.findUnique({
    where: { userId },
  });
};

const upsertRecruiterProfile = async ({ userId, data }) => {
  return prisma.recruiterProfile.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
};

const findEmployeeProfileByUserId = async (userId) => {
  return prisma.employeeProfile.findUnique({
    where: { userId },
  });
};

const saveEmployeeProfile = async ({ userId, profileData, completionStatus }) => {
  const profileCompletedAt = completionStatus ? new Date() : null;

  return prisma.employeeProfile.upsert({
    where: { userId },
    update: {
      profileData,
      profileCompletedAt,
      headline: profileData?.generalInformation?.headline ?? null,
      bio: profileData?.professionalDescription?.bio ?? null,
      availability:
        profileData?.generalInformation?.availability ?? "ACTIVELY_LOOKING",
      updatedAt: new Date(),
    },
    create: {
      userId,
      profileData,
      profileCompletedAt,
      headline: profileData?.generalInformation?.headline ?? null,
      bio: profileData?.professionalDescription?.bio ?? null,
      availability:
        profileData?.generalInformation?.availability ?? "ACTIVELY_LOOKING",
    },
  });
};

const ensureEmployeeProfile = async (userId) => {
  return prisma.employeeProfile.upsert({
    where: { userId },
    update: {},
    create: { userId },
    include: {
      education: true,
      skills: true,
      projects: { include: { projectSkills: true } },
      certificates: true,
    },
  });
};

const getEmployeeProfileWithRelations = async (userId) => {
  return prisma.employeeProfile.findUnique({
    where: { userId },
    include: {
      files: {
        orderBy: { createdAt: "desc" },
      },
      education: {
        orderBy: { createdAt: "asc" },
      },
      skills: {
        orderBy: { createdAt: "asc" },
        include: {
          projectSkills: true,
          files: {
            orderBy: { createdAt: "desc" },
          },
        },
      },
      projects: {
        orderBy: { createdAt: "asc" },
        include: {
          projectSkills: { include: { skill: true } },
          storedFiles: {
            orderBy: { createdAt: "desc" },
          },
        },
      },
      certificates: {
        orderBy: { createdAt: "asc" },
        include: {
          files: {
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });
};

const updateEmployeeProfileData = async (userId, updater) => {
  return prisma.employeeProfile.upsert({
    where: { userId },
    update: updater,
    create: {
      userId,
      ...updater,
    },
    include: {
      education: true,
      skills: true,
      projects: { include: { projectSkills: true } },
      certificates: true,
    },
  });
};

const upsertEmployeeProfileEducation = async ({ userId, educationId, data }) => {
  const profile = await ensureEmployeeProfile(userId);

  if (educationId) {
    return prisma.employeeProfileEducation.update({
      where: { id: educationId, employeeProfileId: profile.id },
      data,
    });
  }

  return prisma.employeeProfileEducation.create({
    data: {
      employeeProfileId: profile.id,
      ...data,
    },
  });
};

const deleteEmployeeProfileEducation = async ({ userId, educationId }) => {
  const profile = await ensureEmployeeProfile(userId);

  return prisma.employeeProfileEducation.deleteMany({
    where: { id: educationId, employeeProfileId: profile.id },
  });
};

const upsertEmployeeProfileSkill = async ({ userId, skillId, data }) => {
  const profile = await ensureEmployeeProfile(userId);

  if (skillId) {
    return prisma.employeeProfileSkill.update({
      where: { id: skillId, employeeProfileId: profile.id },
      data,
    });
  }

  return prisma.employeeProfileSkill.create({
    data: {
      employeeProfileId: profile.id,
      ...data,
    },
  });
};

const deleteEmployeeProfileSkill = async ({ userId, skillId }) => {
  const profile = await ensureEmployeeProfile(userId);
  const skill = await prisma.employeeProfileSkill.findFirst({
    where: { id: skillId, employeeProfileId: profile.id },
    select: { id: true },
  });

  if (!skill) {
    return { count: 0 };
  }

  const certificates = await prisma.employeeProfileCertificate.findMany({
    where: { skillId: skill.id, employeeProfileId: profile.id },
    select: { id: true },
  });
  const certificateIds = certificates.map(({ id }) => id);
  const storedFiles = await prisma.storedFile.findMany({
    where: {
      ownerType: "EMPLOYEE",
      employeeProfileId: profile.id,
      OR: [
        { skillId: skill.id },
        ...(certificateIds.length > 0 ? [{ certificateId: { in: certificateIds } }] : []),
      ],
    },
    select: { id: true, storagePath: true },
  });

  await prisma.$transaction(async (transaction) => {
    if (storedFiles.length > 0) {
      await transaction.storedFile.deleteMany({
        where: { id: { in: storedFiles.map(({ id }) => id) } },
      });
    }

    if (certificateIds.length > 0) {
      await transaction.employeeProfileCertificate.deleteMany({
        where: { id: { in: certificateIds }, skillId: skill.id, employeeProfileId: profile.id },
      });
    }

    await transaction.employeeProfileSkill.delete({
      where: { id: skill.id },
    });
  });

  await Promise.all(storedFiles.map(({ storagePath }) => removeStoredFileContent(storagePath)));
  await Promise.all(storedFiles.map(({ storagePath }) => removeEmptyStoredFileDirectory(storagePath)));

  return { count: 1 };
};

const upsertEmployeeProfileProject = async ({ userId, projectId, data }) => {
  const profile = await ensureEmployeeProfile(userId);

  if (projectId) {
    const project = await prisma.employeeProfileProject.findFirst({
      where: { id: projectId, employeeProfileId: profile.id },
      select: { id: true },
    });
    if (!project) {
      const error = new Error("Project not found");
      error.status = 404;
      throw error;
    }

    return prisma.employeeProfileProject.update({
      where: { id: projectId, employeeProfileId: profile.id },
      data: {
        ...data,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
      },
    });
  }

  return prisma.employeeProfileProject.create({
    data: {
      employeeProfileId: profile.id,
      ...data,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
    },
  });
};

const deleteEmployeeProfileProject = async ({ userId, projectId }) => {
  const profile = await ensureEmployeeProfile(userId);

  return prisma.employeeProfileProject.deleteMany({
    where: { id: projectId, employeeProfileId: profile.id },
  });
};

const upsertEmployeeProfileProjectSkill = async ({ userId, projectId, projectSkillId, data }) => {
  const profile = await ensureEmployeeProfile(userId);
  const project = await prisma.employeeProfileProject.findFirst({
    where: { id: projectId, employeeProfileId: profile.id },
  });

  if (!project) {
    throw new Error("Project not found");
  }

  if (projectSkillId) {
    return prisma.employeeProfileProjectSkill.update({
      where: { id: projectSkillId },
      data: {
        ...data,
        projectId: project.id,
      },
    });
  }

  return prisma.employeeProfileProjectSkill.create({
    data: {
      projectId: project.id,
      ...data,
    },
  });
};

const deleteEmployeeProfileProjectSkill = async ({ userId, projectId, projectSkillId }) => {
  const profile = await ensureEmployeeProfile(userId);

  const project = await prisma.employeeProfileProject.findFirst({
    where: { id: projectId, employeeProfileId: profile.id },
  });

  if (!project) {
    throw new Error("Project not found");
  }

  return prisma.employeeProfileProjectSkill.deleteMany({
    where: { id: projectSkillId, projectId: project.id },
  });
};

const upsertEmployeeProfileCertificate = async ({ userId, certificateId, data }) => {
  const profile = await ensureEmployeeProfile(userId);

  if (certificateId) {
    return prisma.employeeProfileCertificate.update({
      where: { id: certificateId, employeeProfileId: profile.id },
      data,
    });
  }

  return prisma.employeeProfileCertificate.create({
    data: {
      employeeProfileId: profile.id,
      ...data,
    },
  });
};

const deleteEmployeeProfileCertificate = async ({ userId, certificateId }) => {
  const profile = await ensureEmployeeProfile(userId);

  const certificate = await prisma.employeeProfileCertificate.findFirst({
    where: { id: certificateId, employeeProfileId: profile.id },
    select: { id: true },
  });

  if (!certificate) {
    return { count: 0 };
  }

  const storedFiles = await prisma.storedFile.findMany({
    where: {
      ownerType: "EMPLOYEE",
      employeeProfileId: profile.id,
      certificateId: certificate.id,
    },
    select: { id: true, storagePath: true },
  });

  await prisma.$transaction(async (transaction) => {
    if (storedFiles.length > 0) {
      await transaction.storedFile.deleteMany({
        where: { id: { in: storedFiles.map(({ id }) => id) } },
      });
    }

    await transaction.employeeProfileCertificate.delete({
      where: { id: certificate.id },
    });
  });

  await Promise.all(storedFiles.map(({ storagePath }) => removeStoredFileContent(storagePath)));
  await Promise.all(storedFiles.map(({ storagePath }) => removeEmptyStoredFileDirectory(storagePath)));

  return { count: 1 };
};

const createUser = async ({
  fullName,
  email,
  passwordHash,
  roleId,
  roleName,
  organizationName,
  verificationTokenHash,
  verificationExpiresAt,
}) => {
  return prisma.$transaction(async (tx) => {
    const requiredRoleNames = getRequiredRegistrationRoleNames(roleName);
    const roleRecords = await Promise.all(
      requiredRoleNames.map(async (name) => {
        const role = await tx.role.findUnique({ where: { name } });
        if (!role) {
          throw new Error(`Requested role does not exist: ${name}`);
        }
        return role;
      })
    );

    const user = await tx.user.create({
      data: {
        fullName,
        email,
        passwordHash,
        provider: "LOCAL",
        emailVerified: false,
        status: "PENDING_EMAIL_VERIFICATION",

        roles: {
          create: roleRecords.map(({ id }) => ({ roleId: id })),
        },

        emailVerificationTokens: {
          create: {
            tokenHash: verificationTokenHash,
            expiresAt: verificationExpiresAt,
          },
        },
      },
    });

    if (requiredRoleNames.includes("EMPLOYEE")) {
      await tx.employeeProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });
    }

    if (requiredRoleNames.includes("RECRUITER")) {
      await tx.recruiterProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });
    }

    if (requiredRoleNames.includes("ORG_ADMIN")) {
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          ownerId: user.id,
          status: "PENDING_VERIFICATION",
        },
      });

      // Starts INVITED, not ACTIVE: this membership only becomes ACTIVE once
      // the organization's first subscription payment succeeds (see
      // createActiveSubscription in subscription.repository.js). Buying
      // that first subscription is itself resolved via
      // findOrgAdminMembership, which doesn't require ACTIVE — see
      // resolveOwnerContext in subscription.service.js.
      await tx.organizationMembership.upsert({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: organization.id,
          },
        },
        update: {
          role: "ORG_ADMIN",
          status: "INVITED",
        },
        create: {
          userId: user.id,
          organizationId: organization.id,
          role: "ORG_ADMIN",
          status: "INVITED",
        },
      });
    }

    await tx.passwordHistory.create({
      data: {
        userId: user.id,
        passwordHash,
      },
    });

    return user;
  });
};

const addRoleToExistingUser = async ({
  userId,
  roleId,
  roleName,
  organizationName,
}) => {
  return prisma.$transaction(async (tx) => {
    const requiredRoleNames = getRequiredRegistrationRoleNames(roleName);
    const roleRecords = await Promise.all(
      requiredRoleNames.map(async (name) => {
        const role = await tx.role.findUnique({ where: { name } });
        if (!role) {
          throw new Error(`Requested role does not exist: ${name}`);
        }
        return role;
      })
    );

    // Phase A (V2): the combination decision is made from FRESH state inside
    // this transaction, never from the pre-transaction read in the service.
    // Row-lock the User first so concurrent role additions for the same
    // account serialize: the second transaction re-evaluates against the
    // committed state and rejects instead of creating a forbidden combination.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

    const lockedUser = await tx.user.findUnique({
      where: { id: userId },
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

    // Must run BEFORE the combination check: normalizeRoleSet deliberately
    // drops SUPER_ADMIN, so a combination-only check would treat the protected
    // platform admin as an ordinary account and allow e.g. EMPLOYEE onto it.
    assertProtectedSuperAdminCanReceiveRole(lockedUser, roleName);

    const currentRoles = (lockedUser.roles ?? [])
      .map(({ role }) => role?.name)
      .filter(Boolean);

    if (!isAllowedRoleCombination([...currentRoles, ...requiredRoleNames])) {
      throw new Error(
        `This role combination is not allowed: ${[...currentRoles, ...requiredRoleNames]
          .filter((name, index, list) => list.indexOf(name) === index)
          .sort()
          .join(" + ")}`
      );
    }

    // Phase A (V6): an ACTIVE organization-recruiter membership IS that user's
    // recruiter account and must remain membership-only. Granting a global
    // RECRUITER UserRole on top would let the role outlive the membership and
    // break the "Org Recruiter is membership-only" invariant, so it is never
    // permitted through registration. (A REMOVED/INVITED membership does not
    // trigger this guard — that account legitimately registers as a personal
    // recruiter.)
    if (
      requiredRoleNames.includes("RECRUITER") &&
      (lockedUser.organizationMemberships ?? []).some(
        (membership) =>
          membership.role === "RECRUITER" && membership.status === "ACTIVE"
      )
    ) {
      throw new Error(
        "Organization recruiters cannot be assigned an additional global recruiter role"
      );
    }

    for (const roleRecord of roleRecords) {
      const existingRole = await tx.userRole.findFirst({
        where: { userId, roleId: roleRecord.id },
      });

      if (!existingRole) {
        await tx.userRole.create({
          data: { userId, roleId: roleRecord.id },
        });
      }
    }

    if (requiredRoleNames.includes("EMPLOYEE")) {
      await tx.employeeProfile.upsert({
        where: { userId },
        update: {},
        create: { userId },
      });
    }

    if (requiredRoleNames.includes("RECRUITER")) {
      await tx.recruiterProfile.upsert({
        where: { userId },
        update: {},
        create: { userId },
      });
    }

    if (requiredRoleNames.includes("ORG_ADMIN")) {
      const organization = await tx.organization.findFirst({
        where: {
          ownerId: userId,
          name: organizationName,
        },
      });

      if (!organization) {
        const createdOrganization = await tx.organization.create({
          data: {
            name: organizationName,
            ownerId: userId,
            status: "PENDING_VERIFICATION",
          },
        });

        await tx.organizationMembership.upsert({
          where: {
            userId_organizationId: {
              userId,
              organizationId: createdOrganization.id,
            },
          },
          update: {
            role: "ORG_ADMIN",
            status: "INVITED",
          },
          create: {
            userId,
            organizationId: createdOrganization.id,
            role: "ORG_ADMIN",
            status: "INVITED",
          },
        });
      } else {
        await tx.organizationMembership.upsert({
          where: {
            userId_organizationId: {
              userId,
              organizationId: organization.id,
            },
          },
          update: {
            role: "ORG_ADMIN",
            status: "INVITED",
          },
          create: {
            userId,
            organizationId: organization.id,
            role: "ORG_ADMIN",
            status: "INVITED",
          },
        });
      }
    }

    return tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true },
    });
  });
};

const ensureEmployeeAccount = async (userId, employeeRoleId) => {
  return prisma.$transaction(async (tx) => {
    // Phase A (V8): defense in depth for Candidate activation. The route's
    // authorize() gate is the first line; here the decision is re-made from
    // fresh, row-locked state so the transaction itself can never produce a
    // forbidden combination (e.g. if invalid state ever existed from drift or
    // a historical race). The Candidate activation workflow itself is
    // unchanged — this only rejects impossible states atomically.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

    const lockedUser = await tx.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });

    if (!lockedUser || lockedUser.isDeleted) {
      throw new Error("User not found");
    }

    if (["SUSPENDED", "INACTIVE"].includes(lockedUser.status)) {
      throw new Error("Your account is not active");
    }

    // Must run BEFORE the combination check: normalizeRoleSet deliberately
    // drops SUPER_ADMIN, so the combination check alone would allow the
    // protected platform admin to receive EMPLOYEE.
    assertProtectedSuperAdminCanReceiveRole(lockedUser, "EMPLOYEE");

    const assignedRoles = (lockedUser.roles ?? [])
      .map(({ role }) => role?.name)
      .filter(Boolean);

    if (!isAllowedRoleCombination([...assignedRoles, "EMPLOYEE"])) {
      throw new Error(
        "This account cannot activate the Candidate account because the resulting role combination is not allowed"
      );
    }

    await tx.userRole.upsert({
      where: { userId_roleId: { userId, roleId: employeeRoleId } },
      update: {},
      create: { userId, roleId: employeeRoleId },
    });

    await tx.employeeProfile.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    return tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true },
    });
  });
};

// Find verification token
const findVerificationToken = async (tokenHash) => {
  return prisma.emailVerificationToken.findUnique({
    where: {
      tokenHash: tokenHash,
    },
    include: {
      user: true,
    },
  });
};

// Verify user email and invalidate token
const verifyUserEmail = async (userId, tokenId, newEmail) => {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: {
        id: userId,
      },
      data: {
        ...(newEmail
          ? { email: newEmail }
          : { emailVerified: true, status: "PENDING_PROFILE" }),
      },
    });

    await tx.emailVerificationToken.delete({
      where: {
        id: tokenId,
      },
    });

    return user;
  });
};

const createAuthenticatedSession = async ({
  userId,
  sessionSelectorHash,
  sessionExpiresAt,
  refreshTokenHash,
  refreshExpiresAt,
  ipAddress,
  userAgent,
}) => {
  return prisma.$transaction(async (tx) => {
    const loginSession = await tx.loginSession.create({
      data: {
        userId,
        sessionSelectorHash,
        expiresAt: sessionExpiresAt,
        ipAddress,
        userAgent,
        lastActive: new Date(),
      },
    });

    await tx.refreshToken.create({
      data: {
        tokenHash: refreshTokenHash,
        userId,
        loginSessionId: loginSession.id,
        expiresAt: refreshExpiresAt,
      },
    });

    return loginSession;
  });
};
const updateLoginSecurity = async (userId, data) => {
  return prisma.user.update({
    where: {
      id: userId,
    },
    data,
  });
};

const updateEmployeeUserProfile = async (userId, data) => {
  return prisma.user.update({
    where: { id: userId },
    data,
  });
};

const updateAccountProfile = async (userId, data) => {
  return prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      profileImage: true,
      roles: { include: { role: true } },
    },
  });
};
const findRefreshTokenForSession = async ({ tokenHash, sessionSelectorHash }) => {
  return prisma.refreshToken.findUnique({
    where: {
      tokenHash,
    },
    include: {
      user: {
        include: {
          roles: {
            include: {
              role: true,
            },
          },
          employeeProfile: true,
          recruiterProfile: true,
          subscriptions: { include: { plan: true } },
          organizationMemberships: {
            include: { organization: { include: { subscriptions: true } } },
          },
        },
      },
      loginSession: true,
    },
  }).then((refreshToken) => {
    if (
      !refreshToken ||
      !refreshToken.loginSession ||
      refreshToken.loginSession.sessionSelectorHash !== sessionSelectorHash
    ) {
      return null;
    }

    return refreshToken;
  });
};

const rotateRefreshToken = async ({
  refreshTokenId,
  loginSessionId,
  userId,
  tokenHash,
  expiresAt,
}) => {
  return prisma.$transaction(async (tx) => {
    // The conditional update prevents two refresh requests from rotating the
    // same credential. A caller that loses this race is handled as reuse.
    const consumed = await tx.refreshToken.updateMany({
      where: {
        id: refreshTokenId,
        loginSessionId,
        revoked: false,
      },
      data: {
        revoked: true,
        usedAt: new Date(),
        revokedAt: new Date(),
      },
    });

    if (consumed.count !== 1) {
      return null;
    }

    const replacement = await tx.refreshToken.create({
      data: {
        tokenHash,
        userId,
        loginSessionId,
        expiresAt,
      },
    });

    await tx.refreshToken.update({
      where: { id: refreshTokenId },
      data: { replacedById: replacement.id },
    });

    await tx.loginSession.update({
      where: { id: loginSessionId },
      data: { lastActive: new Date() },
    });

    return replacement;
  });
};

const revokeLoginSession = async (loginSessionId) => {
  return prisma.$transaction(async (tx) => {
    await tx.loginSession.updateMany({
      where: { id: loginSessionId, revokedAt: null },
      data: { revokedAt: new Date(), lastActive: new Date() },
    });

    await tx.refreshToken.updateMany({
      where: { loginSessionId, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
  });
};
const deleteVerificationTokens = async (userId) => {
  return prisma.emailVerificationToken.deleteMany({
    where: {
      userId,
    },
  });
};


const createVerificationToken = async ({
  userId,
  tokenHash,
  expiresAt,
}) => {
  return prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });
};

const deletePasswordResetTokens = async (userId) => {
  return prisma.passwordResetToken.deleteMany({
    where: {
      userId,
    },
  });
};

const createPasswordResetToken = async ({
  userId,
  tokenHash,
  expiresAt,
}) => {
  return prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });
};

const findPasswordResetToken = async (tokenHash) => {
  return prisma.passwordResetToken.findUnique({
    where: {
      tokenHash,
    },
    include: {
      user: true,
    },
  });
};

const markPasswordResetTokenUsed = async (tokenId) => {
  return prisma.passwordResetToken.update({
    where: {
      id: tokenId,
    },
    data: {
      used: true,
    },
  });
};

// Most recent PASSWORD_HISTORY_DEPTH history rows for a user, newest first —
// used by assertPasswordNotReused (auth.service.js) to compare a candidate
// password against.
const findRecentPasswordHistory = async (userId, limit = PASSWORD_HISTORY_DEPTH) => {
  return prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
};

// Deletes PasswordHistory rows for `userId` beyond the most recent
// PASSWORD_HISTORY_DEPTH (by createdAt). Called from inside the same
// transaction as the write that just added a row, so the table never grows
// unboundedly per user — nothing ever reads further back than
// PASSWORD_HISTORY_DEPTH anyway. `tx` is required (not defaulted to
// `prisma`) since this only makes sense paired with the create it follows.
const prunePasswordHistory = async (tx, userId) => {
  const stale = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: PASSWORD_HISTORY_DEPTH,
    select: { id: true },
  });

  if (stale.length === 0) {
    return;
  }

  await tx.passwordHistory.deleteMany({
    where: { id: { in: stale.map((row) => row.id) } },
  });
};

// Any successful, real password-set (forgot/reset password here, or the
// authenticated change-password flow) ends a forced temporary-password
// state — mustChangePassword is always cleared, regardless of which path
// got here. This is a no-op for the vast majority of users, who never had
// it set in the first place.
//
// Also records the new hash in PasswordHistory and prunes anything beyond
// the last PASSWORD_HISTORY_DEPTH — previously this function only updated
// User.passwordHash, so reset/change-password never grew history past
// whatever row registration (or, for org recruiters, provisioning) created.
const updateUserPassword = async (userId, passwordHash) => {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: {
        id: userId,
      },
      data: {
        passwordHash,
        lastPasswordChanged: new Date(),
        mustChangePassword: false,
      },
    });

    await tx.passwordHistory.create({ data: { userId, passwordHash } });
    await prunePasswordHistory(tx, userId);

    return user;
  });
};

module.exports = {
  findUserByEmail,
  findUsersByEmail,
  findRoleByName,
  findUserById,
  findUserRole,
  findRecruiterProfileByUserId,
  upsertRecruiterProfile,
  findEmployeeProfileByUserId,
  saveEmployeeProfile,
  ensureEmployeeProfile,
  getEmployeeProfileWithRelations,
  updateEmployeeProfileData,
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
  findVerificationToken,
  verifyUserEmail,
  createAuthenticatedSession,
  updateLoginSecurity,
  updateEmployeeUserProfile,
  updateAccountProfile,
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
  prunePasswordHistory,
  getRequiredRegistrationRoleNames,
  PASSWORD_HISTORY_DEPTH,
};
