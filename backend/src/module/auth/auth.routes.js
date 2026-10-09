const express = require("express");

const {
  register,
  becomeCandidate,
  verifyEmailAddress,
  login,
  refresh,
  logout,
  resendVerification,
  forgotPassword,
  resetPassword,
  changePassword,
  me,
  updateAccount,
  getCandidateProfile,
  getRecruiterProfile,
  saveRecruiterProfile,
  saveCandidateProfile,
  getCandidateCompletion,
  markCandidateProfileComplete,
  getEmployeeDashboard,
  getCandidateCareerLinks,
  saveCandidateCareerLinks,
  linkCandidateResume,
  deleteCandidateResume,
  saveCandidateProfileSection,
  addCandidateEducation,
  deleteCandidateEducation,
  addCandidateSkill,
  deleteCandidateSkill,
  addCandidateProject,
  deleteCandidateProject,
  addCandidateProjectSkill,
  deleteCandidateProjectSkill,
  addCandidateCertificate,
  deleteCandidateCertificate,
  setCandidateExperienceLevel,
  switchRole,
} = require("./auth.controller");

const validate = require("../../middleware/validate");
const {
  registerSchema,
  changePasswordSchema,
  accountSettingsSchema,
  switchRoleSchema,
  candidateProfileSectionSchema,
  recruiterProfileSchema,
  candidateEducationSchema,
  candidateSkillSchema,
  candidateProjectSchema,
  candidateProjectSkillSchema,
  candidateCertificateSchema,
  candidateProfileCompletionSchema,
  candidateExperienceLevelSchema,
  candidateCareerLinksSchema,
} = require("./auth.validation");
const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const requireEmployeeProfileComplete = require("../../middleware/requireEmployeeProfileComplete");
const {
  loginLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  refreshLimiter,
  resendVerificationLimiter,
  changePasswordLimiter,
  logoutLimiter,
  registerLimiter,
} = require("../../middleware/rateLimit");

const router = express.Router();

// registerLimiter protects BOTH registration shapes against abuse (mass
// account creation AND unauthenticated existing-email role-addition requests):
// every role addition for an existing email is throttled the same way, since
// the mutation itself only ever happens after the emailed ownership proof.
router.post("/register", registerLimiter, validate(registerSchema), register);

router.get("/me", authenticate, me);

router.put(
  "/account",
  authenticate,
  validate(accountSettingsSchema),
  updateAccount
);

router.post(
  "/become-candidate",
  authenticate,
  authorize("RECRUITER", "ORG_ADMIN"),
  becomeCandidate
);

router.get(
  "/employee/profile",
  authenticate,
  authorize("EMPLOYEE"),
  getCandidateProfile
);

router.get(
  "/recruiter/profile",
  authenticate,
  authorize("RECRUITER"),
  getRecruiterProfile
);

router.put(
  "/recruiter/profile",
  authenticate,
  authorize("RECRUITER"),
  validate(recruiterProfileSchema),
  saveRecruiterProfile
);

router.get(
  "/employee/profile/completion",
  authenticate,
  authorize("EMPLOYEE"),
  getCandidateCompletion
);

router.get(
  "/employee/career-links",
  authenticate,
  authorize("EMPLOYEE"),
  getCandidateCareerLinks
);

router.put(
  "/employee/career-links",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateCareerLinksSchema),
  saveCandidateCareerLinks
);

router.put(
  "/employee/career-links/resume",
  authenticate,
  authorize("EMPLOYEE"),
  linkCandidateResume
);

router.delete(
  "/employee/career-links/resume",
  authenticate,
  authorize("EMPLOYEE"),
  deleteCandidateResume
);

router.get(
  "/employee/dashboard",
  authenticate,
  authorize("EMPLOYEE"),
  requireEmployeeProfileComplete,
  getEmployeeDashboard
);

router.post(
  "/employee/profile",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProfileSectionSchema),
  saveCandidateProfileSection
);

router.post(
  "/employee/profile/general-information",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProfileSectionSchema),
  saveCandidateProfileSection
);

router.post(
  "/employee/profile/personal-information",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProfileSectionSchema),
  saveCandidateProfileSection
);

router.post(
  "/employee/profile/career-information",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProfileSectionSchema),
  saveCandidateProfileSection
);

router.post(
  "/employee/profile/professional-description",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProfileSectionSchema),
  saveCandidateProfileSection
);

router.post(
  "/employee/profile/job-preferences",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProfileSectionSchema),
  saveCandidateProfileSection
);

router.post(
  "/employee/profile/education",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateEducationSchema),
  addCandidateEducation
);

router.put(
  "/employee/profile/education/:id",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateEducationSchema),
  addCandidateEducation
);

router.delete(
  "/employee/profile/education/:id",
  authenticate,
  authorize("EMPLOYEE"),
  deleteCandidateEducation
);

router.post(
  "/employee/profile/skills",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateSkillSchema),
  addCandidateSkill
);

router.put(
  "/employee/profile/skills/:id",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateSkillSchema),
  addCandidateSkill
);

router.delete(
  "/employee/profile/skills/:id",
  authenticate,
  authorize("EMPLOYEE"),
  deleteCandidateSkill
);

router.post(
  "/employee/profile/experience-level",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateExperienceLevelSchema),
  setCandidateExperienceLevel
);

router.post(
  "/employee/profile/projects",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProjectSchema),
  addCandidateProject
);

router.put(
  "/employee/profile/projects/:id",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProjectSchema),
  addCandidateProject
);

router.delete(
  "/employee/profile/projects/:id",
  authenticate,
  authorize("EMPLOYEE"),
  deleteCandidateProject
);

router.post(
  "/employee/profile/projects/:projectId/skills",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProjectSkillSchema),
  addCandidateProjectSkill
);

router.put(
  "/employee/profile/projects/:projectId/skills/:projectSkillId",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProjectSkillSchema),
  addCandidateProjectSkill
);

router.delete(
  "/employee/profile/projects/:projectId/skills/:projectSkillId",
  authenticate,
  authorize("EMPLOYEE"),
  deleteCandidateProjectSkill
);

router.post(
  "/employee/profile/certificates",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateCertificateSchema),
  addCandidateCertificate
);

router.put(
  "/employee/profile/certificates/:id",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateCertificateSchema),
  addCandidateCertificate
);

router.delete(
  "/employee/profile/certificates/:id",
  authenticate,
  authorize("EMPLOYEE"),
  deleteCandidateCertificate
);

router.post(
  "/employee/profile/mark-complete",
  authenticate,
  authorize("EMPLOYEE"),
  validate(candidateProfileCompletionSchema),
  markCandidateProfileComplete
);

router.post(
  "/switch-role",
  authenticate,
  validate(switchRoleSchema),
  switchRole
);

router.get("/verify-email", verifyEmailAddress);

router.post("/login", loginLimiter, login);

router.post("/refresh", refreshLimiter, refresh);

// No authenticate middleware — the access token may already be expired when
// the user logs out. Idempotent: see logout()/logoutUser() for exactly what
// "no cookie" / "already revoked" / "not found" all resolve to (silently).
router.post("/logout", logoutLimiter, logout);


router.post(
  "/resend-verification",
  resendVerificationLimiter,
  resendVerification
);

router.post("/forgot-password", forgotPasswordLimiter, forgotPassword);

router.post("/reset-password", resetPasswordLimiter, resetPassword);

router.post(
  "/change-password",
  changePasswordLimiter,
  authenticate,
  validate(changePasswordSchema),
  changePassword
);

module.exports = router;
