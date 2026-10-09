const { z } = require("zod");

const generateAssessmentSchema = z.object({
  department: z.string().trim().max(200).optional().nullable(),
  domain: z.string().trim().max(200).optional().nullable(),
  durationSeconds: z.number().int().min(60).max(7200).optional(),
  questionCount: z.number().int().min(1).max(100).optional(),
  difficultyConfiguration: z.any().optional().nullable(),
}).strict();

const startAssessmentParamsSchema = z.object({
  skillId: z.string().trim().min(1, "skillId is required"),
  assessmentId: z.string().trim().min(1, "assessmentId is required"),
});

const submitAssessmentParamsSchema = z.object({
  assessmentId: z.string().trim().min(1, "assessmentId is required"),
  attemptId: z.string().trim().min(1, "attemptId is required"),
});

const answerItemSchema = z.object({
  questionId: z.string().trim().min(1, "questionId is required"),
  answer: z.any().refine((val) => val !== undefined && val !== null, {
    message: "answer is required",
  }),
});

const submitAssessmentBodySchema = z.object({
  answers: z.array(answerItemSchema),
}).strict();

const scoreAssessmentParamsSchema = z.object({
  assessmentId: z.string().trim().min(1, "assessmentId is required"),
  attemptId: z.string().trim().min(1, "attemptId is required"),
});

const prepareEvidenceParamsSchema = z.object({
  skillId: z.string().trim().min(1, "skillId is required"),
});

const prepareEvidenceBodySchema = z.object({
  attemptId: z.string().trim().min(1, "attemptId is required").optional(),
}).strict();

const analyzeVerificationParamsSchema = z.object({
  skillId: z.string().trim().min(1, "skillId is required"),
});

const analyzeVerificationBodySchema = z.object({
  attemptId: z.string().trim().min(1, "attemptId is required").optional(),
  forceRetry: z.boolean().optional(),
}).strict();

const checkEligibilityParamsSchema = z.object({
  skillId: z.string().trim().min(1, "skillId is required"),
});

const latestReportParamsSchema = z.object({
  skillId: z.string().trim().min(1, "skillId is required"),
});

const activeAttemptParamsSchema = z.object({
  skillId: z.string().trim().min(1, "skillId is required"),
});

module.exports = {
  generateAssessmentSchema,
  startAssessmentParamsSchema,
  submitAssessmentParamsSchema,
  submitAssessmentBodySchema,
  scoreAssessmentParamsSchema,
  prepareEvidenceParamsSchema,
  prepareEvidenceBodySchema,
  analyzeVerificationParamsSchema,
  analyzeVerificationBodySchema,
  checkEligibilityParamsSchema,
  latestReportParamsSchema,
  activeAttemptParamsSchema,
};






