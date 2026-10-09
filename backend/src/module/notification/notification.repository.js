const prisma = require("../../config/prisma");

const createNotification = async ({ userId, title, message, type = "VERIFICATION_RESULT", link = null }) => {
  return prisma.notification.create({
    data: {
      userId,
      title,
      message,
      type,
      link,
    },
  });
};

const findNotificationByLink = async ({ userId, link }) => {
  if (!link) return null;
  return prisma.notification.findFirst({
    where: { userId, link },
  });
};

const getCandidateNotifications = async (userId) => {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      message: true,
      type: true,
      isRead: true,
      link: true,
      createdAt: true,
    },
  });
};

const markNotificationAsRead = async ({ userId, notificationId }) => {
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });
  if (!existing) return null;

  return prisma.notification.update({
    where: { id: notificationId },
    data: { isRead: true },
  });
};

module.exports = {
  createNotification,
  findNotificationByLink,
  getCandidateNotifications,
  markNotificationAsRead,
};

