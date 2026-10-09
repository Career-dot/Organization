const prisma = require("../../config/prisma");

/**
 * Finds candidate's VerificationReport and associated Evidence snapshots ensuring candidate ownership
 */
const findOwnedReportWithEvidence = async ({ userId, skillId, attemptId }) => {
  const where = {
    employeeProfileSkillId: skillId,
    verificationAttempt: {
      userId,
    },
  };

  if (attemptId) {
    where.verificationAttemptId = attemptId;
  }

  const report = await prisma.verificationReport.findFirst({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      verificationAttempt: {
        include: {
          employeeProfileSkill: true,
        },
      },
      evidence: true,
    },
  });

  return report;
};

/**
 * Updates processing status of VerificationReport (e.g. PROCESSING, FAILED)
 */
const updateReportProcessingStatus = async (reportId, status) => {
  return prisma.verificationReport.update({
    where: { id: reportId },
    data: {
      processingStatus: status,
    },
  });
};

/**
 * Transactionally saves AI verification analysis results
 */
const saveVerificationAnalysisResults = async ({
  reportId,
  analysisResult,
  aiModel,
  promptVersion,
}) => {
  return prisma.$transaction(async (transaction) => {
    const {
      verificationScore,
      confidenceScore,
      verificationStatus,
      aiSummary,
      strengths,
      areasToImprove,
      claimAssessment,
      technicalDepthAnalysis,
      consistencyAnalysis,
      evidenceAnalyses,
    } = analysisResult;

    // Fetch existing report to merge structured analysis into testPerformance JSON
    const currentReport = await transaction.verificationReport.findUnique({
      where: { id: reportId },
    });

    const updatedTestPerformance = {
      ...(typeof currentReport?.testPerformance === "object" && currentReport.testPerformance !== null
        ? currentReport.testPerformance
        : {}),
      claimAssessment: claimAssessment || null,
      technicalDepthAnalysis: technicalDepthAnalysis || null,
      consistencyAnalysis: consistencyAnalysis || null,
    };

    // 1. Update VerificationReport
    const updatedReport = await transaction.verificationReport.update({
      where: { id: reportId },
      data: {
        processingStatus: "COMPLETED",
        verificationStatus,
        verificationScore,
        confidenceScore,
        aiSummary,
        strengths,
        areasToImprove,
        testPerformance: updatedTestPerformance,
        aiModel,
        promptVersion: promptVersion || "v2.0",
        completedAt: new Date(),
      },
      include: {
        evidence: true,
        verificationAttempt: true,
      },
    });

    // 2. Update individual VerificationEvidence records
    const evidenceMap = new Map(updatedReport.evidence.map((e) => [e.sourceId, e]));

    for (const itemAnalysis of evidenceAnalyses || []) {
      const existingEvidence = evidenceMap.get(itemAnalysis.sourceId);
      if (existingEvidence) {
        await transaction.verificationEvidence.update({
          where: { id: existingEvidence.id },
          data: {
            relevance: itemAnalysis.relevanceScore,
            analysisSummary: itemAnalysis.analysisSummary,
          },
        });
      }
    }

    return updatedReport;
  });
};

module.exports = {
  findOwnedReportWithEvidence,
  updateReportProcessingStatus,
  saveVerificationAnalysisResults,
};

