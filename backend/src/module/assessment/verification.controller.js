const { analyzeCandidateVerification } = require("./verification.service");
const {
  analyzeVerificationParamsSchema,
  analyzeVerificationBodySchema,
} = require("./assessment.validation");

const analyzeVerificationController = async (req, res) => {
  try {
    const paramsValidation = analyzeVerificationParamsSchema.safeParse(req.params);
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

    const bodyValidation = analyzeVerificationBodySchema.safeParse(req.body || {});
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

    const result = await analyzeCandidateVerification({
      userId: req.user.id,
      skillId: req.params.skillId,
      attemptId: bodyValidation.data?.attemptId,
      forceRetry: bodyValidation.data?.forceRetry || false,
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
  analyzeVerificationController,
};

