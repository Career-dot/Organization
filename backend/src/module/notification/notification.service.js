const {
  createNotification,
  findNotificationByLink,
  getCandidateNotifications,
  markNotificationAsRead,
} = require("./notification.repository");

const createIdempotentNotification = async ({ userId, title, message, type = "VERIFICATION_RESULT", link = null }) => {
  if (link) {
    const existing = await findNotificationByLink({ userId, link });
    if (existing) {
      return existing;
    }
  }
  return createNotification({ userId, title, message, type, link });
};

const fetchNotificationsForUser = async (userId) => {
  return getCandidateNotifications(userId);
};

const markAsReadForUser = async ({ userId, notificationId }) => {
  const result = await markNotificationAsRead({ userId, notificationId });
  if (!result) {
    const error = new Error("Notification not found or access denied");
    error.status = 404;
    throw error;
  }
  return result;
};

module.exports = {
  createIdempotentNotification,
  fetchNotificationsForUser,
  markAsReadForUser,
};

