const express = require("express");
const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const validate = require("../../middleware/validate");
const {
  generateAssessment,
  startAssessment,
  cancelAssessment,
  recordViolation,
  submitAssessment,
  scoreAssessment,
} = require("./assessment.controller");
const { prepareEvidence } = require("./evidence.controller");
const { analyzeVerificationController } = require("./verification.controller");
const {
  getEligibilityController,
  getLatestReportController,
  getActiveAttemptController,
  getDashboardVerificationSummaryController,
} = require("./verificationRead.controller");
const { generateAssessmentSchema } = require("./assessment.validation");

const router = express.Router();

router.post(
  "/skills/:skillId/assessments/generate",
  authenticate,
  authorize("EMPLOYEE"),
  validate(generateAssessmentSchema),
  generateAssessment
);

router.post(
  "/skills/:skillId/assessments/:assessmentId/start",
  authenticate,
  authorize("EMPLOYEE"),
  startAssessment
);

router.post(
  "/skills/:skillId/assessments/:assessmentId/attempts/:attemptId/cancel",
  authenticate,
  authorize("EMPLOYEE"),
  cancelAssessment
);

router.post(
  "/skills/:skillId/verification/attempts/:attemptId/cancel",
  authenticate,
  authorize("EMPLOYEE"),
  cancelAssessment
);

router.post(
  "/skills/:skillId/verification/attempts/:attemptId/violation",
  authenticate,
  authorize("EMPLOYEE"),
  recordViolation
);

router.post(
  "/assessments/:assessmentId/attempts/:attemptId/submit",
  authenticate,
  authorize("EMPLOYEE"),
  submitAssessment
);

router.post(
  "/assessments/:assessmentId/attempts/:attemptId/score",
  authenticate,
  authorize("EMPLOYEE"),
  scoreAssessment
);

router.post(
  "/skills/:skillId/verification-evidence/prepare",
  authenticate,
  authorize("EMPLOYEE"),
  prepareEvidence
);

router.post(
  "/skills/:skillId/verification/analyze",
  authenticate,
  authorize("EMPLOYEE"),
  analyzeVerificationController
);

router.get(
  "/skills/:skillId/verification/eligibility",
  authenticate,
  authorize("EMPLOYEE"),
  getEligibilityController
);

router.get(
  "/skills/:skillId/verification/reports/latest",
  authenticate,
  authorize("EMPLOYEE"),
  getLatestReportController
);

router.get(
  "/skills/:skillId/verification/attempts/active",
  authenticate,
  authorize("EMPLOYEE"),
  getActiveAttemptController
);

router.get(
  "/dashboard/verification-summary",
  authenticate,
  authorize("EMPLOYEE"),
  getDashboardVerificationSummaryController
);

module.exports = router;






