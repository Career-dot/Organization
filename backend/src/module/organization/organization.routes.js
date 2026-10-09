const express = require("express");

const {
  getMe,
  getBranding,
  getRecruiters,
  createRecruiter,
  patchRecruiterStatus,
  deleteRecruiter,
  postResetCredentials,
  putOrganizationProfile,
  getAuditSummary,
  getAuditRecruiters,
  getAuditRecruiterJobs,
  getAuditAnalytics,
  getAuditOrganizationJobs,
} = require("./organization.controller");

const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const checkSubscription = require("../../middleware/checkSubscription");
const validate = require("../../middleware/validate");
const {
  createRecruiterLimiter,
  resetRecruiterCredentialsLimiter,
  deleteRecruiterLimiter,
} = require("../../middleware/rateLimit");

const {
  createRecruiterSchema,
  updateStatusSchema,
  updateOrganizationProfileSchema,
} = require("./organization.validation");

const router = express.Router();

// Everything below scopes strictly to the authenticated ORG_ADMIN's own
// organization (resolved server-side in organization.service.js) — none of
// these routes accept an organizationId from the client. checkSubscription
// gates all of it behind the organization's own active subscription — this
// is dashboard/management functionality the organization is paying for, not
// the checkout path itself (which resolves membership without requiring
// ACTIVE — see resolveOwnerContext in subscription.service.js).
router.get(
  "/me",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  getMe
);

router.get(
  "/branding",
  authenticate,
  authorize("ORG_ADMIN", "RECRUITER"),
  checkSubscription,
  getBranding
);

// Updates organization profile (website, businessEmail) for the
// authenticated ORG_ADMIN's own organization. Does not require active
// subscription (allowed during setup before payment).
router.put(
  "/profile",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  validate(updateOrganizationProfileSchema),
  putOrganizationProfile
);

router.get(
  "/recruiters",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  getRecruiters
);

// Creates a normal, immediately-usable RECRUITER account (temporary password
// emailed, no invitation link/token — see organization.service.js). The
// recruiter gets the SAME global RECRUITER capabilities as any other recruiter;
// there is no per-recruiter permission selection.
//
// The limiter runs AFTER authenticate/authorize so it only ever throttles
// authorized ORG_ADMINs (and a caller who fails authorization never reaches
// it). createRecruiterLimiter bounds how fast one admin can mint accounts.
router.post(
  "/recruiters",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  createRecruiterLimiter,
  validate(createRecruiterSchema),
  createRecruiter
);

router.patch(
  "/recruiters/:membershipId/status",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  validate(updateStatusSchema),
  patchRecruiterStatus
);

// PHASE 1 — PERMANENT DELETE (distinct from the reversible "Remove" above).
//
// DELETE /recruiters/:userId permanently deletes the recruiter ACCOUNT: the User
// row, its RECRUITER UserRole, its OrganizationMembership, its sessions, refresh
// tokens and recruiter profile are all destroyed. It cannot be undone and the
// recruiter can never authenticate again.
//
// It is addressed by recruiter userId (not membershipId) because the membership
// row is itself deleted, exactly like reset-credentials. The service scopes it to
// the caller's own server-resolved organization and re-validates the membership
// inside the transaction, so a cross-organization delete is a 404.
//
// Historical JOBS deliberately survive: their ownership link is SetNull (see
// migration 20261003120000), because a job's candidates, attempts and analyses
// are the organization's audit record, not the recruiter's.
//
// No request body is read, so no validation schema is needed and no body field
// (in particular no organizationId) can influence authorization.
router.delete(
  "/recruiters/:userId",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  deleteRecruiterLimiter,
  deleteRecruiter
);

// Addressed by recruiter userId (organization.service.js's
// resetAndResendCredentials resolves the membership by userId + the
// caller's own server-resolved organizationId) — an ORG_ADMIN can only reset
// credentials for a recruiter inside their own organization, and only while
// that recruiter is ACTIVE.
router.post(
  "/recruiters/:userId/reset-credentials",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  resetRecruiterCredentialsLimiter,
  postResetCredentials
);

// ---------------------------------------------------------------------------
// ORG ADMIN READ-ONLY AUDIT DASHBOARD
//
// Every route here is a GET and every one of them is scoped to the
// authenticated ORG_ADMIN's OWN organization, resolved server-side by
// resolveAdminOrganization. No route accepts an organizationId. The only path
// parameter is a recruiter's user id, which is re-validated server-side against
// an ACTIVE membership in the caller's own organization.
//
// NOT created here, because they already exist and already authorize ORG_ADMIN
// of the same organization (job.routes.js):
//   GET /api/job/overview/:jobId                     -> job details (read-only)
//   GET /api/job/overview/:jobId/candidates          -> candidates + scores
//   GET /api/job/:jobId/candidate-references/:id/analysis
//   GET /api/job/:jobId/candidates/:refId/verification-report
//   GET /api/realtime/candidates/:jobId/events       -> SSE (notification only)
// Reusing those keeps ONE implementation of job/candidate/report reads rather
// than a second org-scoped copy of each.
// ---------------------------------------------------------------------------

router.get(
  "/dashboard/summary",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  getAuditSummary
);

router.get(
  "/dashboard/analytics",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  getAuditAnalytics
);

// /recruiters/audit is registered BEFORE /recruiters/:recruiterId/jobs only by
// convention; Express matches the literal "/recruiters" route first because the
// audit routes have distinct literal prefixes, so there is no shadowing.
router.get(
  "/recruiters/audit",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  getAuditRecruiters
);

// PHASE 5 — JOB ANALYSIS: every job in the caller's own organization.
// Registered before /recruiters/:recruiterId/jobs because the literal prefixes
// differ, so there is no route shadowing.
router.get(
  "/dashboard/jobs",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  getAuditOrganizationJobs
);

router.get(
  "/recruiters/:recruiterId/jobs",
  authenticate,
  authorize("ORG_ADMIN"),
  checkSubscription,
  getAuditRecruiterJobs
);

module.exports = router;
