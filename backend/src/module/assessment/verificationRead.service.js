const {
  findSkillWithVerificationContext,
  findLatestCompletedReportDetails,
  findActiveAttemptForSkill,
  findCandidateDashboardVerificationSummaries,
  findLatestCompletedReportsForUsers,
} = require("./verificationRead.repository");

const checkVerificationEligibility = async ({ userId, skillId }) => {
  const context = await findSkillWithVerificationContext({ userId, skillId });

  if (!context) {
    const error = new Error("Candidate skill not found");
    error.status = 404;
    throw error;
  }

  const {
    skill,
    latestCompletedReport,
    activeAttempt,
    processingReport,
    priorCancelledAttempts = [],
    violationTerminatedAttempts = [],
  } = context;

  const hasCompletedVerification = !!latestCompletedReport;
  const hasActiveAttempt = !!activeAttempt;
  const processing = !!processingReport;

  // 1. Calculate 7-day block status from voluntary cancellations
  let isCancelBlocked = false;
  let cancelBlockedUntil = null;
  let remainingCancelCount = Math.max(0, 3 - priorCancelledAttempts.length);
  let cancelRemainingText = null;

  if (priorCancelledAttempts.length >= 3) {
    const thirdCancelTime = new Date(priorCancelledAttempts[2].updatedAt || priorCancelledAttempts[2].createdAt).getTime();
    const blockUntilMs = thirdCancelTime + 7 * 24 * 60 * 60 * 1000;
    if (Date.now() < blockUntilMs) {
      isCancelBlocked = true;
      cancelBlockedUntil = new Date(blockUntilMs).toISOString();
      remainingCancelCount = 0;
      const diffMs = blockUntilMs - Date.now();
      const days = Math.floor(diffMs / (24 * 3600 * 1000));
      const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
      cancelRemainingText = `${days} days ${hours} hours`;
    }
  }

  // 2. Calculate 7-day block status from anti-cheating violations
  let isCheatingBlocked = false;
  let cheatingBlockedUntil = null;
  let cheatingRemainingText = null;

  if (violationTerminatedAttempts.length > 0) {
    const latestViolationTime = new Date(violationTerminatedAttempts[0].updatedAt || violationTerminatedAttempts[0].createdAt).getTime();
    const blockUntilMs = latestViolationTime + 7 * 24 * 60 * 60 * 1000;
    if (Date.now() < blockUntilMs) {
      isCheatingBlocked = true;
      cheatingBlockedUntil = new Date(blockUntilMs).toISOString();
      const diffMs = blockUntilMs - Date.now();
      const days = Math.floor(diffMs / (24 * 3600 * 1000));
      const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
      cheatingRemainingText = `${days} days ${hours} hours`;
    }
  }

  const isBlocked = isCancelBlocked || isCheatingBlocked;

  let eligible = false;
  let reason = "NO_RELEVANT_CHANGES";

  if (isBlocked) {
    eligible = false;
    reason = "TEMPORARILY_BLOCKED";
  } else if (hasActiveAttempt) {
    eligible = false;
    reason = "ATTEMPT_IN_PROGRESS";
  } else if (processing) {
    eligible = false;
    reason = "VERIFICATION_PROCESSING";
  } else if (!hasCompletedVerification) {
    eligible = true;
    reason = "NO_PREVIOUS_VERIFICATION";
  } else {
    // Compare timestamps of relevant sources against latest completed report time
    const reportTime = new Date(latestCompletedReport.completedAt || latestCompletedReport.createdAt).getTime();

    const isSkillUpdated = new Date(skill.updatedAt).getTime() > reportTime;

    // Relevant projects
    const relevantProjects = (skill.employeeProfile?.projects || []).filter((p) =>
      p.projectSkills.some((ps) => ps.skillId === skill.id)
    );
    const isProjectUpdated = relevantProjects.some(
      (p) => new Date(p.updatedAt).getTime() > reportTime
    );

    // Relevant certificates
    const relevantCerts = (skill.employeeProfile?.certificates || []).filter(
      (c) => c.skillId === skill.id
    );
    const isCertUpdated = relevantCerts.some(
      (c) => new Date(c.updatedAt).getTime() > reportTime
    );

    // Files (direct skill evidence, project files, cert files, resume)
    const files = skill.employeeProfile?.files || [];
    const relProjectIds = new Set(relevantProjects.map((p) => p.id));
    const relCertIds = new Set(relevantCerts.map((c) => c.id));

    const isFileUpdated = files.some((f) => {
      const isRelFile =
        f.skillId === skill.id ||
        (f.projectId && relProjectIds.has(f.projectId)) ||
        (f.certificateId && relCertIds.has(f.certificateId)) ||
        (f.category === "SKILL_EVIDENCE" && (f.originalName || "").toLowerCase().includes("resume"));

      if (!isRelFile) return false;
      const fileTime = new Date(f.updatedAt || f.createdAt).getTime();
      return fileTime > reportTime;
    });

    // Profile data (GitHub / LinkedIn)
    const profileTime = new Date(skill.employeeProfile?.updatedAt || 0).getTime();
    const isProfileUpdated = profileTime > reportTime;

    const hasRelevantChanges =
      isSkillUpdated || isProjectUpdated || isCertUpdated || isFileUpdated || isProfileUpdated;

    if (hasRelevantChanges) {
      eligible = true;
      reason = "RELEVANT_DATA_UPDATED";
    } else {
      eligible = false;
      reason = "NO_RELEVANT_CHANGES";
    }
  }

  return {
    skillId,
    candidateActivated: true,
    hasCompletedVerification,
    hasActiveAttempt,
    activeAttemptId: activeAttempt?.id || null,
    processing,
    processingAttemptId: processingReport?.verificationAttemptId || null,
    eligible,
    reason,
    cancellationInfo: {
      cancellationCount: Math.min(3, priorCancelledAttempts.length),
      remainingCancelCount,
      isBlocked: isCancelBlocked,
      blockedUntil: cancelBlockedUntil,
      blockedRemainingText: cancelRemainingText,
    },
    antiCheatingInfo: {
      hasViolationTermination: violationTerminatedAttempts.length > 0,
      isBlocked: isCheatingBlocked,
      blockedUntil: cheatingBlockedUntil,
      blockedRemainingText: cheatingRemainingText,
    },
    latestReport: latestCompletedReport
      ? {
          id: latestCompletedReport.id,
          verificationScore:
            latestCompletedReport.verificationScore !== null
              ? Number(latestCompletedReport.verificationScore)
              : null,
          confidenceScore:
            latestCompletedReport.confidenceScore !== null
              ? Number(latestCompletedReport.confidenceScore)
              : null,
          verificationStatus: latestCompletedReport.verificationStatus,
          completedAt: latestCompletedReport.completedAt,
        }
      : null,
  };
};

