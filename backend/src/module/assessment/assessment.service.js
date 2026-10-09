const {
  findOwnedEmployeeSkill,
  createAssessmentWithQuestions,
  findPublishedAssessmentDefinition,
  startOrGetActiveVerificationAttempt,
  cancelCandidateAssessmentAttempt,
  recordAssessmentViolationAttempt,
  submitCandidateAssessmentAttempt,
  evaluateAndScoreCandidateAttempt,
} = require("./assessment.repository");
const { checkVerificationEligibility } = require("./verificationRead.service");
const {
  generateAssessment,
  validateGeneratedAssessment,
} = require("../../services/ai/assessmentGenerator");

const DEFAULT_DURATION_SECONDS = 5 * 60; // 300 seconds (temporary test configuration)
const DEFAULT_QUESTION_COUNT = 25;

const normalizeInput = (input = {}) => ({
  department: input.department?.trim() || null,
  domain: input.domain?.trim() || null,
  durationSeconds: input.durationSeconds ?? DEFAULT_DURATION_SECONDS,
  questionCount: input.questionCount ?? DEFAULT_QUESTION_COUNT,
  difficultyConfiguration: input.difficultyConfiguration ?? null,
});

const assertQuestionSet = (generated, expectedQuestionCount) => {
  if (generated.questions.length !== expectedQuestionCount) {
    const error = new Error("Assessment generator returned an unexpected question count");
    error.status = 502;
    throw error;
  }

  const orders = generated.questions.map(({ questionOrder }) => questionOrder);
  if (new Set(orders).size !== orders.length || !orders.every((order, index) => order === index + 1)) {
    const error = new Error("Assessment generator returned invalid question ordering");
    error.status = 502;
    throw error;
  }
};

const toSafeAssessment = (assessment) => ({
  id: assessment.id,
  version: assessment.version,
  skill: {
    id: assessment.employeeProfileSkillId,
    name: assessment.skillNameSnapshot,
    category: assessment.skillCategorySnapshot,
    proficiency: assessment.claimedProficiencySnapshot,
    yearsOfExperience: assessment.yearsOfExperienceSnapshot,
  },
  department: assessment.department,
  domain: assessment.domain,
  title: assessment.title,
  description: assessment.description,
  durationSeconds: assessment.durationSeconds,
  questionCount: assessment.questionCount,
  status: assessment.status,
  createdAt: assessment.createdAt,
  publishedAt: assessment.publishedAt,
  questions: assessment.questions.map((question) => ({
    id: question.id,
    questionOrder: question.questionOrder,
    questionType: question.questionType,
    prompt: question.prompt,
    points: question.points,
    difficulty: question.difficulty,
    options: question.options,
  })),
});

// Backend-authoritative enforcement of the EXISTING verification eligibility
// decision (verificationRead.service.checkVerificationEligibility). This does
// not redefine "relevant change" — it reuses the existing decision as-is:
//   - An active 7-day block (3 cancellations or 3 anti-cheating violations)
//     ALWAYS takes priority: no generation, no start, regardless of any
//     profile/skill/evidence/resume/career-link changes (reason TEMPORARILY_BLOCKED).
//   - A completed verification without relevant changes cannot be re-verified
//     (reason NO_RELEVANT_CHANGES).
//   - NO_PREVIOUS_VERIFICATION / RELEVANT_DATA_UPDATED pass through (allowed).
//   - ATTEMPT_IN_PROGRESS / VERIFICATION_PROCESSING are intentionally passed
//     through so the existing resume/get-or-start repository behavior is
//     unchanged (block and attempt-state checks in the repository remain).
const ELIGIBILITY_REJECTION_REASONS = new Set(["TEMPORARILY_BLOCKED", "NO_RELEVANT_CHANGES"]);

const assertVerificationEligible = async ({ userId, skillId }) => {
  const eligibility = await checkVerificationEligibility({ userId, skillId });
  if (ELIGIBILITY_REJECTION_REASONS.has(eligibility.reason)) {
    const error = new Error(
      eligibility.reason === "TEMPORARILY_BLOCKED"
        ? "Verification is temporarily blocked for this skill. Please try again after the 7-day block expires."
        : "You have already verified this skill and no relevant changes have been made since your last verification."
    );
    error.status = 403;
    error.code = eligibility.reason;
    throw error;
  }
  return eligibility;
};

