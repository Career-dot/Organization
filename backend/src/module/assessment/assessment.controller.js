const {
  generateCandidateSkillAssessment,
  startCandidateAssessment,
  cancelCandidateAssessment,
  recordCandidateAssessmentViolation,
  submitCandidateAssessment,
  scoreCandidateAssessment,
} = require("./assessment.service");
const {
  startAssessmentParamsSchema,
  submitAssessmentParamsSchema,
  submitAssessmentBodySchema,
  scoreAssessmentParamsSchema,
} = require("./assessment.validation");

const generateAssessment = async (req, res) => {
  try {
    const result = await generateCandidateSkillAssessment({
      userId: req.user.id,
      skillId: req.params.skillId,
      input: req.body,
    });

    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

const startAssessment = async (req, res) => {
  try {
    const paramsValidation = startAssessmentParamsSchema.safeParse(req.params);
    if (!paramsValidation.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: paramsValidation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const result = await startCandidateAssessment({
      userId: req.user.id,
      skillId: req.params.skillId,
      assessmentId: req.params.assessmentId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

const submitAssessment = async (req, res) => {
  try {
    const paramsValidation = submitAssessmentParamsSchema.safeParse(req.params);
    if (!paramsValidation.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: paramsValidation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const bodyValidation = submitAssessmentBodySchema.safeParse(req.body);
    if (!bodyValidation.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: bodyValidation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const result = await submitCandidateAssessment({
      userId: req.user.id,
      assessmentId: req.params.assessmentId,
      attemptId: req.params.attemptId,
      input: bodyValidation.data,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

const scoreAssessment = async (req, res) => {
  try {
    const paramsValidation = scoreAssessmentParamsSchema.safeParse(req.params);
    if (!paramsValidation.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: paramsValidation.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const result = await scoreCandidateAssessment({
      userId: req.user.id,
      assessmentId: req.params.assessmentId,
      attemptId: req.params.attemptId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

const cancelAssessment = async (req, res) => {
  try {
    const result = await cancelCandidateAssessment({
      userId: req.user.id,
      skillId: req.params.skillId,
      attemptId: req.params.attemptId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

const recordViolation = async (req, res) => {
  try {
    const result = await recordCandidateAssessmentViolation({
      userId: req.user.id,
      skillId: req.params.skillId,
      attemptId: req.params.attemptId,
      violationType: req.body?.violationType || "GENERAL_VIOLATION",
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

module.exports = {
  generateAssessment,
  startAssessment,
  cancelAssessment,
  recordViolation,
  submitAssessment,
  scoreAssessment,
};