const getLatestReportForSkill = async ({ userId, skillId }) => {
  const report = await findLatestCompletedReportDetails({ userId, skillId });

  if (!report) {
    const error = new Error("No completed verification report found for this skill");
    error.status = 404;
    throw error;
  }

  const attempt = report.verificationAttempt;
  const questions = attempt?.assessmentDefinition?.questions || [];

  // Group evidence items by type
  const evidenceGrouped = {
    RESUME: [],
    GITHUB: [],
    LINKEDIN: [],
    PROJECT: [],
    CERTIFICATE: [],
    SKILL_EVIDENCE_FILE: [],
    OTHER: [],
  };

  (report.evidence || []).forEach((item) => {
    const safeItem = {
      id: item.id,
      sourceId: item.sourceId,
      evidenceType: item.evidenceType,
      snapshot: item.snapshot,
      relevanceScore: item.relevance !== null ? Number(item.relevance) : null,
      analysisSummary: item.analysisSummary,
    };

    if (evidenceGrouped[item.evidenceType]) {
      evidenceGrouped[item.evidenceType].push(safeItem);
    } else {
      evidenceGrouped.OTHER.push(safeItem);
    }
  });

  // Calculate evaluable metrics for assessment performance
  const evaluableMaxPoints = attempt?.evaluableMaxPoints ?? attempt?.testScoreMaxPoints ?? 0;
  const pendingMaxPoints = attempt?.pendingMaxPoints ?? 0;
  const pendingQuestionCount = attempt?.pendingQuestionCount ?? 0;
  const isFullyEvaluated = attempt?.isFullyEvaluated ?? (pendingQuestionCount === 0);

  return {
    verificationOverview: {
      reportId: report.id,
      verificationAttemptId: report.verificationAttemptId,
      skillId: report.employeeProfileSkillId,
      verificationScore:
        report.verificationScore !== null ? Number(report.verificationScore) : null,
      confidenceScore:
        report.confidenceScore !== null ? Number(report.confidenceScore) : null,
      verificationStatus: report.verificationStatus,
      completedAt: report.completedAt,
    },
    assessmentPerformance: {
      // Claim snapshots from VerificationAttempt (persisted at attempt-start time)
      skillNameSnapshot: attempt?.skillNameSnapshot || null,
      claimedProficiencySnapshot: attempt?.claimedProficiencySnapshot || null,
      yearsOfExperienceSnapshot: attempt?.yearsOfExperienceSnapshot ?? null,
      // Test score metrics
      testScorePoints: attempt?.testScorePoints ?? 0,
      evaluableMaxPoints,
      testScoreMaxPoints: attempt?.testScoreMaxPoints ?? 0,
      pendingMaxPoints,
      pendingQuestionCount,
      testScorePercentage:
        attempt?.testScorePercentage !== null ? Number(attempt.testScorePercentage) : null,
      isFullyEvaluated,
      status: attempt?.status,
    },
    evidenceGrouped,
    aiAnalysis: {
      aiSummary: report.aiSummary,
      strengths: report.strengths || [],
      areasToImprove: report.areasToImprove || [],
      claimAssessment: report.testPerformance?.claimAssessment || null,
      technicalDepthAnalysis: report.testPerformance?.technicalDepthAnalysis || null,
      consistencyAnalysis: report.testPerformance?.consistencyAnalysis || null,
    },
  };
};

