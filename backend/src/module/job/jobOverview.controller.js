const jobOverviewService = require("./jobOverview.service");
const {
  resolveSubscriptionAccess,
} = require("../subscription/subscription.service");

// ---------------------------------------------------------------------------
// PHASE 8 — recruiter read-only Jobs overview (thin controller).
//
// READ-ONLY BY CONSTRUCTION: this file registers ONLY GET handlers and never
// imports a mutating service function. It resolves no ownership from the request
// body/params - ownership is derived from the AUTHENTICATED principal by the
// service, exactly like every other recruiter job route.
// ---------------------------------------------------------------------------

// Same { success, message } envelope and 5xx masking the job controller uses.
const sendErrorResponse = (res, context, error) => {
  const status = error.status || 500;
  let message = error.message || "Something went wrong";
  if (error.code === "P2025") {
    return res.status(404).json({ success: false, message: "Job not found" });
  }
  if (status >= 500) {
    console.error(`[jobOverview] ${context}:`, error);
    message = "Something went wrong while processing your request";
  } else {
    console.error(`[jobOverview] ${context}: ${status} ${message}`);
  }
  return res.status(status).json({ success: false, message });
};

// The caller's OWN jobs: independent recruiter -> jobs they posted; organization
// recruiter -> their organization's jobs. Derived from the principal, so a
// client cannot widen this by passing an organizationId.
const deriveOwnership = async (user) => {
  const access = await resolveSubscriptionAccess(user);
  return access.scope === "organization"
    ? { scope: "organization", organizationId: access.organizationId }
    : { scope: "user" };
};

// GET /job/overview/jobs?search=&status=&within=|from=&to=&page=&limit=
const listOverviewJobs = async (req, res) => {
  try {
    const ownership = await deriveOwnership(req.user);
    const result = await jobOverviewService.listOverviewJobs(req.user, ownership, req.query);
    return res.status(200).json({
      success: true,
      message: "Jobs retrieved successfully",
      data: result.jobs,
      pagination: result.pagination,
      filters: result.filters,
    });
  } catch (error) {
    return sendErrorResponse(res, "listOverviewJobs", error);
  }
};

// GET /job/overview/:jobId - the read-only job-details card payload.
const getOverviewJob = async (req, res) => {
  try {
    const result = await jobOverviewService.getOverviewJobDetails(
      req.user,
      req.params.jobId
    );
    return res.status(200).json({
      success: true,
      message: "Job details retrieved successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "getOverviewJob", error);
  }
};

// GET /job/overview/:jobId/candidates?search=&page=&limit=
const listOverviewCandidates = async (req, res) => {
  try {
    const result = await jobOverviewService.listOverviewCandidates(
      req.user,
      req.params.jobId,
      req.query
    );
    return res.status(200).json({
      success: true,
      message: "Candidates retrieved successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "listOverviewCandidates", error);
  }
};

module.exports = {
  listOverviewJobs,
  getOverviewJob,
  listOverviewCandidates,
};
