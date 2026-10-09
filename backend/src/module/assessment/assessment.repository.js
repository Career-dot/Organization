const prisma = require("../../config/prisma");

const findOwnedEmployeeSkill = async (userId, skillId) => prisma.employeeProfileSkill.findFirst({
  where: {
    id: skillId,
    employeeProfile: { userId },
  },
  include: { employeeProfile: true },
});

const createAssessmentWithQuestions = async ({ skill, input, generated, provider }) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (transaction) => {
        const latest = await transaction.assessmentDefinition.findFirst({
          where: { employeeProfileSkillId: skill.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const version = (latest?.version ?? 0) + 1;

        return transaction.assessmentDefinition.create({
          data: {
            employeeProfileSkillId: skill.id,
            skillNameSnapshot: skill.name,
            skillCategorySnapshot: skill.category,
            claimedProficiencySnapshot: skill.proficiency,
            yearsOfExperienceSnapshot: skill.yearsOfExperience,
            department: input.department ?? null,
            domain: input.domain ?? null,
            title: generated.title,
            description: generated.description ?? null,
            durationSeconds: input.durationSeconds,
            questionCount: generated.questions.length,
            passingScore: 70,
            difficultyConfiguration: input.difficultyConfiguration ?? null,
            generationModel: provider,
            promptVersion: "assessment-generator-v1",
            status: "PUBLISHED",
            version,
            publishedAt: new Date(),
            questions: {
              create: generated.questions.map((question) => ({
                questionOrder: question.questionOrder,
                questionType: question.questionType,
                prompt: question.prompt,
                points: question.points,
                difficulty: question.difficulty ?? null,
                questionConfiguration: question.questionConfiguration ?? null,
                options: question.options ?? null,
                evaluationConfiguration: question.evaluationConfig ?? null,
                rubric: question.rubric ?? null,
                correctAnswer: question.correctAnswer ?? null,
              })),
            },
          },
          include: { questions: { orderBy: { questionOrder: "asc" } } },
        });
      });
    } catch (error) {
      if (error.code !== "P2002" || attempt === 2) throw error;
    }
  }
};

const findPublishedAssessmentDefinition = async (skillId, assessmentId) => {
  return prisma.assessmentDefinition.findFirst({
    where: {
      id: assessmentId,
      employeeProfileSkillId: skillId,
    },
    include: {
      questions: { orderBy: { questionOrder: "asc" } },
      employeeProfileSkill: true,
    },
  });
};

