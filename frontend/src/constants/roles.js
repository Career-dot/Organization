export const ROLES = {
  EMPLOYEE: "EMPLOYEE",
  RECRUITER: "RECRUITER",
  ORG_ADMIN: "ORG_ADMIN",
  SUPER_ADMIN: "SUPER_ADMIN",
};

export const ROLE_DASHBOARD_PATH = {
  [ROLES.EMPLOYEE]: "/employee/dashboard",
  [ROLES.RECRUITER]: "/recruiter/dashboard",
  [ROLES.ORG_ADMIN]: "/organization/dashboard",
  [ROLES.SUPER_ADMIN]: "/admin/dashboard",
};

export const EMPLOYEE_ONBOARDING_PATH = {
  PASSWORD_CHANGE_REQUIRED: "/change-password",
  EMPLOYEE_PROFILE_SETUP: "/employee/profile/setup",
  EMPLOYEE_DASHBOARD: "/employee/dashboard",
  PROFILE_SETUP: "/employee/profile/setup",
  DASHBOARD: "/employee/dashboard",
};

// RECRUITER and ORG_ADMIN logins carry a meaningful onboarding.nextStep
// (backend: determineOnboardingNextStep in auth.service.js). EMPLOYEE keeps
// using ROLE_DASHBOARD_PATH unchanged — it has no entry here.
// PASSWORD_CHANGE_REQUIRED can appear for any role (server-issued temporary
// password not yet changed — see mustChangePassword), so it's included on
// both maps rather than added as a separate ONBOARDING_PATH_BY_ROLE entry.
export const RECRUITER_ONBOARDING_PATH = {
  PASSWORD_CHANGE_REQUIRED: "/change-password",
  PAYMENT: "/recruiter/subscription",
  PROFILE_SETUP: "/recruiter/profile-setup",
  DASHBOARD: "/recruiter/dashboard",
};

// ORG_ADMIN has a PROFILE_SETUP step (organization website + businessEmail)
// after payment completes and before accessing the dashboard.
export const ORG_ADMIN_ONBOARDING_PATH = {
  PASSWORD_CHANGE_REQUIRED: "/change-password",
  PAYMENT: "/organization/subscription",
  PROFILE_SETUP: "/organization/profile/setup",
  DASHBOARD: "/organization/dashboard",
};

export const ONBOARDING_PATH_BY_ROLE = {
  [ROLES.EMPLOYEE]: EMPLOYEE_ONBOARDING_PATH,
  [ROLES.RECRUITER]: RECRUITER_ONBOARDING_PATH,
  [ROLES.ORG_ADMIN]: ORG_ADMIN_ONBOARDING_PATH,
};
