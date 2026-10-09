const prisma = require("../../config/prisma");

/**
 * Finds candidate owned skill and relational data needed for eligibility calculation
 */
const findSkillWithVerificationContext = async ({ userId, skillId }) => {
  const skill = await prisma.employeeProfileSkill.findFirst({
    where: {
      id: skillId,
      employeeProfile: {
        userId,
      },
    },
    include: {
      employeeProfile: {
        include: {
          files: true,
          projects: {
            include: {
              projectSkills: true,
            },
          },
          certificates: true,
        },
      },
    },
  });

  if (!skill) return null;

  // Latest completed report
  const latestCompletedReport = await prisma.verificationReport.findFirst({
    where: {
      employeeProfileSkillId: skillId,
      processingStatus: "COMPLETED",
      verificationAttempt: {
        userId,
      },
    },
    orderBy: { completedAt: "desc" },
    include: {
      verificationAttempt: true,
    },
  });

  // Active attempt (IN_PROGRESS and deadline in future)
  const activeAttempt = await prisma.verificationAttempt.findFirst({
    where: {
      employeeProfileSkillId: skillId,
      userId,
      status: "IN_PROGRESS",
      deadlineAt: {
        gt: new Date(),
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Active processing report (NOT_STARTED or PROCESSING)
  let processingReport = await prisma.verificationReport.findFirst({
    where: {
      employeeProfileSkillId: skillId,
      processingStatus: {
        in: ["NOT_STARTED", "PROCESSING"],
      },
      verificationAttempt: {
        userId,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // If no processing report row exists yet, check for pending SUBMITTED/SCORED attempt without report newer than latest completed report
  if (!processingReport) {
    const reportTime = latestCompletedReport ? new Date(latestCompletedReport.completedAt || latestCompletedReport.createdAt) : new Date(0);

    const pendingAttempt = await prisma.verificationAttempt.findFirst({
      where: {
        employeeProfileSkillId: skillId,
        userId,
        status: { in: ["SUBMITTED", "SCORED"] },
        createdAt: { gt: reportTime },
        verificationReport: { is: null },
      },
      orderBy: { createdAt: "desc" },
    });

    if (pendingAttempt) {
      processingReport = {
        id: `pending_${pendingAttempt.id}`,
        verificationAttemptId: pendingAttempt.id,
        employeeProfileSkillId: skillId,
        processingStatus: "PROCESSING",
        createdAt: pendingAttempt.createdAt,
      };
    }
  }

  // Prior cancelled attempts for candidate skill (Hard Block Rule)
  const priorCancelledAttempts = await prisma.verificationAttempt.findMany({
    where: {
      userId,
      OR: [
        { employeeProfileSkillId: skillId },
        { skillNameSnapshot: { equals: skill.name, mode: "insensitive" } },
      ],
      status: "CANCELLED",
    },
    orderBy: { updatedAt: "desc" },
  });

  // Prior violation terminated attempts for candidate skill (Hard Block Rule)
  const violationTerminatedAttempts = await prisma.verificationAttempt.findMany({
    where: {
      userId,
      OR: [
        { employeeProfileSkillId: skillId },
        { skillNameSnapshot: { equals: skill.name, mode: "insensitive" } },
      ],
      status: "VIOLATION_TERMINATED",
    },
    orderBy: { updatedAt: "desc" },
  });

  return {
    skill,
    latestCompletedReport,
    activeAttempt,
    processingReport,
    priorCancelledAttempts,
    violationTerminatedAttempts,
  };
};

/**
 * Gets candidate's latest completed report with grouped evidence
 */
const findLatestCompletedReportDetails = async ({ userId, skillId }) => {
  const report = await prisma.verificationReport.findFirst({
    where: {
      employeeProfileSkillId: skillId,
      processingStatus: "COMPLETED",
      verificationAttempt: {
        userId,
      },
    },
    orderBy: { completedAt: "desc" },
    include: {
      verificationAttempt: {
        include: {
          assessmentDefinition: {
            include: {
              questions: true,
            },
          },
          answers: true,
          employeeProfileSkill: true,
        },
      },
      evidence: true,
    },
  });

  return report;
};

/**
 * Gets candidate's active attempt details for recovery after page refresh
 */
const findActiveAttemptForSkill = async ({ userId, skillId }) => {
  let attempt = await prisma.verificationAttempt.findFirst({
    where: {
      employeeProfileSkillId: skillId,
      userId,
      status: "IN_PROGRESS",
      deadlineAt: {
        gt: new Date(),
      },
    },
    orderBy: { createdAt: "desc" },
    include: {
      assessmentDefinition: {
        include: {
          questions: {
            orderBy: { questionOrder: "asc" },
          },
        },
      },
      answers: true,
    },
  });

  if (!attempt) {
    attempt = await prisma.verificationAttempt.findFirst({
      where: {
        employeeProfileSkillId: skillId,
        userId,
        status: { in: ["SUBMITTED", "SCORED"] },
        verificationReport: null,
      },
      orderBy: { createdAt: "desc" },
      include: {
        assessmentDefinition: {
          include: {
            questions: {
              orderBy: { questionOrder: "asc" },
            },
          },
        },
        answers: true,
      },
    });
  }

  return attempt;
};

/**
 * Gets candidate's completed verification reports for dashboard summary
 */
const findCandidateDashboardVerificationSummaries = async (userId) => {
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    include: {
      skills: true,
    },
  });

  if (!profile) return null;

  const completedReports = await prisma.verificationReport.findMany({
    where: {
      verificationAttempt: {
        userId,
      },
      processingStatus: "COMPLETED",
    },
    orderBy: { completedAt: "desc" },
    include: {
      employeeProfileSkill: true,
    },
  });

  // Group by skillId to get latest completed report per skill
  const latestReportBySkillId = new Map();
  for (const report of completedReports) {
    if (!latestReportBySkillId.has(report.employeeProfileSkillId)) {
      latestReportBySkillId.set(report.employeeProfileSkillId, report);
    }
  }

  const profileData = profile.profileData && typeof profile.profileData === "object" ? profile.profileData : {};
  const preferredRoles = profileData?.jobPreferences?.preferredRole
    ? Array.isArray(profileData.jobPreferences.preferredRole)
      ? profileData.jobPreferences.preferredRole
      : [profileData.jobPreferences.preferredRole]
    : [];

  const verifiedSkillsSummary = (profile.skills || []).map((skill) => {
    const report = latestReportBySkillId.get(skill.id);
    return {
      skillId: skill.id,
      skillName: skill.name,
      category: skill.category,
      proficiency: skill.proficiency,
      yearsOfExperience: skill.yearsOfExperience,
      hasCompletedVerification: !!report,
      verificationScore: report && report.verificationScore !== null && report.verificationScore !== undefined ? Number(report.verificationScore) : null,
      confidenceScore: report && report.confidenceScore !== null && report.confidenceScore !== undefined ? Number(report.confidenceScore) : null,
      verificationStatus: report?.verificationStatus || "PENDING",
      completedAt: report?.completedAt || null,
    };
  });

  return {
    skills: verifiedSkillsSummary,
    preferredRoles,
    alignmentScore: null,
    alignmentScoreReason: "Scoring formula for overall preferred-role alignment has not been finalized.",
  };
};

// ---------------------------------------------------------------------------
// Batch read for the recruiter candidate workflow (Phase: classification).
// ---------------------------------------------------------------------------
// Returns the latest COMPLETED verification report per (candidate user, skill)
// for many users at once, so a job's whole candidate list can be classified
// with ONE query. STRICTLY READ-ONLY: no verification attempt is started, no
// evidence is fetched, no AI is called and no score is recomputed — the
// returned rows ARE the already-persisted VerificationReport values from the
// candidate's earlier verification process.
const findLatestCompletedReportsForUsers = async (userIds) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }

  const reports = await prisma.verificationReport.findMany({
    where: {
      processingStatus: "COMPLETED",
      verificationScore: { not: null },
      verificationAttempt: { userId: { in: userIds } },
    },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      employeeProfileSkillId: true,
      verificationScore: true,
      confidenceScore: true,
      verificationStatus: true,
      aiSummary: true,
      strengths: true,
      areasToImprove: true,
      completedAt: true,
      createdAt: true,
      verificationAttempt: { select: { userId: true } },
      employeeProfileSkill: { select: { name: true } },
    },
  });

  // Newest report per (user, skill) wins; the ordering above makes the first
  // row seen for a key the most recent one.
  const latestByUserAndSkill = new Map();
  for (const report of reports) {
    const key = `${report.verificationAttempt.userId}::${report.employeeProfileSkillId}`;
    if (!latestByUserAndSkill.has(key)) {
      latestByUserAndSkill.set(key, report);
    }
  }
  return [...latestByUserAndSkill.values()];
};

module.exports = {
  findSkillWithVerificationContext,
  findLatestCompletedReportDetails,
  findActiveAttemptForSkill,
  findCandidateDashboardVerificationSummaries,
  findLatestCompletedReportsForUsers,
};