const startOrGetActiveVerificationAttempt = async ({ userId, employeeProfileId, skill, assessment }) => {
  return prisma.$transaction(async (transaction) => {
    // 1. Check Anti-Cheating Hard Block for candidate skill
    const violationTerminations = await transaction.verificationAttempt.findMany({
      where: {
        userId,
        OR: [
          { employeeProfileSkillId: skill.id },
          { skillNameSnapshot: { equals: skill.name, mode: "insensitive" } },
        ],
        status: "VIOLATION_TERMINATED",
      },
      orderBy: { updatedAt: "desc" },
    });

    if (violationTerminations.length > 0) {
      const latestViolationTime = new Date(violationTerminations[0].updatedAt || violationTerminations[0].createdAt).getTime();
      const blockUntilMs = latestViolationTime + 7 * 24 * 60 * 60 * 1000;
      if (Date.now() < blockUntilMs) {
        const diffMs = blockUntilMs - Date.now();
        const days = Math.floor(diffMs / (24 * 3600 * 1000));
        const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
        const error = new Error(`Verification temporarily unavailable. Assessment was terminated due to anti-cheating violations. You can attempt this skill again in ${days} days ${hours} hours.`);
        error.status = 403;
        error.code = "ASSESSMENT_TEMPORARILY_BLOCKED";
        error.blockedUntil = new Date(blockUntilMs).toISOString();
        throw error;
      }
    }

    // 2. Check Voluntary Cancellation Hard Block for candidate skill
   const priorCancellations = await prisma.verificationAttempt.findMany({
  where: {
    userId,
    employeeProfileSkillId: skill.id,
    status: "CANCELLED",
  },
  orderBy: { updatedAt: "desc" },
});

    if (priorCancellations.length >= 3) {
      const thirdCancelTime = new Date(priorCancellations[2].updatedAt || priorCancellations[2].createdAt).getTime();
      const blockUntilMs = thirdCancelTime + 7 * 24 * 60 * 60 * 1000;
      if (Date.now() < blockUntilMs) {
        const diffMs = blockUntilMs - Date.now();
        const days = Math.floor(diffMs / (24 * 3600 * 1000));
        const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
        const error = new Error(`Verification temporarily unavailable. You have cancelled this assessment 3 times. You can attempt this skill again in ${days} days ${hours} hours.`);
        error.status = 403;
        error.code = "ASSESSMENT_TEMPORARILY_BLOCKED";
        error.blockedUntil = new Date(blockUntilMs).toISOString();
        throw error;
      }
    }

    const existingAttempt = await transaction.verificationAttempt.findFirst({
      where: {
        userId,
        assessmentDefinitionId: assessment.id,
        status: "IN_PROGRESS",
      },
    });

    const now = new Date();

    if (existingAttempt) {
      if (new Date(existingAttempt.deadlineAt).getTime() > now.getTime()) {
        return existingAttempt;
      }

      await transaction.verificationAttempt.update({
        where: { id: existingAttempt.id },
        data: {
          status: "EXPIRED",
          expiredAt: now,
        },
      });
    }

    const startedAt = now;
    const deadlineAt = new Date(startedAt.getTime() + assessment.durationSeconds * 1000);

    const newAttempt = await transaction.verificationAttempt.create({
      data: {
        userId,
        employeeProfileId,
        employeeProfileSkillId: skill.id,
        assessmentDefinitionId: assessment.id,
        assessmentVersion: assessment.version,
        skillNameSnapshot: skill.name,
        claimedProficiencySnapshot: skill.proficiency,
        yearsOfExperienceSnapshot: skill.yearsOfExperience,
        status: "IN_PROGRESS",
        startedAt,
        deadlineAt,
      },
    });

    return newAttempt;
  });
};

const cancelCandidateAssessmentAttempt = async ({ userId, skillId, attemptId }) => {
  const attempt = await prisma.verificationAttempt.findFirst({
    where: {
      id: attemptId,
      userId,
      employeeProfileSkillId: skillId,
    },
  });

  if (!attempt) {
    const error = new Error("Assessment attempt not found or does not belong to this skill");
    error.status = 404;
    throw error;
  }

  if (attempt.status === "IN_PROGRESS" || attempt.status === "EXPIRED") {
    await prisma.verificationAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "CANCELLED",
        submittedAt: new Date(),
      },
    });
  } else if (attempt.status !== "CANCELLED") {
    const error = new Error("This assessment attempt cannot be cancelled because it has already been submitted or completed.");
    error.status = 400;
    throw error;
  }

  // Count all voluntary cancellations for this user and skill.