const getActiveAttemptForSkill = async ({ userId, skillId }) => {
  const attempt = await findActiveAttemptForSkill({ userId, skillId });
  if (!attempt) return null;

  const definitionQuestions = attempt.assessmentDefinition?.questions || [];
  const safeQuestions = definitionQuestions.map((q) => ({
    id: q.id,
    questionOrder: q.questionOrder,
    questionType: q.questionType,
    prompt: q.prompt,
    points: q.points,
    options: Array.isArray(q.options)
      ? q.options.map((opt) => ({ id: opt.id, text: opt.text }))
      : null,
  }));

  const savedAnswersMap = new Map();
  (attempt.answers || []).forEach((ans) => {
    savedAnswersMap.set(ans.questionId, ans.answer);
  });

  return {
    attemptId: attempt.id,
    assessmentId: attempt.assessmentDefinitionId,
    assessmentVersion: attempt.assessmentDefinition?.version || 1,
    deadlineAt: attempt.deadlineAt,
    status: attempt.status,
    questions: safeQuestions,
    savedAnswers: Array.from(savedAnswersMap.entries()).map(([questionId, answer]) => ({
      questionId,
      answer,
    })),
  };
};

const COUNTED_VERIFIED_STATUSES = new Set(["VERIFIED", "HIGHLY_VERIFIED"]);

const emptyVerificationSummary = () => ({
  skills: [],
  preferredRoles: [],
  alignmentScore: null,
  alignmentScoreReason: "Scoring formula for overall preferred-role alignment has not been finalized.",
});

const withVerificationTotals = (summary) => {
  const skills = summary.skills ?? [];
  const totalSkills = skills.length;
  const verifiedSkillsCount = skills.filter((skill) =>
    COUNTED_VERIFIED_STATUSES.has(skill.verificationStatus)
  ).length;
  const verificationRate =
    totalSkills === 0 ? 0 : Math.round((verifiedSkillsCount / totalSkills) * 100);

  return {
    ...summary,
    totalSkills,
    verifiedSkillsCount,
    verificationRate,
  };
};

const getDashboardVerificationSummary = async (userId) => {
  const summary = await findCandidateDashboardVerificationSummaries(userId);
  return withVerificationTotals(summary ?? emptyVerificationSummary());
};

// ---------------------------------------------------------------------------
// Existing verified skill score — RECRUITER VISIBILITY ONLY
// ---------------------------------------------------------------------------
// Projects the candidate's ALREADY-COMPUTED skill verification results for the
// recruiter candidate workflow. This function:
//   * does NOT start or repeat any verification,
//   * does NOT fetch LinkedIn/GitHub/project evidence,
//   * does NOT call any AI service,
//   * does NOT reinterpret the stored per-skill score,
//   * does NOT mix in anything else (assessment scores are separate).
//
// The single headline number is a read-only aggregate over values that are
// already persisted on VerificationReport (the mean of the candidate's latest
// COMPLETED score per skill, rounded to whole percent — the same
// display-aggregation pattern as withVerificationTotals). It is null when the
// candidate has no completed verification at all: an absent score is reported
// as absent, never fabricated as 0.
//
// The per-skill breakdown is returned alongside it so the caller (and the
// recruiter UI) sees the underlying stored values, not just a derived number.
const getExistingVerifiedSkillScoresForUsers = async (userIds) => {
  const reports = await findLatestCompletedReportsForUsers(userIds);
  const byUserId = {};

  for (const report of reports) {
    const userId = report.verificationAttempt.userId;
    const bucket = byUserId[userId] ?? (byUserId[userId] = { skills: [] });
    const score =
      report.verificationScore !== null && report.verificationScore !== undefined
        ? Number(report.verificationScore)
        : null;
    if (score === null) continue;
    bucket.skills.push({
      skillName: report.employeeProfileSkill?.name ?? null,
      score,
      verificationStatus: report.verificationStatus,
      confidenceScore:
        report.confidenceScore !== null && report.confidenceScore !== undefined
          ? Number(report.confidenceScore)
          : null,
      completedAt: report.completedAt ?? report.createdAt ?? null,
      aiSummary: report.aiSummary ?? null,
      strengths: Array.isArray(report.strengths) ? report.strengths : [],
      areasToImprove: Array.isArray(report.areasToImprove) ? report.areasToImprove : [],
    });
  }

  const projection = {};
  for (const [userId, bucket] of Object.entries(byUserId)) {
    const scores = bucket.skills.map((skill) => skill.score);
    const average =
      scores.length === 0
        ? null
        : Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
    projection[userId] = {
      existingVerifiedSkillScore: average,
      verifiedSkillCount: scores.length,
      verifiedSkills: bucket.skills,
    };
  }
  return projection;
};

module.exports = {
  checkVerificationEligibility,
  getLatestReportForSkill,
  getActiveAttemptForSkill,
  getDashboardVerificationSummary,
  getExistingVerifiedSkillScoresForUsers,
};
