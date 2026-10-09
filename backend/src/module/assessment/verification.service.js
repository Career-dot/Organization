const {
  findOwnedReportWithEvidence,
  updateReportProcessingStatus,
  saveVerificationAnalysisResults,
} = require("./verification.repository");
const { analyzeVerification } = require("../../services/ai/verificationAnalyzer");
const { createIdempotentNotification } = require("../notification/notification.service");

const toCandidateSafeReport = (report) => ({
  reportId: report.id,
  verificationAttemptId: report.verificationAttemptId,
  skillId: report.employeeProfileSkillId,
  processingStatus: report.processingStatus,
  verificationStatus: report.verificationStatus,
  verificationScore:
    report.verificationScore !== null ? Number(report.verificationScore) : null,
  confidenceScore:
    report.confidenceScore !== null ? Number(report.confidenceScore) : null,
  aiSummary: report.aiSummary,
  strengths: report.strengths || [],
  areasToImprove: report.areasToImprove || [],
  completedAt: report.completedAt,
});

const analyzeCandidateVerification = async ({
  userId,
  skillId,
  attemptId,
  forceRetry = false,
}) => {
  // 1. Fetch candidate's prepared report and evidence list
  const report = await findOwnedReportWithEvidence({ userId, skillId, attemptId });

  if (!report) {
    const error = new Error("No prepared verification evidence/report found for this skill");
    error.status = 404;
    throw error;
  }

  // 2. Check Idempotency: if report is COMPLETED and forceRetry is not set, return existing completed report
  if (report.processingStatus === "COMPLETED" && !forceRetry) {
    return toCandidateSafeReport(report);
  }

  // 3. Set status to PROCESSING
  await updateReportProcessingStatus(report.id, "PROCESSING");

  // 4. Construct normalized AI analyzer input from stored evidence snapshots & testPerformance
  const attempt = report.verificationAttempt;
  const skill = attempt?.employeeProfileSkill;

  const normalizedInput = {
    skill: {
      id: skill?.id || report.employeeProfileSkillId,
      name: attempt?.skillNameSnapshot || "Skill",
      category: skill?.category || attempt?.assessmentDefinition?.skillCategorySnapshot || "General",
      proficiency: attempt?.claimedProficiencySnapshot || "INTERMEDIATE",
      yearsOfExperience: attempt?.yearsOfExperienceSnapshot ?? 3,
    },
    testPerformance: {
      testScorePoints: attempt?.testScorePoints ?? report.testPerformance?.testScorePoints,
      testScoreMaxPoints: attempt?.testScoreMaxPoints ?? report.testPerformance?.testScoreMaxPoints,
      evaluableMaxPoints: attempt?.evaluableMaxPoints ?? report.testPerformance?.evaluableMaxPoints ?? attempt?.testScoreMaxPoints,
      testScorePercentage:
        attempt?.testScorePercentage !== null ? Number(attempt.testScorePercentage) : (report.testPerformance?.testScorePercentage ?? null),
      status: attempt?.status ?? report.testPerformance?.status,
      isFullyEvaluated: attempt?.isFullyEvaluated ?? report.testPerformance?.isFullyEvaluated ?? true,
    },
    evidenceList: (report.evidence || []).map((ev) => ({
      id: ev.id,
      sourceId: ev.sourceId,
      evidenceType: ev.evidenceType,
      snapshot: ev.snapshot,
    })),
  };

  // 5. Invoke AI Verification Analyzer
  let analysisResponse;
  try {
    analysisResponse = await analyzeVerification(normalizedInput);
  } catch (aiError) {
    // Mark processingStatus = FAILED without corrupting evidence snapshots
    await updateReportProcessingStatus(report.id, "FAILED");
    throw aiError;
  }

  // 6. Save analysis results transactionally
  const updatedReport = await saveVerificationAnalysisResults({
    reportId: report.id,
    analysisResult: analysisResponse.result,
    aiModel: analysisResponse.provider,
    promptVersion: "v1.0",
  });

  // 7. Create idempotent notification for completed verification
  try {
    const skillName = skill?.name || "Skill";
    await createIdempotentNotification({
      userId,
      title: "Verification Result Ready",
      message: `Your ${skillName} skill verification result is ready.`,
      type: "VERIFICATION_RESULT",
      link: `/employee/skills/${skillId}/verify/report/${updatedReport.id}`,
    });
  } catch (_notifErr) {
    // Silently continue on notification error so main report completion is never blocked
  }

  return toCandidateSafeReport(updatedReport);
};

module.exports = {
  analyzeCandidateVerification,
};