// Changing proficiency or years of experience must not reset the cancellation count.
  const priorCancellations = await prisma.verificationAttempt.findMany({
  where: {
    userId,
    employeeProfileSkillId: skillId,
    status: "CANCELLED",
  },
  orderBy: { updatedAt: "desc" },
});

  const cancellationCount = priorCancellations.length;
  const isBlocked = cancellationCount >= 3;
  let blockedUntil = null;

  if (isBlocked && priorCancellations.length >= 3) {
    const thirdCancelTime = new Date(priorCancellations[2].updatedAt || priorCancellations[2].createdAt).getTime();
    blockedUntil = new Date(thirdCancelTime + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  return {
    cancelledAttemptId: attempt.id,
    cancellationCount,
    remainingCancellations: Math.max(0, 3 - cancellationCount),
    isBlocked,
    blockedUntil,
  };
};

const submitCandidateAssessmentAttempt = async ({ userId, assessmentId, attemptId, answers }) => {
  const attempt = await prisma.verificationAttempt.findFirst({
    where: {
      id: attemptId,
      userId,
    },
    include: {
      assessmentDefinition: {
        include: {
          questions: { select: { id: true } },
        },
      },
    },
  });

  if (!attempt) {
    const error = new Error("Assessment attempt not found");
    error.status = 404;
    throw error;
  }

  if (attempt.assessmentDefinitionId !== assessmentId) {
    const error = new Error("Assessment attempt does not match requested assessment");
    error.status = 404;
    throw error;
  }

  const now = new Date();

  // The frontend's server-authoritative countdown triggers the auto-submit when
  // fewer than ~1s remain (AssessmentTake.jsx), so a legitimate timeout
  // submission routinely lands a few hundred milliseconds AFTER deadlineAt once
  // network latency and client/server clock drift are accounted for. Tolerate a
  // small, bounded grace window ONLY for this submit-time check so those
  // submissions are accepted (answers persisted, status -> SUBMITTED) instead of
  // being silently discarded, while submissions that are genuinely late (beyond
  // the grace window) are still expired and rejected below.
  const SUBMIT_DEADLINE_GRACE_MS = 5_000;

  if (new Date(attempt.deadlineAt).getTime() + SUBMIT_DEADLINE_GRACE_MS < now.getTime()) {
    if (attempt.status === "IN_PROGRESS") {
      await prisma.verificationAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "EXPIRED",
          expiredAt: now,
        },
      });
    }
    const error = new Error("Assessment attempt deadline has passed");
    error.status = 400;
    throw error;
  }

  if (attempt.status !== "IN_PROGRESS") {
    const error = new Error("Assessment attempt is not in progress");
    error.status = 400;
    throw error;
  }

  const validQuestionIds = new Set(
    attempt.assessmentDefinition.questions.map((q) => q.id)
  );

  const submittedQuestionIds = new Set();
  for (const item of answers) {
    if (submittedQuestionIds.has(item.questionId)) {
      const error = new Error("Duplicate question submission detected");
      error.status = 400;
      throw error;
    }
    submittedQuestionIds.add(item.questionId);

    if (!validQuestionIds.has(item.questionId)) {
      const error = new Error(`Question ${item.questionId} does not belong to this assessment`);
      error.status = 400;
      throw error;
    }
  }

  return prisma.$transaction(async (transaction) => {
    const currentAttempt = await transaction.verificationAttempt.findUnique({
      where: { id: attempt.id },
    });

    if (!currentAttempt || currentAttempt.status !== "IN_PROGRESS") {
      const error = new Error("Assessment attempt is not in progress");
      error.status = 400;
      throw error;
    }

    for (const item of answers) {
      await transaction.assessmentAnswer.upsert({
        where: {
          attemptId_questionId: {
            attemptId: attempt.id,
            questionId: item.questionId,
          },
        },
        update: {
          answerData: item.answer,
          answeredAt: now,
          evaluationStatus: "PENDING",
        },
        create: {
          attemptId: attempt.id,
          questionId: item.questionId,
          answerData: item.answer,
          answeredAt: now,
          evaluationStatus: "PENDING",
        },
      });
    }

    const updatedAttempt = await transaction.verificationAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "SUBMITTED",
        submittedAt: now,
      },
    });

    return updatedAttempt;
  });
};

