import apiClient from "./apiClient";
import { clearAuthSession } from "./authSession";

export const registerUser = async (payload) => {
  const { data } = await apiClient.post("/auth/register", payload);
  return data;
};

export const verifyEmail = async (token) => {
  const { data } = await apiClient.get("/auth/verify-email", {
    params: { token },
  });
  return data;
};
export const loginUser = async (payload) => {
  const { data } = await apiClient.post("/auth/login", payload);
  return data;
};

export const switchRole = async (role) => {
  const { data } = await apiClient.post("/auth/switch-role", { role });
  return data;
};

export const becomeCandidate = async () => {
  const { data } = await apiClient.post("/auth/become-candidate");
  return data;
};

export const getCandidateProfile = async () => {
  const { data } = await apiClient.get("/auth/employee/profile");
  return data;
};

export const getRecruiterProfile = async () => {
  const { data } = await apiClient.get("/auth/recruiter/profile");
  return data;
};

export const saveRecruiterProfile = async (payload) => {
  const { data } = await apiClient.put("/auth/recruiter/profile", payload);
  return data;
};

export const saveCandidateProfile = async (payload) => {
  const { data } = await apiClient.post("/auth/employee/profile", payload);
  return data;
};

export const getCandidateProfileCompletion = async () => {
  const { data } = await apiClient.get("/auth/employee/profile/completion");
  return data;
};

export const listEmployeeFiles = async () => {
  const { data } = await apiClient.get("/files");
  return data;
};

export const uploadEmployeeFile = async ({ category, file, employeeProfileId, skillId, certificateId, projectId }) => {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("category", category);
  if (employeeProfileId) formData.append("employeeProfileId", employeeProfileId);
  if (skillId) formData.append("skillId", skillId);
  if (certificateId) formData.append("certificateId", certificateId);
  if (projectId) formData.append("projectId", projectId);
  const { data } = await apiClient.post("/files", formData);
  return data;
};

export const fetchEmployeeFileUrl = async (fileId, disposition = "view") => {
  const { data } = await apiClient.get(`/files/${fileId}/${disposition}`, {
    responseType: "blob",
  });
  return URL.createObjectURL(data);
};

export const deleteEmployeeFile = async (id) => {
  const { data } = await apiClient.delete(`/files/${id}`);
  return data;
};

export const buildEmployeeFileUrl = (fileId, disposition = "view") => `${import.meta.env.VITE_API_URL}/files/${fileId}/${disposition}`;

export const getEmployeeDashboard = async () => {
  const { data } = await apiClient.get("/auth/employee/dashboard");
  return data;
};

export const getCandidateCareerLinks = async () => {
  const { data } = await apiClient.get("/auth/employee/career-links");
  return data;
};

export const saveCandidateCareerLinks = async (payload) => {
  const { data } = await apiClient.put("/auth/employee/career-links", payload);
  return data;
};

export const linkCandidateResume = async (fileId) => {
  const { data } = await apiClient.put("/auth/employee/career-links/resume", { fileId });
  return data;
};

export const deleteCandidateResume = async () => {
  const { data } = await apiClient.delete("/auth/employee/career-links/resume");
  return data;
};

const employeeResource = (resource) => `/auth/employee/profile/${resource}`;

export const saveCandidateProfileSection = async (section, data) => {
  const response = await apiClient.post("/auth/employee/profile", { section, data });
  return response.data;
};

export const saveCandidateEducation = async (payload, id) => {
  const response = await apiClient({ method: id ? "put" : "post", url: id ? `${employeeResource("education")}/${id}` : employeeResource("education"), data: payload });
  return response.data;
};

export const deleteCandidateEducation = async (id) => (await apiClient.delete(`${employeeResource("education")}/${id}`)).data;

export const saveCandidateSkill = async (payload, id) => {
  const response = await apiClient({ method: id ? "put" : "post", url: id ? `${employeeResource("skills")}/${id}` : employeeResource("skills"), data: payload });
  return response.data;
};

export const deleteCandidateSkill = async (id) => (await apiClient.delete(`${employeeResource("skills")}/${id}`)).data;

export const saveCandidateProject = async (payload, id) => {
  const response = await apiClient({ method: id ? "put" : "post", url: id ? `${employeeResource("projects")}/${id}` : employeeResource("projects"), data: payload });
  return response.data;
};

export const deleteCandidateProject = async (id) => (await apiClient.delete(`${employeeResource("projects")}/${id}`)).data;

export const saveCandidateProjectSkill = async (projectId, payload, id) => {
  const base = `${employeeResource("projects")}/${projectId}/skills`;
  const response = await apiClient({ method: id ? "put" : "post", url: id ? `${base}/${id}` : base, data: payload });
  return response.data;
};

export const deleteCandidateProjectSkill = async (projectId, id) => (await apiClient.delete(`${employeeResource("projects")}/${projectId}/skills/${id}`)).data;

