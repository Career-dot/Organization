const express = require("express");
const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const {
  getNotificationsController,
  markNotificationReadController,
} = require("./notification.controller");

const router = express.Router();

router.get(
  "/notifications",
  authenticate,
  authorize("EMPLOYEE"),
  getNotificationsController
);

router.patch(
  "/notifications/:notificationId/read",
  authenticate,
  authorize("EMPLOYEE"),
  markNotificationReadController
);

module.exports = router;

