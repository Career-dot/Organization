import apiClient from "./apiClient";

// Every one of these hits an /api/admin/* route, which the backend gates on
// authenticate + authorize("SUPER_ADMIN") independently.

export const getDashboardStatistics = async (timeRange = "all") => {
  const { data } = await apiClient.get(`/admin/dashboard?timeRange=${timeRange}`);
  return data;
};

export const listOrganizations = async (params = {}) => {
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  );
  const query = searchParams.toString();
  const { data } = await apiClient.get(`/admin/organizations${query ? `?${query}` : ""}`);
  return data;
};

export const getOrganizationDetail = async (organizationId) => {
  const { data } = await apiClient.get(`/admin/organizations/${organizationId}`);
  return data;
};

export const getOrganizationSubscription = async (organizationId) => {
  const { data } = await apiClient.get(`/admin/organizations/${organizationId}/subscription`);
  return data;
};

export const listRecruiters = async (params = {}) => {
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  );
  const query = searchParams.toString();
  const { data } = await apiClient.get(`/admin/recruiters${query ? `?${query}` : ""}`);
  return data;
};

export const getRecruiterDetail = async (recruiterId) => {
  const { data } = await apiClient.get(`/admin/recruiters/${recruiterId}`);
  return data;
};

export const listPlans = async () => {
  const { data } = await apiClient.get("/admin/plans");
  return data;
};

export const createPlan = async (plan) => {
  const { data } = await apiClient.post("/admin/plans", plan);
  return data;
};

export const updatePlan = async (planId, updates) => {
  const { data } = await apiClient.patch(`/admin/plans/${planId}`, updates);
  return data;
};

export const listAuditLogs = async (filters = {}) => {
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  );
  const query = params.toString();
  const { data } = await apiClient.get(`/admin/audit-logs${query ? `?${query}` : ""}`);
  return data;
};

