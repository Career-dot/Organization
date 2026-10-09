const {
  fetchNotificationsForUser,
  markAsReadForUser,
} = require("./notification.service");

const getNotificationsController = async (req, res) => {
  try {
    const notifications = await fetchNotificationsForUser(req.user.id);
    return res.status(200).json({
      success: true,
      data: { notifications },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

const markNotificationReadController = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const notification = await markAsReadForUser({
      userId: req.user.id,
      notificationId,
    });
    return res.status(200).json({
      success: true,
      data: { notification },
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getNotificationsController,
  markNotificationReadController,
};