const evaluateAndScoreCandidateAttempt = async ({ userId, assessmentId, attemptId }) => {
  const attempt = await prisma.verificationAttempt.findFirst({
    where: {
      id: attemptId,
      userId,
    },
    include: {
      answers: true,
      assessmentDefinition: {
        include: {
          questions: { orderBy: { questionOrder: "asc" } },
        },
      },
    },
  });

  if (!attempt) {
    const error = new Error("Assessment attempt not found");
    error.status = 404;
    throw error;
  }

  if (attempt.assessmentDefinitionId !== assessmentId) {
    const error = new Error("Assessment attempt does not match requested assessment");
    error.status = 404;
    throw error;
  }

  if (attempt.status === "SCORED") {
    const error = new Error("Assessment attempt has already been scored");
    error.status = 400;
    throw error;
  }

  if (attempt.status !== "SUBMITTED") {
    const error = new Error("Only submitted assessments can be scored");
    error.status = 400;
    throw error;
  }

  const answerMap = new Map(attempt.answers.map((a) => [a.questionId, a]));
  const questions = attempt.assessmentDefinition.questions;

  let testScoreMaxPoints = 0;
  let testScorePoints = 0;
  let evaluableMaxPoints = 0;
  let pendingMaxPoints = 0;
  let pendingQuestionCount = 0;

  const evaluations = [];

  for (const question of questions) {
    testScoreMaxPoints += question.points;
    const existingAnswer = answerMap.get(question.id);

    let evaluationStatus = "PENDING";
    let isCorrect = null;
    let pointsAwarded = 0;

    if (question.questionType === "SINGLE_CHOICE") {
      evaluationStatus = "EVALUATED";
      const correctAnswer = question.correctAnswer;
      const candidateAnswer = existingAnswer?.answerData;

      const correctVal = typeof correctAnswer === "object" && correctAnswer !== null
        ? String(correctAnswer.optionId ?? correctAnswer.value ?? "")
        : String(correctAnswer ?? "");

      const candidateVal = typeof candidateAnswer === "object" && candidateAnswer !== null
        ? String(candidateAnswer.optionId ?? candidateAnswer.value ?? "")
        : String(candidateAnswer ?? "");

      if (candidateVal && correctVal && candidateVal.trim() === correctVal.trim()) {
        isCorrect = true;
        pointsAwarded = question.points;
      } else {
        isCorrect = false;
        pointsAwarded = 0;
      }
    } else if (question.questionType === "MULTIPLE_CHOICE") {
      evaluationStatus = "EVALUATED";
      const correctAnswer = question.correctAnswer;
      const candidateAnswer = existingAnswer?.answerData;

      const correctArr = Array.isArray(correctAnswer?.optionIds)
        ? correctAnswer.optionIds
        : Array.isArray(correctAnswer?.values)
        ? correctAnswer.values
        : Array.isArray(correctAnswer)
        ? correctAnswer
        : [];

      const candidateArr = Array.isArray(candidateAnswer?.optionIds)
        ? candidateAnswer.optionIds
        : Array.isArray(candidateAnswer?.values)
        ? candidateAnswer.values
        : Array.isArray(candidateAnswer)
        ? candidateAnswer
        : [];

      const correctSet = new Set(correctArr.map((v) => String(v).trim()));
      const candidateSet = new Set(candidateArr.map((v) => String(v).trim()));

      const isExactMatch =
        correctSet.size > 0 &&
        correctSet.size === candidateSet.size &&
        [...correctSet].every((val) => candidateSet.has(val));

      if (isExactMatch) {
        isCorrect = true;
        pointsAwarded = question.points;
      } else {
        isCorrect = false;
        pointsAwarded = 0;
      }
    } else {
      // SCENARIO, PROBLEM_SOLVING, SHORT_ANSWER, CODING, LIVE_CODING, PRACTICAL
      evaluationStatus = "PENDING";
      isCorrect = null;
      pointsAwarded = 0;
    }

    if (evaluationStatus === "EVALUATED") {
      evaluableMaxPoints += question.points;
      testScorePoints += pointsAwarded;
    } else {
      pendingMaxPoints += question.points;
      pendingQuestionCount += 1;
    }

    evaluations.push({
      questionId: question.id,
      existingAnswerId: existingAnswer?.id ?? null,
      evaluationStatus,
      isCorrect,
      pointsAwarded,
    });
  }

  const isFullyEvaluated = pendingQuestionCount === 0;

  const testScorePercentage = evaluableMaxPoints > 0
    ? Number(((testScorePoints / evaluableMaxPoints) * 100).toFixed(2))
    : null;

  return prisma.$transaction(async (transaction) => {
    const currentAttempt = await transaction.verificationAttempt.findUnique({
      where: { id: attempt.id },
    });

    if (!currentAttempt || currentAttempt.status !== "SUBMITTED") {
      const error = new Error("Assessment attempt is not ready to be scored");
      error.status = 400;
      throw error;
    }

    for (const item of evaluations) {
      if (item.existingAnswerId) {
        await transaction.assessmentAnswer.update({
          where: { id: item.existingAnswerId },
          data: {
            evaluationStatus: item.evaluationStatus,
            isCorrect: item.isCorrect,
            pointsAwarded: item.pointsAwarded,
          },
        });
      } else {
        await transaction.assessmentAnswer.create({
          data: {
            attemptId: attempt.id,
            questionId: item.questionId,
            answerData: null,
            evaluationStatus: item.evaluationStatus,
            isCorrect: item.isCorrect,
            pointsAwarded: item.pointsAwarded,
          },
        });
      }
    }

    const scoredAttempt = await transaction.verificationAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "SCORED",
        testScorePoints,
        testScoreMaxPoints,
        testScorePercentage,
      },
    });

    return {
      ...scoredAttempt,
      evaluableMaxPoints,
      pendingMaxPoints,
      pendingQuestionCount,
      isFullyEvaluated,
    };
  });
};


