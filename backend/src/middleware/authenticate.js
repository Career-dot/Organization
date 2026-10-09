const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

const UNAUTHORIZED = {
  success: false,
  message: "Invalid or expired token",
};

const ROLE_PRIORITY = ["EMPLOYEE", "RECRUITER", "ORG_ADMIN", "SUPER_ADMIN"];

// ---------------------------------------------------------------------------
// Server-side must-change-password gate.
//
// WHY THIS EXISTS
// A recruiter created by an ORG_ADMIN gets a server-generated temporary
// password and `mustChangePassword: true` (see createActiveRecruiter). The
// frontend routes that user to /change-password, but that is a *client-side
// courtesy only* — previously nothing on the server stopped a holder of the
// temporary password from calling any authorized API (jobs, candidates,
// dashboard, profile) immediately after logging in. This gate is the actual
// enforcement point.
//
// WHY IT LIVES IN authenticate.js
// `authenticate` is the single chokepoint every protected route already passes
// through (it is applied 93 times across the route files), so putting the
// check here covers all of them at once and cannot be forgotten by a new
// route. It reuses the user row already loaded below — no extra query.
//
// SESSION BEHAVIOR — DELIBERATELY NON-DESTRUCTIVE
// A 403 here does NOT revoke sessions, clear cookies or touch RefreshToken.
// The user stays fully authenticated on purpose: they need that live session
// to call POST /api/auth/change-password, which is itself gated. Destroying
// the session would force a re-login with the very temporary password we are
// trying to retire. The account can still log out, refresh, or read its own
// profile state at any time.
// ---------------------------------------------------------------------------

// Exactly the endpoints needed to complete the password-change lifecycle.
// Matching is done on the HTTP method plus the NORMALIZED, QUERY-STRIPPED
// absolute path (see resolveRequestPath) — never a substring/`includes` test,
// which would let a crafted URL such as `/api/job/recruiters/../auth/me` or
// `/api/auth/change-password/../../job/recruiters/jobs` slip past.
const PASSWORD_CHANGE_ALLOWED_ROUTES = new Set([
  "POST /api/auth/change-password",
  "GET /api/auth/me",
  "POST /api/auth/logout",
  "POST /api/auth/refresh",
]);

// (resolveRequestPath + PASSWORD_CHANGE_ALLOWED_ROUTES are exercised by
// authenticate.test.js via the __test hook attached to the final export below.)

// Returns "<METHOD> <path>" for exact comparison against the allow-list.
//
// Uses req.originalUrl (the URL as received by the app, unaffected by any
// router mount path or express.url rewriting) rather than req.path, which is
// relative to the current router's mount point and therefore differs between
// the same logical endpoint reached through different mounts.
//
// The query string is stripped, a trailing slash is normalized away, and any
// duplicate slashes are collapsed — so `/api/auth/me/?x=1` and `/api/auth/me`
// are treated as the same endpoint, while a genuinely different path is not.
const resolveRequestPath = (req) => {
  const rawUrl = req.originalUrl || req.url || "";
  const path = rawUrl.split("?")[0].split("#")[0];
  const normalizedPath = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";

  return `${req.method.toUpperCase()} ${normalizedPath}`;
};

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  let payload;

  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json(UNAUTHORIZED);
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
      employeeProfile: true,
      recruiterProfile: true,
      organizationMemberships: true,
    },
  });

  if (!user || user.isDeleted) {
    return res.status(401).json(UNAUTHORIZED);
  }

  if (user.status === "SUSPENDED" || user.status === "INACTIVE") {
    return res.status(401).json(UNAUTHORIZED);
  }

  // ---- Server-side must-change-password enforcement -------------------------
  // Reached only by a fully valid, live session (JWT verified, user exists,
  // not deleted, not suspended). The user stays authenticated — this is a
  // 403, not a 401, and it revokes nothing — because they must still be able
  // to reach POST /api/auth/change-password to retire the temporary password.
  //
  // Without this, a temporary password would grant full recruiter API access
  // the moment login succeeded, making the emailed credential an ordinary
  // long-lived password and defeating the entire point of provisioning it.
  if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED_ROUTES.has(resolveRequestPath(req))) {
    return res.status(403).json({
      success: false,
      code: "PASSWORD_CHANGE_REQUIRED",
      message: "Password change required before accessing this resource",
    });
  }

  const assignedRoles = user.roles
    .map(({ role }) => role?.name)
    .filter(Boolean);
  const accountRoles = new Set();

  if (assignedRoles.includes("EMPLOYEE")) {
    accountRoles.add("EMPLOYEE");
  }
  if (
    assignedRoles.includes("RECRUITER") ||
    user.organizationMemberships.some(
      ({ role, status }) => role === "RECRUITER" && status === "ACTIVE"
    )
  ) {
    accountRoles.add("RECRUITER");
  }
  if (
    assignedRoles.includes("ORG_ADMIN") &&
    user.organizationMemberships.some(
      ({ role, status }) => role === "ORG_ADMIN" && status !== "REMOVED"
    )
  ) {
    accountRoles.add("ORG_ADMIN");
  }
  if (assignedRoles.includes("SUPER_ADMIN")) {
    accountRoles.add("SUPER_ADMIN");
  }

  if (payload.role && !accountRoles.has(payload.role)) {
    return res.status(401).json(UNAUTHORIZED);
  }

  const role = payload.role ?? ROLE_PRIORITY.find((candidate) => accountRoles.has(candidate));

  if (!role) {
    return res.status(401).json(UNAUTHORIZED);
  }

  req.user = {
    id: user.id,
    role,
    roles: [...accountRoles],
    organizationId: user.organizationMemberships.find(
      ({ role: membershipRole, status }) =>
        ["ORG_ADMIN", "RECRUITER"].includes(membershipRole) && status === "ACTIVE"
    )?.organizationId ?? null,
  };

  next();
};

module.exports = authenticate;

// Test-only introspection hook. `authenticate` is still the module's callable
// export (unchanged for every existing `require`/consumer); the hook is hung
// off the function itself so authenticate.test.js can assert the exact-match
// path resolution without a database.
authenticate.__test = {
  PASSWORD_CHANGE_ALLOWED_ROUTES,
  resolveRequestPath,
};
