import { ROLE_DASHBOARD_PATH, ONBOARDING_PATH_BY_ROLE } from "../constants/roles";

// The backend computes onboarding state from live account/profile data.
// This function only maps that server-issued state to an existing route.
export const resolveOnboardingPath = (user) => {
  const onboardingPaths = ONBOARDING_PATH_BY_ROLE[user.role];

  if (onboardingPaths && user.onboarding?.nextStep) {
    return (
      onboardingPaths[user.onboarding.nextStep] ?? ROLE_DASHBOARD_PATH[user.role]
    );
  }

  return ROLE_DASHBOARD_PATH[user.role];
};