const generateCandidateSkillAssessment = async ({ userId, skillId, input }) => {
  const skill = await findOwnedEmployeeSkill(userId, skillId);
  if (!skill) {
    const error = new Error("Candidate skill not found");
    error.status = 404;
    throw error;
  }

  // Eligibility gate — must run BEFORE any AI generation so a rejected
  // request never reaches Gemini and never creates an assessment definition.
  await assertVerificationEligible({ userId, skillId });

  const normalizedInput = normalizeInput(input);
  const generatedResponse = await generateAssessment({
    skill: {
      id: skill.id,
      name: skill.name,
      category: skill.category,
      proficiency: skill.proficiency,
      yearsOfExperience: skill.yearsOfExperience,
    },
    assessment: normalizedInput,
  });
  const generated = validateGeneratedAssessment(generatedResponse.result);
  assertQuestionSet(generated, normalizedInput.questionCount);

  const assessment = await createAssessmentWithQuestions({
    skill,
    input: normalizedInput,
    generated,
    provider: generatedResponse.provider,
  });

  return toSafeAssessment(assessment);
};

const startCandidateAssessment = async ({ userId, skillId, assessmentId }) => {
  const skill = await findOwnedEmployeeSkill(userId, skillId);
  if (!skill) {
    const error = new Error("Candidate skill not found");
    error.status = 404;
    throw error;
  }

  // Eligibility gate — enforces the existing eligibility decision before any
  // attempt is created or resumed: active 7-day block → reject; completed
  // verification without relevant changes → reject. Existing repository
  // checks (ownership, active-attempt resume, cancellation/violation blocks,
  // state validation) remain unchanged below.
  await assertVerificationEligible({ userId, skillId });

  const assessment = await findPublishedAssessmentDefinition(skillId, assessmentId);
  if (!assessment) {
    const error = new Error("Assessment definition not found");
    error.status = 404;
    throw error;
  }

  if (assessment.status !== "PUBLISHED") {
    const error = new Error("Only published assessments can be started");
    error.status = 400;
    throw error;
  }

  const attempt = await startOrGetActiveVerificationAttempt({
    userId,
    employeeProfileId: skill.employeeProfile.id,
    skill,
    assessment,
  });

  const safeQuestions = assessment.questions.map((question) => ({
    id: question.id,
    questionOrder: question.questionOrder,
    questionType: question.questionType,
    prompt: question.prompt,
    points: question.points,
    difficulty: question.difficulty,
    options: question.options,
  }));

  return {
    attempt: {
      id: attempt.id,
      assessmentDefinitionId: attempt.assessmentDefinitionId,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
    },
    assessment: {
      id: assessment.id,
      version: assessment.version,
      skill: {
        id: skill.id,
        name: assessment.skillNameSnapshot,
        category: assessment.skillCategorySnapshot,
        proficiency: assessment.claimedProficiencySnapshot,
        yearsOfExperience: assessment.yearsOfExperienceSnapshot,
      },
      title: assessment.title,
      description: assessment.description,
      durationSeconds: assessment.durationSeconds,
      questionCount: assessment.questionCount,
      questions: safeQuestions,
    },
  };
};

const submitCandidateAssessment = async ({ userId, assessmentId, attemptId, answers, input }) => {
  const finalAnswers = input?.answers || answers || [];

  const updatedAttempt = await submitCandidateAssessmentAttempt({
    userId,
    assessmentId,
    attemptId,
    answers: finalAnswers,
  });

  return {
    attempt: {
      id: updatedAttempt.id,
      assessmentId: updatedAttempt.assessmentDefinitionId,
      status: updatedAttempt.status,
      submittedAt: updatedAttempt.submittedAt,
    },
  };
};

const scoreCandidateAssessment = async ({ userId, assessmentId, attemptId }) => {
  const scoredAttempt = await evaluateAndScoreCandidateAttempt({
    userId,
    assessmentId,
    attemptId,
  });

  return {
    attempt: {
      id: scoredAttempt.id,
      assessmentId: scoredAttempt.assessmentDefinitionId,
      status: scoredAttempt.status,
      testScorePoints: scoredAttempt.testScorePoints,
      evaluableMaxPoints: scoredAttempt.evaluableMaxPoints,
      testScoreMaxPoints: scoredAttempt.testScoreMaxPoints,
      pendingMaxPoints: scoredAttempt.pendingMaxPoints,
      pendingQuestionCount: scoredAttempt.pendingQuestionCount,
      testScorePercentage: scoredAttempt.testScorePercentage !== null ? Number(scoredAttempt.testScorePercentage) : null,
      isFullyEvaluated: scoredAttempt.isFullyEvaluated,
    },
  };
};

const cancelCandidateAssessment = async ({ userId, skillId, attemptId }) => {
  return cancelCandidateAssessmentAttempt({ userId, skillId, attemptId });
};

const recordCandidateAssessmentViolation = async ({ userId, skillId, attemptId, violationType }) => {
  return recordAssessmentViolationAttempt({ userId, skillId, attemptId, violationType });
};

module.exports = {
  generateCandidateSkillAssessment,
  startCandidateAssessment,
  cancelCandidateAssessment,
  recordCandidateAssessmentViolation,
  submitCandidateAssessment,
  scoreCandidateAssessment,
};




