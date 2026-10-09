const crypto = require("crypto");
const prisma = require("../../config/prisma");

const generateContentHash = (snapshot) => {
  const jsonStr = JSON.stringify(snapshot);
  return crypto.createHash("sha256").update(jsonStr).digest("hex");
};

/**
 * Finds candidate skill by userId and skillId ensuring ownership
 */
const findOwnedCandidateSkillWithEvidenceSources = async (userId, skillId) => {
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    include: {
      skills: {
        where: { id: skillId },
      },
      projects: {
        include: {
          projectSkills: true,
          storedFiles: true,
        },
      },
      certificates: {
        include: {
          files: true,
        },
      },
      files: true,
    },
  });

  if (!profile || profile.skills.length === 0) {
    return null;
  }

  const skill = profile.skills[0];

  // Filter projects explicitly associated with this skillId via projectSkills
  const relevantProjects = profile.projects.filter((project) =>
    project.projectSkills.some((ps) => ps.skillId === skill.id)
  );

  // Filter certificates explicitly associated with this skillId
  const relevantCertificates = profile.certificates.filter(
    (cert) => cert.skillId === skill.id
  );

  // Direct skill evidence files
  const directSkillFiles = profile.files.filter((f) => f.skillId === skill.id);

  // Project files linked to relevant projects
  const relevantProjectIds = new Set(relevantProjects.map((p) => p.id));
  const projectFiles = profile.files.filter(
    (f) => f.projectId && relevantProjectIds.has(f.projectId)
  );

  // Certificate files linked to relevant certificates
  const relevantCertIds = new Set(relevantCertificates.map((c) => c.id));
  const certFiles = profile.files.filter(
    (f) => f.certificateId && relevantCertIds.has(f.certificateId)
  );

  // Resume file
  const resumeFile = profile.files.find(
    (f) =>
      f.category === "SKILL_EVIDENCE" &&
      (f.originalName?.toLowerCase().includes("resume") ||
        f.storedName?.toLowerCase().includes("resume"))
  ) || profile.files.find((f) => f.originalName?.toLowerCase().includes("resume"));

  return {
    profile,
    skill,
    relevantProjects,
    relevantCertificates,
    directSkillFiles,
    projectFiles,
    certFiles,
    resumeFile: resumeFile || null,
  };
};

/**
 * Finds valid scored VerificationAttempt for candidate & skill
 */
const findValidScoredAttempt = async ({ userId, skillId, attemptId }) => {
  const where = {
    userId,
    employeeProfileSkillId: skillId,
    status: "SCORED",
  };

  if (attemptId) {
    where.id = attemptId;
  }

  const attempt = await prisma.verificationAttempt.findFirst({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      assessmentDefinition: true,
      answers: true,
    },
  });

  return attempt;
};

/**
 * Upserts VerificationReport and Evidence Snapshots inside a transaction
 */
const createOrUpdateEvidenceSnapshots = async ({
  attempt,
  skill,
  evidenceItems,
  testPerformance,
}) => {
  return prisma.$transaction(async (transaction) => {
    // 1. Find or create VerificationReport for attempt
    let report = await transaction.verificationReport.findUnique({
      where: { verificationAttemptId: attempt.id },
    });

    if (!report) {
      report = await transaction.verificationReport.create({
        data: {
          verificationAttemptId: attempt.id,
          employeeProfileSkillId: skill.id,
          processingStatus: "NOT_STARTED",
          verificationStatus: "PENDING",
          testPerformance,
        },
      });
    } else {
      report = await transaction.verificationReport.update({
        where: { id: report.id },
        data: {
          testPerformance,
        },
      });
    }

    // 2. Fetch existing VerificationEvidence rows for deduplication
    const existingEvidenceList = await transaction.verificationEvidence.findMany({
      where: { verificationReportId: report.id },
    });

    const existingMap = new Map(
      existingEvidenceList.map((e) => [`${e.evidenceType}_${e.sourceId}`, e])
    );

    const savedEvidenceList = [];

    for (const item of evidenceItems) {
      const contentHash = generateContentHash(item.snapshot);
      const key = `${item.evidenceType}_${item.sourceId}`;
      const existing = existingMap.get(key);

      if (existing) {
        // Only update if snapshot/hash changed
        if (existing.contentHash !== contentHash) {
          const updated = await transaction.verificationEvidence.update({
            where: { id: existing.id },
            data: {
              snapshot: item.snapshot,
              contentHash,
            },
          });
          savedEvidenceList.push(updated);
        } else {
          savedEvidenceList.push(existing);
        }
      } else {
        const created = await transaction.verificationEvidence.create({
          data: {
            verificationReportId: report.id,
            evidenceType: item.evidenceType,
            sourceId: item.sourceId,
            contentHash,
            snapshot: item.snapshot,
          },
        });
        savedEvidenceList.push(created);
      }
    }

    return {
      report,
      evidenceList: savedEvidenceList,
    };
  });
};

module.exports = {
  findOwnedCandidateSkillWithEvidenceSources,
  findValidScoredAttempt,
  createOrUpdateEvidenceSnapshots,
  generateContentHash,
};
