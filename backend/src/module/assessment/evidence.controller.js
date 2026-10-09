const { prepareVerificationEvidence } = require("./evidence.service");
const {
  prepareEvidenceParamsSchema,
  prepareEvidenceBodySchema,
} = require("./assessment.validation");

const prepareEvidence = async (req, res) => {
  try {
    const paramsValidation = prepareEvidenceParamsSchema.safeParse(req.params);
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

    const bodyValidation = prepareEvidenceBodySchema.safeParse(req.body || {});
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

    const result = await prepareVerificationEvidence({
      userId: req.user.id,
      skillId: req.params.skillId,
      attemptId: bodyValidation.data?.attemptId,
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

module.exports = { prepareEvidence };

