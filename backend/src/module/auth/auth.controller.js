const {
  registerUser,
  becomeCandidate,
  verifyEmail,
  loginUser,
  switchRole,
  refreshAccessToken,
  logoutUser,
  resendVerificationEmail,
  forgotPassword,
  resetPassword,
  changePassword,
  getMyOnboardingState,
  updateAccountDetails,
  getCandidateProfile,
  getRecruiterProfile,
  saveRecruiterProfile,
  saveCandidateProfile,
  saveCandidateProfileSection,
  getCandidateProfileCompletionStatus,
  getEmployeeDashboard,
  getCandidateCareerLinks,
  saveCandidateCareerLinks,
  linkCandidateResume,
  deleteCandidateResume,
  getRefreshCookieName,
  upsertCandidateEducation,
  deleteCandidateEducation,
  upsertCandidateSkill,
  deleteCandidateSkill,
  upsertCandidateProject,
  deleteCandidateProject,
  upsertCandidateProjectSkill,
  deleteCandidateProjectSkill,
  upsertCandidateCertificate,
  deleteCandidateCertificate,
  setCandidateExperienceLevel,
} = require("./auth.service");

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/api/auth",
};

const register = async (req, res) => {
  try {
    const result = await registerUser(req.body);

    return res.status(201).json({
      success: true,
      message:
        "Registration successful. Please check your email to verify your account.",
      data: result,
    });
  } catch (error) {
    console.error("Registration error:", error);
    if (error.code?.startsWith("P")) {
      console.error("Prisma error", {
        code: error.code,
        message: error.message,
        meta: error.meta,
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const becomeCandidateHandler = async (req, res) => {
  try {
    const user = await becomeCandidate(req.user.id);

    return res.status(200).json({
      success: true,
      message: "Candidate account is ready",
      data: user,
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

const verifyEmailAddress = async (req, res) => {
  try {
    const { token } = req.query;

    const result = await verifyEmail(token);

    return res.status(200).json({
      success: true,
      message: "Email verified successfully.",
      data: result,
    });
  } catch (error) {
    console.error("Email verification error:", error);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await loginUser({
      email,
      password,
      requestedRole: req.body.role,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    // The selector is tab-scoped by the frontend. Its matching refresh secret
    // stays HttpOnly in a distinct cookie, so another tab's login cannot
    // overwrite this session's refresh credential.
    res.cookie(getRefreshCookieName(result.sessionSelector), result.refreshToken, {
      ...REFRESH_COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        accessToken: result.accessToken,
        user: result.user,
        sessionSelector: result.sessionSelector,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(401).json({
      success: false,
      message: error.message,
    });
  }
};


const refresh = async (req, res) => {
  try {
    const sessionSelector = req.get("X-Auth-Session");
    const cookieName = getRefreshCookieName(sessionSelector);
    const refreshToken = req.cookies[cookieName];

    const result = await refreshAccessToken({
      sessionSelector,
      refreshToken,
      requestedRole: req.get("X-Active-Role"),
    });

    res.cookie(cookieName, result.refreshToken, {
      ...REFRESH_COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      message: "Access token refreshed successfully",
      data: {
        accessToken: result.accessToken,
        user: result.user,
      },
    });
  } catch (error) {
    console.error("Refresh token error:", error.message);

    return res.status(401).json({
      success: false,
      message: error.message,
    });
  }
};

// Idempotent, unauthenticated by design (the access token may already be
// expired when the user logs out) — always clears the cookie and returns
// 200, regardless of whether a refresh-token cookie was present or whether
// it matched a live, not-yet-revoked RefreshToken row. Never reveals which
// case applied.
const logout = async (req, res) => {
  const sessionSelector = req.get("X-Auth-Session");
  let cookieName = null;
  let refreshToken = null;

  try {
    cookieName = getRefreshCookieName(sessionSelector);
    refreshToken = req.cookies[cookieName];
  } catch {
    // Preserve logout's idempotent response without trusting malformed input.
  }

  try {
    await logoutUser({ sessionSelector, refreshToken });
  } catch (error) {
    console.error("Logout error:", error.message);
  }

  if (cookieName) {
    res.clearCookie(cookieName, REFRESH_COOKIE_OPTIONS);
  }

  res.set("Cache-Control", "no-store");

  return res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
};

const resendVerification = async(req,res)=>{

try{

const result =
await resendVerificationEmail(
req.body.email
);


return res.status(200).json({
 success:true,
 message:result.message
});


}catch(error){

return res.status(400).json({
 success:false,
 message:error.message
});

}

};

const forgotPasswordHandler = async (req, res) => {
  try {
    const result = await forgotPassword(req.body.email);

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    console.error("Forgot password error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const resetPasswordHandler = async (req, res) => {
  try {
    const { token, password } = req.body;

    const result = await resetPassword({ token, password });

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    console.error("Reset password error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const changePasswordHandler = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const result = await changePassword({
      userId: req.user.id,
      currentPassword,
      newPassword,
    });

    return res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    console.error("Change password error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const me = async (req, res) => {
  try {
    const state = await getMyOnboardingState(req.user.id, req.user.role);

    return res.status(200).json({
      success: true,
      data: {
        ...req.user,
        ...state,
      },
    });
  } catch (error) {
    console.error("Me error:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const updateAccount = async (req, res) => {
  try {
    const result = await updateAccountDetails({
      userId: req.user.id,
      data: req.body,
    });

    return res.status(200).json({
      success: true,
      message: "Account information updated successfully",
      data: result.user,
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

const getCandidateProfileHandler = async (req, res) => {
  try {
    const result = await getCandidateProfile(req.user.id);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

const getRecruiterProfileHandler = async (req, res) => {
  try {
    const result = await getRecruiterProfile(req.user.id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const saveRecruiterProfileHandler = async (req, res) => {
  try {
    const result = await saveRecruiterProfile({ userId: req.user.id, data: req.body });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const saveCandidateProfileHandler = async (req, res) => {
  try {
    const result = await saveCandidateProfile({
      userId: req.user.id,
      profileData: req.body,
    });

    return res.status(200).json({
      success: true,
      message: "Candidate profile saved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
};

const getCandidateCompletionHandler = async (req, res) => {
  try {
    const result = await getCandidateProfileCompletionStatus(req.user.id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const getCandidateCareerLinksHandler = async (req, res) => {
  try {
    const result = await getCandidateCareerLinks(req.user.id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const saveCandidateCareerLinksHandler = async (req, res) => {
  try {
    const result = await saveCandidateCareerLinks({ userId: req.user.id, data: req.body });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const linkCandidateResumeHandler = async (req, res) => {
  try {
    const result = await linkCandidateResume({ userId: req.user.id, fileId: req.body.fileId });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const deleteCandidateResumeHandler = async (req, res) => {
  try {
    const result = await deleteCandidateResume(req.user.id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const markCandidateProfileCompleteHandler = async (req, res) => {
  try {
    const result = await getCandidateProfileCompletionStatus(req.user.id);
    if (!result.isComplete) {
      return res.status(400).json({
        success: false,
        code: "PROFILE_INCOMPLETE",
        message: "Complete all required profile fields before finishing setup.",
        data: { missingFields: result.missingFields },
      });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const getEmployeeDashboardHandler = async (req, res) => {
  try {
    const result = await getEmployeeDashboard(req.user.id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const saveCandidateProfileSectionHandler = async (req, res) => {
  try {
    const result = await saveCandidateProfileSection({
      userId: req.user.id,
      section: req.body.section,
      data: req.body.data ?? req.body,
    });

    return res.status(200).json({ success: true, message: "Candidate profile section saved", data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const addCandidateEducationHandler = async (req, res) => {
  try {
    const result = await upsertCandidateEducation({ userId: req.user.id, educationId: req.params.id || null, data: req.body });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const deleteCandidateEducationHandler = async (req, res) => {
  try {
    const result = await deleteCandidateEducation({ userId: req.user.id, educationId: req.params.id });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const addCandidateSkillHandler = async (req, res) => {
  try {
    const result = await upsertCandidateSkill({ userId: req.user.id, skillId: req.params.id || null, data: req.body });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const deleteCandidateSkillHandler = async (req, res) => {
  try {
    const result = await deleteCandidateSkill({ userId: req.user.id, skillId: req.params.id });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const addCandidateProjectHandler = async (req, res) => {
  try {
    const result = await upsertCandidateProject({ userId: req.user.id, projectId: req.params.id || null, data: req.body });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const deleteCandidateProjectHandler = async (req, res) => {
  try {
    const result = await deleteCandidateProject({ userId: req.user.id, projectId: req.params.id });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const addCandidateProjectSkillHandler = async (req, res) => {
  try {
    const result = await upsertCandidateProjectSkill({
      userId: req.user.id,
      projectId: req.params.projectId,
      projectSkillId: req.params.projectSkillId || null,
      data: req.body,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const deleteCandidateProjectSkillHandler = async (req, res) => {
  try {
    const result = await deleteCandidateProjectSkill({ userId: req.user.id, projectId: req.params.projectId, projectSkillId: req.params.projectSkillId });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const addCandidateCertificateHandler = async (req, res) => {
  try {
    const result = await upsertCandidateCertificate({ userId: req.user.id, certificateId: req.params.id || null, data: req.body });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const deleteCandidateCertificateHandler = async (req, res) => {
  try {
    const result = await deleteCandidateCertificate({ userId: req.user.id, certificateId: req.params.id });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const setCandidateExperienceLevelHandler = async (req, res) => {
  try {
    const result = await setCandidateExperienceLevel({ userId: req.user.id, experienceLevel: req.body.experienceLevel });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

const switchRoleHandler = async (req, res) => {
  try {
    const result = await switchRole(req.user.id, req.body.role);

    return res.status(200).json({
      success: true,
      message: "Role switched successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 403).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  register,
  becomeCandidate: becomeCandidateHandler,
  verifyEmailAddress,
  login,
  refresh,
  logout,
  resendVerification,
  forgotPassword: forgotPasswordHandler,
  resetPassword: resetPasswordHandler,
  changePassword: changePasswordHandler,
  me,
  updateAccount,
  getCandidateProfile: getCandidateProfileHandler,
  getRecruiterProfile: getRecruiterProfileHandler,
  saveRecruiterProfile: saveRecruiterProfileHandler,
  saveCandidateProfile: saveCandidateProfileHandler,
  getCandidateCompletion: getCandidateCompletionHandler,
  markCandidateProfileComplete: markCandidateProfileCompleteHandler,
  getEmployeeDashboard: getEmployeeDashboardHandler,
  getCandidateCareerLinks: getCandidateCareerLinksHandler,
  saveCandidateCareerLinks: saveCandidateCareerLinksHandler,
  linkCandidateResume: linkCandidateResumeHandler,
  deleteCandidateResume: deleteCandidateResumeHandler,
  saveCandidateProfileSection: saveCandidateProfileSectionHandler,
  addCandidateEducation: addCandidateEducationHandler,
  deleteCandidateEducation: deleteCandidateEducationHandler,
  addCandidateSkill: addCandidateSkillHandler,
  deleteCandidateSkill: deleteCandidateSkillHandler,
  addCandidateProject: addCandidateProjectHandler,
  deleteCandidateProject: deleteCandidateProjectHandler,
  addCandidateProjectSkill: addCandidateProjectSkillHandler,
  deleteCandidateProjectSkill: deleteCandidateProjectSkillHandler,
  addCandidateCertificate: addCandidateCertificateHandler,
  deleteCandidateCertificate: deleteCandidateCertificateHandler,
  setCandidateExperienceLevel: setCandidateExperienceLevelHandler,
  switchRole: switchRoleHandler,
};