export const saveCandidateCertificate = async (payload, id) => {
  const response = await apiClient({ method: id ? "put" : "post", url: id ? `${employeeResource("certificates")}/${id}` : employeeResource("certificates"), data: payload });
  return response.data;
};

export const deleteCandidateCertificate = async (id) => (await apiClient.delete(`${employeeResource("certificates")}/${id}`)).data;

export const markCandidateProfileComplete = async () => {
  const response = await apiClient.post(`${employeeResource("mark-complete")}`, { markComplete: true });
  return response.data;
};

// Re-fetches the authenticated user's current status/onboarding state from
// the backend (e.g. right after a payment) rather than trusting anything
// held in frontend state.
export const getCurrentUser = async () => {
  const { data } = await apiClient.get("/auth/me");
  return data;
};

export const updateAccount = async (payload) => {
  const { data } = await apiClient.put("/auth/account", payload);
  return data;
};

export const updateAccountDetails = async (payload) => {
  const { data } = await apiClient.put("/auth/account", payload);
  return data;
};

export const resendVerificationEmail = async (email) => {
  const { data } = await apiClient.post("/auth/resend-verification", {
    email,
  });
  return data;
};

export const forgotPassword = async (email) => {
  const { data } = await apiClient.post("/auth/forgot-password", {
    email,
  });
  return data;
};

export const resetPassword = async ({ token, password }) => {
  const { data } = await apiClient.post("/auth/reset-password", {
    token,
    password,
  });
  return data;
};

// Authenticated — clears mustChangePassword as a side effect (see
// updateUserPassword in the backend's auth.repository.js).
export const changePassword = async ({ currentPassword, newPassword }) => {
  const { data } = await apiClient.post("/auth/change-password", {
    currentPassword,
    newPassword,
  });
  return data;
};

// Best-effort: the client-side session is cleared even if the backend call
// fails (e.g. offline) so the user is never stuck appearing "logged in".
// The backend revokes the refresh token and clears its cookie server-side —
// see POST /api/auth/logout in auth.routes.js.
export const logout = async () => {
  try {
    await apiClient.post("/auth/logout");
  } catch {
    // Ignored deliberately — see comment above.
  } finally {
    clearAuthSession();
  }
};

// Assessment & Skill Verification APIs
export const generateSkillAssessment = async (skillId, payload = {}) => {
  const { data } = await apiClient.post(`/auth/employee/skills/${skillId}/assessments/generate`, payload);
  return data;
};

export const startSkillAssessment = async (skillId, assessmentId) => {
  const { data } = await apiClient.post(`/auth/employee/skills/${skillId}/assessments/${assessmentId}/start`);
  return data;
};

export const cancelSkillAssessment = async (skillId, attemptId) => {
  const { data } = await apiClient.post(`/auth/employee/skills/${skillId}/verification/attempts/${attemptId}/cancel`);
  return data;
};

export const recordAssessmentViolation = async (skillId, attemptId, violationType) => {
  const { data } = await apiClient.post(`/auth/employee/skills/${skillId}/verification/attempts/${attemptId}/violation`, { violationType });
  return data;
};

export const submitSkillAssessment = async (assessmentId, attemptId, answers) => {
  const { data } = await apiClient.post(`/auth/employee/assessments/${assessmentId}/attempts/${attemptId}/submit`, { answers });
  return data;
};

export const scoreSkillAssessment = async (assessmentId, attemptId) => {
  const { data } = await apiClient.post(`/auth/employee/assessments/${assessmentId}/attempts/${attemptId}/score`);
  return data;
};

export const prepareVerificationEvidence = async (skillId, attemptId) => {
  const { data } = await apiClient.post(`/auth/employee/skills/${skillId}/verification-evidence/prepare`, { attemptId });
  return data;
};

export const analyzeVerification = async (skillId, attemptId, forceRetry = false) => {
  const { data } = await apiClient.post(`/auth/employee/skills/${skillId}/verification/analyze`, { attemptId, forceRetry });
  return data;
};

export const getSkillVerificationEligibility = async (skillId) => {
  const { data } = await apiClient.get(`/auth/employee/skills/${skillId}/verification/eligibility`);
  return data;
};

export const getLatestVerificationReport = async (skillId) => {
  const { data } = await apiClient.get(`/auth/employee/skills/${skillId}/verification/reports/latest`);
  return data;
};

export const getActiveVerificationAttempt = async (skillId) => {
  const { data } = await apiClient.get(`/auth/employee/skills/${skillId}/verification/attempts/active`);
  return data;
};

export const getEmployeeNotifications = async () => {
  const { data } = await apiClient.get("/auth/employee/notifications");
  return data;
};

export const markEmployeeNotificationRead = async (notificationId) => {
  const { data } = await apiClient.patch(`/auth/employee/notifications/${notificationId}/read`);
  return data;
};

export const getDashboardVerificationSummary = async () => {
  const { data } = await apiClient.get("/auth/employee/dashboard/verification-summary");
  return data;
};

