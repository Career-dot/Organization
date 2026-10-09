const {
  getOrganizationSummary,
  getOrganizationBranding,
  listRecruiters,
  provisionOrganizationRecruiter,
  updateRecruiterStatus,
  permanentlyDeleteRecruiter,
  resetAndResendCredentials,
  updateOrganizationProfile,
  getAuditDashboardSummary,
  listAuditRecruiters,
  listAuditRecruiterJobs,
  getAuditAnalytics,
  listAuditOrganizationJobs,
} = require("./organization.service");

const respondError = (res, error, fallbackStatus = 400) => {
  console.error("Organization module error:", error.message);

  return res.status(error.status || fallbackStatus).json({
    success: false,
    message: error.message,
  });
};

const getMe = async (req, res) => {
  try {
    const summary = await getOrganizationSummary(req.user);

    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    return respondError(res, error);
  }
};

const getBranding = async (req, res) => {
  try {
    const branding = await getOrganizationBranding(req.user);
    return res.status(200).json({ success: true, data: branding });
  } catch (error) {
    return respondError(res, error);
  }
};

const getRecruiters = async (req, res) => {
  try {
    const recruiters = await listRecruiters(req.user);

    return res.status(200).json({ success: true, data: recruiters });
  } catch (error) {
    return respondError(res, error);
  }
};

const createRecruiter = async (req, res) => {
  try {
    const recruiter = await provisionOrganizationRecruiter(req.user, req.body);

    // The recruiter/membership rows are created either way — only the
    // message differs, so the frontend never claims the email went out when
    // it didn't. success stays true because the recruiter record itself was
    // created successfully; emailSent is what the UI should actually key
    // its messaging off of.
    return res.status(201).json({
      success: true,
      message: recruiter.emailSent
        ? "Temporary credentials sent by email"
        : "Recruiter created, but the credentials email could not be sent. Use Reset & Resend Credentials to try again.",
      data: recruiter,
    });
  } catch (error) {
    return respondError(res, error);
  }
};

const patchRecruiterStatus = async (req, res) => {
  try {
    const result = await updateRecruiterStatus(
      req.user,
      req.params.membershipId,
      req.body.status
    );

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return respondError(res, error);
  }
};

const postResetCredentials = async (req, res) => {
  try {
    const result = await resetAndResendCredentials(req.user, req.params.userId);

    return res.status(200).json({
      success: true,
      message: result.emailSent
        ? "New temporary credentials sent by email"
        : "Could not send the credentials email. Please try again.",
      data: result,
    });
  } catch (error) {
    return respondError(res, error);
  }
};

// PHASE 1 — PERMANENT recruiter deletion.
//
// Genuinely destructive: the User row is deleted, not flagged. The message is
// explicit that this is permanent and that historical job data is preserved, so
// the UI cannot imply the jobs were removed too.
const deleteRecruiter = async (req, res) => {
  try {
    const result = await permanentlyDeleteRecruiter(req.user, req.params.userId);

    return res.status(200).json({
      success: true,
      message:
        "The recruiter account was permanently deleted. This cannot be undone. " +
        "Their historical jobs and candidate records were retained.",
      data: result,
    });
  } catch (error) {
    return respondError(res, error);
  }
};

const putOrganizationProfile = async (req, res) => {
  try {
    const result = await updateOrganizationProfile(req.user, req.body);

    return res.status(200).json({
      success: true,
      message: "Organization profile updated",
      data: result,
    });
  } catch (error) {
    return respondError(res, error);
  }
};

// ---------------------------------------------------------------------------
// ORG ADMIN READ-ONLY AUDIT DASHBOARD — thin GET handlers.
//
// Every handler is a GET and resolves the organization server-side inside the
// service (resolveAdminOrganization). Nothing here reads organizationId,
// recruiterId or jobId from the body as an authorization input: the only path
// parameter is the recruiter's user id, which the service re-validates against
// an ACTIVE membership in the CALLER'S OWN organization.
// ---------------------------------------------------------------------------

const getAuditSummary = async (req, res) => {
  try {
    const data = await getAuditDashboardSummary(req.user);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

const getAuditRecruiters = async (req, res) => {
  try {
    const data = await listAuditRecruiters(req.user, req.query);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

const getAuditRecruiterJobs = async (req, res) => {
  try {
    const data = await listAuditRecruiterJobs(req.user, req.params.recruiterId, req.query);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

const getAuditAnalyticsHandler = async (req, res) => {
  try {
    const data = await getAuditAnalytics(req.user, req.query);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

// PHASE 5 — the JOB ANALYSIS section's organization-wide job list. Read-only.
const getAuditOrganizationJobs = async (req, res) => {
  try {
    const data = await listAuditOrganizationJobs(req.user, req.query);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return respondError(res, error);
  }
};

module.exports = {
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
  getAuditAnalytics: getAuditAnalyticsHandler,
  getAuditOrganizationJobs,
};