const recordAssessmentViolationAttempt = async ({ userId, skillId, attemptId, violationType }) => {
  const attempt = await prisma.verificationAttempt.findFirst({
    where: {
      id: attemptId,
      userId,
      employeeProfileSkillId: skillId,
    },
  });

  if (!attempt) {
    const error = new Error("Active assessment attempt not found for violation recording");
    error.status = 404;
    throw error;
  }

  if (attempt.status !== "IN_PROGRESS") {
    return {
      violationCount: attempt.violationCount || 3,
      remainingViolations: 0,
      isTerminated: true,
      isBlocked: true,
    };
  }

  const newCount = (attempt.violationCount || 0) + 1;

  if (newCount < 3) {
    const updated = await prisma.verificationAttempt.update({
      where: { id: attempt.id },
      data: { violationCount: newCount },
    });

    return {
      violationCount: updated.violationCount,
      remainingViolations: 3 - updated.violationCount,
      isTerminated: false,
      isBlocked: false,
      warningMessage: `Violation ${updated.violationCount}/3: ${
        violationType === "CLIPBOARD_COPY" || violationType === "CLIPBOARD_PASTE"
          ? "Copying or pasting content"
          : "Switching tabs or losing page focus"
      } is strictly prohibited during the assessment.`,
    };
  }

  // Violation #3: Terminate attempt immediately with status VIOLATION_TERMINATED & 7-day hard block
  const now = new Date();
  const terminated = await prisma.verificationAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "VIOLATION_TERMINATED",
      violationCount: 3,
      submittedAt: now,
    },
  });

  const blockUntilMs = now.getTime() + 7 * 24 * 60 * 60 * 1000;

  return {
    violationCount: 3,
    remainingViolations: 0,
    isTerminated: true,
    isBlocked: true,
    blockedUntil: new Date(blockUntilMs).toISOString(),
    warningMessage: "Assessment terminated due to anti-cheating violations (3/3). You are blocked from attempting this skill assessment for 7 days.",
  };
};

module.exports = {
  findOwnedEmployeeSkill,
  createAssessmentWithQuestions,
  findPublishedAssessmentDefinition,
  startOrGetActiveVerificationAttempt,
  cancelCandidateAssessmentAttempt,
  submitCandidateAssessmentAttempt,
  evaluateAndScoreCandidateAttempt,
  recordAssessmentViolationAttempt,
};




