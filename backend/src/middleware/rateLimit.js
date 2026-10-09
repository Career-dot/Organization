const { rateLimit } = require("express-rate-limit");

// Route-specific limiters for auth-sensitive endpoints, keyed by IP
// (express-rate-limit's default). Uses the default in-memory store — counts
// are per Node process, reset on restart, and are NOT shared across
// instances. That's fine for the current single-instance architecture; once
// this backend is horizontally scaled to more than one instance, a shared
// store (e.g. Redis, via express-rate-limit's RedisStore) will be required,
// since each instance would otherwise track independent counts and the
// effective limit would multiply by the instance count.
const createLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
  });

const registerLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Too many registration attempts. Please try again later.",
});

const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please try again later.",
});

const forgotPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many password reset requests. Please try again later.",
});

const resetPasswordLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please try again later.",
});

const refreshLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many requests. Please try again later.",
});

const resendVerificationLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many verification email requests. Please try again later.",
});

const changePasswordLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please try again later.",
});

const logoutLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many requests. Please try again later.",
});

// PHASE 1 — permanent recruiter deletion is IRREVERSIBLE, so it gets its own
// deliberately tight limiter. It is meant for a rare, deliberate admin action
// (offboarding one account), not for anything a UI loop can trigger; the low
// ceiling is what limits the damage of a compromised ORG_ADMIN session or an
// accidental script hammering the endpoint. Runs AFTER authenticate/authorize so
// it only ever throttles an authorized ORG_ADMIN.
const deleteRecruiterLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Too many recruiter deletions. Please try again later.",
});

const createRecruiterLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message:
    "Too many recruiter invitations from this address. Please try again later.",
});

// Tighter than creation: every successful reset generates a new temporary
// password, runs a bcrypt hash, revokes all of that recruiter's sessions AND
// sends an email — so an unlimited endpoint is both a mail-flood and a
// forced-logout vector. 10/hour leaves plenty of room for legitimate
// administration (an admin resetting several recruiters after a password
// policy change) while bounding the blast radius.
const resetRecruiterCredentialsLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message:
    "Too many credential reset attempts. Please try again later.",
});

module.exports = {
  registerLimiter,
  loginLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  refreshLimiter,
  resendVerificationLimiter,
  changePasswordLimiter,
  logoutLimiter,
  createRecruiterLimiter,
  resetRecruiterCredentialsLimiter,
  deleteRecruiterLimiter,
};
