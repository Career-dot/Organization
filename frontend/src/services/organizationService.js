import apiClient from "./apiClient";

// All of these are scoped server-side to the authenticated ORG_ADMIN's own
// organization (resolved from their OrganizationMembership) — none of them
// take or send an organizationId.

export const getOrganizationSummary = async () => {
  const { data } = await apiClient.get("/organization/me");
  return data;
};

export const getOrganizationBranding = async () => {
  const { data } = await apiClient.get("/organization/branding");
  return data;
};

export const listRecruiters = async () => {
  const { data } = await apiClient.get("/organization/recruiters");
  return data;
};

// Invites a recruiter into the caller's organization: the account is created
// immediately, a temporary password is generated SERVER-SIDE, hashed and
// emailed to the recruiter, and they must change it at first login before any
// recruiter functionality is available.
//
// Only fullName + email are ever sent. There is deliberately no `permissions`
// field — organization recruiters all receive the same global RECRUITER
// capabilities. The backend schema is `.strict()`, so sending one would be a
// 400 rather than a silent no-op.
//
// No password is supplied here or returned in the response. `res.data.emailSent`
// reports whether the credentials email actually went out; when it is false the
// account still exists and must be recovered with resetCredentials() below.
export const createRecruiter = async ({ fullName, email }) => {
  const { data } = await apiClient.post("/organization/recruiters", {
    fullName,
    email,
  });
  return data;
};

export const setRecruiterStatus = async (membershipId, status) => {
  const { data } = await apiClient.patch(
    `/organization/recruiters/${membershipId}/status`,
    { status }
  );
  return data;
};

// Addressed by the recruiter's userId, not membershipId — must match the
// backend route in organization.routes.js. Generates a brand-new temporary
// password (invalidating the old one) and emails it — only valid for
// currently ACTIVE recruiters. This is the single recovery/resend path; there
// is no separate invitation-resend endpoint.
export const resetCredentials = async (userId) => {
  const { data } = await apiClient.post(
    `/organization/recruiters/${userId}/reset-credentials`
  );
  return data;
};

// PHASE 1 — PERMANENT delete.
//
// This is a real, irreversible account deletion on the server (the User row is
// destroyed), NOT the reversible `setRecruiterStatus(..., "REMOVED")` above,
// which only flips the membership status and leaves the account intact.
//
// It is deliberately named "delete" and never "remove", so no layer of the UI can
// understate how destructive it is.
//
// No organizationId is sent: the server resolves the caller's own organization
// from the authenticated session, and rejects any recruiter outside it.
export const deleteRecruiter = async (userId) => {
  const { data } = await apiClient.delete(`/organization/recruiters/${userId}`);
  return data;
};

// ---------------------------------------------------------------------------
// ORG ADMIN READ-ONLY AUDIT DASHBOARD.
//
// Read-only aggregation endpoints. They resolve the caller's organization
// server-side; none of them sends an organizationId.
//
// Note what is deliberately NOT here: job details, the candidate list, the
// verification report and the candidate analysis all already exist and already
// authorize an ORG_ADMIN of the same organization, so the dashboard reuses the
// existing jobService calls (getOverviewJob, getOverviewCandidates,
// getCandidateAnalysis, getCandidateVerificationReport) rather than adding a
// second org-scoped copy of each.
// ---------------------------------------------------------------------------

export const getAuditSummary = async () => {
  const { data } = await apiClient.get("/organization/dashboard/summary");
  return data;
};

export const getAuditAnalytics = async (params = {}) => {
  const { data } = await apiClient.get("/organization/dashboard/analytics", { params });
  return data;
};

// Includes each recruiter's activity statistics, the organization seat usage,
// and the unattributed historical jobs bucket (Phase 2).
//
// `selected` and `hiring` come back null/unavailable because the platform persists
// no per-candidate selected or hired state — they are never derived from a score,
// an AI analysis or an invitation.
//
// `search` is applied SERVER-SIDE (recruiter name + email); it is not a React-side
// filter. `pagination` reflects the searched result set.
export const getAuditRecruiters = async (params = {}) => {
  const { data } = await apiClient.get("/organization/recruiters/audit", { params });
  return data;
};

export const getAuditRecruiterJobs = async (recruiterId, params = {}) => {
  const { data } = await apiClient.get(
    `/organization/recruiters/${recruiterId}/jobs`,
    { params }
  );
  return data;
};

// PHASE 5 — Job Analysis: every job in the caller's organization.
export const getAuditOrganizationJobs = async (params = {}) => {
  const { data } = await apiClient.get("/organization/dashboard/jobs", { params });
  return data;
};

// Updates the organization's profile (website, businessEmail). Scoped server-side
// to the authenticated ORG_ADMIN's own organization.
export const updateOrganizationProfile = async (profileData) => {
  const { data } = await apiClient.put("/organization/profile", profileData);
  return data;
};

