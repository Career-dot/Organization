const express = require("express");

const {
  getDashboardHandler,
  listOrganizationsHandler,
  getOrganizationDetailHandler,
  getOrganizationSubscriptionHandler,
  listRecruitersHandler,
  getRecruiterDetailHandler,
  listPlansHandler,
  createPlanHandler,
  updatePlanHandler,
  listAuditLogsHandler,
} = require("./admin.controller");

const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const validate = require("../../middleware/validate");

const {
  createPlanSchema,
  updatePlanSchema,
} = require("./admin.validation");

const router = express.Router();

// Every route in this module requires: authenticate + authorize("SUPER_ADMIN").
// SUPER_ADMIN is a Platform Administrator, not a customer account operator.
// Read-only monitoring of organizations, subscriptions, payments, and recruiters;
// Global subscription plan catalog management and audit log tracking.

router.get(
  "/dashboard",
  authenticate,
  authorize("SUPER_ADMIN"),
  getDashboardHandler
);

router.get(
  "/organizations",
  authenticate,
  authorize("SUPER_ADMIN"),
  listOrganizationsHandler
);

router.get(
  "/organizations/:id",
  authenticate,
  authorize("SUPER_ADMIN"),
  getOrganizationDetailHandler
);

router.get(
  "/organizations/:id/subscription",
  authenticate,
  authorize("SUPER_ADMIN"),
  getOrganizationSubscriptionHandler
);

router.get(
  "/recruiters",
  authenticate,
  authorize("SUPER_ADMIN"),
  listRecruitersHandler
);

router.get(
  "/recruiters/:id",
  authenticate,
  authorize("SUPER_ADMIN"),
  getRecruiterDetailHandler
);

router.get(
  "/plans",
  authenticate,
  authorize("SUPER_ADMIN"),
  listPlansHandler
);

router.post(
  "/plans",
  authenticate,
  authorize("SUPER_ADMIN"),
  validate(createPlanSchema),
  createPlanHandler
);

router.patch(
  "/plans/:id",
  authenticate,
  authorize("SUPER_ADMIN"),
  validate(updatePlanSchema),
  updatePlanHandler
);

router.get(
  "/audit-logs",
  authenticate,
  authorize("SUPER_ADMIN"),
  listAuditLogsHandler
);

module.exports = router;

