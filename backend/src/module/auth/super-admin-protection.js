const normalizeEmail = (email) =>
  typeof email === "string" ? email.trim().toLowerCase() : "";

const isProtectedSuperAdmin = (user) =>
  normalizeEmail(user?.email) === normalizeEmail(process.env.SUPER_ADMIN_BOOTSTRAP_EMAIL);

const assertProtectedSuperAdminCanReceiveRole = (user, role) => {
  if (isProtectedSuperAdmin(user) && role !== "SUPER_ADMIN") {
    const error = new Error("The protected Super Admin account cannot be assigned another role or workspace");
    error.status = 403;
    throw error;
  }
};

module.exports = {
  normalizeEmail,
  isProtectedSuperAdmin,
  assertProtectedSuperAdminCanReceiveRole,
};
