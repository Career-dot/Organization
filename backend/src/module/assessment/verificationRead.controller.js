const {
  checkVerificationEligibility,
  getLatestReportForSkill,
  getActiveAttemptForSkill,
  getDashboardVerificationSummary,
} = require("./verificationRead.service");
const {
  checkEligibilityParamsSchema,
  latestReportParamsSchema,
  activeAttemptParamsSchema,
} = require("./assessment.validation");

const getEligibilityController = async (req, res) => {
  try {
    const paramsValidation = checkEligibilityParamsSchema.safeParse(req.params);
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

    const result = await checkVerificationEligibility({
      userId: req.user.id,
      skillId: req.params.skillId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

const getLatestReportController = async (req, res) => {
  try {
    const paramsValidation = latestReportParamsSchema.safeParse(req.params);
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

    const result = await getLatestReportForSkill({
      userId: req.user.id,
      skillId: req.params.skillId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

const getActiveAttemptController = async (req, res) => {
  try {
    const paramsValidation = activeAttemptParamsSchema.safeParse(req.params);
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

    const result = await getActiveAttemptForSkill({
      userId: req.user.id,
      skillId: req.params.skillId,
    });

    if (!result) {
      return res.status(200).json({
        success: true,
        data: null,
        message: "No active assessment attempt found",
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

const getDashboardVerificationSummaryController = async (req, res) => {
  try {
    const result = await getDashboardVerificationSummary(req.user.id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getEligibilityController,
  getLatestReportController,
  getActiveAttemptController,
  getDashboardVerificationSummaryController,
};

