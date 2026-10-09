const express = require("express");

const { listPlans, checkout, pay } = require("./subscription.controller");

const validate = require("../../middleware/validate");
const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const { checkoutSchema, paymentSchema } = require("./subscription.validation");

const router = express.Router();

router.get("/plans", listPlans);

router.post(
  "/checkout",
  authenticate,
  authorize("EMPLOYEE", "RECRUITER", "ORG_ADMIN"),
  validate(checkoutSchema),
  checkout
);

router.post(
  "/payment",
  authenticate,
  authorize("EMPLOYEE", "RECRUITER", "ORG_ADMIN"),
  validate(paymentSchema),
  pay
);

module.exports = router;
