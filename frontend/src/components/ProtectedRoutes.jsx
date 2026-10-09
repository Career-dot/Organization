import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ROLE_DASHBOARD_PATH } from "../constants/roles";
import { resolveOnboardingPath } from "../utils/onboarding";
import { getRecruiterProfile } from "../services/authService";
import { getOrganizationSummary } from "../services/organizationService";

const ProtectedRoutes = ({
  allowedRoles,
  requiresUsableAccount = false,
  requiresRecruiterProfileComplete = false,
  requiresOrgAdminProfileComplete = false,
}) => {
  const { user, isAuthenticated, isHydrating } = useAuth();
  const location = useLocation();
  const [recruiterProfileCheck, setRecruiterProfileCheck] = useState({
    key: null,
    complete: false,
  });
  const [orgAdminProfileCheck, setOrgAdminProfileCheck] = useState({
    key: null,
    complete: false,
  });
  const recruiterProfileCheckKey = `${user?.id ?? ""}:${user?.role ?? ""}`;
  const orgAdminProfileCheckKey = [
    user?.id,
    user?.role,
    user?.fullName,
    user?.email,
    user?.profileImage,
    user?.phone,
    user?.city,
    user?.country,
  ].join(":");

  useEffect(() => {
    if (
      !requiresRecruiterProfileComplete ||
      user?.role !== "RECRUITER" ||
      !isAuthenticated
    )
      return undefined;

    let mounted = true;
    getRecruiterProfile()
      .then((response) => {
        if (mounted)
          setRecruiterProfileCheck({
            key: recruiterProfileCheckKey,
            complete: response.data?.isComplete === true,
          });
      })
      .catch(() => {
        if (mounted)
          setRecruiterProfileCheck({
            key: recruiterProfileCheckKey,
            complete: false,
          });
      });

    return () => {
      mounted = false;
    };
  }, [isAuthenticated, requiresRecruiterProfileComplete, recruiterProfileCheckKey, user?.role]);

  useEffect(() => {
    if (
      !requiresOrgAdminProfileComplete ||
      user?.role !== "ORG_ADMIN" ||
      !isAuthenticated
    )
      return undefined;

    let mounted = true;
    getOrganizationSummary()
      .then((response) => {
        const org = response.data;
        const isComplete = Boolean(
          org?.name?.trim() &&
          org?.website?.trim() &&
          org?.businessEmail?.trim() &&
          org?.organizationLogo &&
          user?.fullName?.trim() &&
          user?.email?.trim() &&
          user?.profileImage?.trim() &&
          user?.phone?.trim() &&
          user?.city?.trim() &&
          user?.country?.trim()
        );
        if (mounted)
          setOrgAdminProfileCheck({
            key: orgAdminProfileCheckKey,
            complete: isComplete,
          });
      })
      .catch(() => {
        if (mounted)
          setOrgAdminProfileCheck({
            key: orgAdminProfileCheckKey,
            complete: false,
          });
      });

    return () => {
      mounted = false;
    };
  }, [
    isAuthenticated,
    requiresOrgAdminProfileComplete,
    orgAdminProfileCheckKey,
    user?.city,
    user?.country,
    user?.email,
    user?.fullName,
    user?.phone,
    user?.profileImage,
    user?.role,
  ]);

  if (isHydrating) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    const redirectPath = ROLE_DASHBOARD_PATH[user.role] ?? "/";
    return <Navigate to={redirectPath} replace />;
  }

  if (
    requiresUsableAccount &&
    !user.accounts?.some(({ role }) => role === user.role)
  ) {
    const onboardingPath = resolveOnboardingPath(user);
    // Redirecting to the path the user is already on would <Navigate replace>
    // into itself forever — the PAYMENT onboarding target can be this very
    // subscription page (e.g. /recruiter/subscription for an account whose
    // subscription is genuinely unusable). Rendering the matched route here
    // is NOT a check bypass: the matched route IS the onboarding target (a
    // PAYMENT or PROFILE_SETUP page), never a subscription-gated dashboard.
    if (onboardingPath === location.pathname) {
      return <Outlet />;
    }
    return <Navigate to={onboardingPath} replace />;
  }

  if (requiresRecruiterProfileComplete && user.role === "RECRUITER") {
    if (recruiterProfileCheck.key !== recruiterProfileCheckKey) return null;
    if (!recruiterProfileCheck.complete)
      return <Navigate to="/recruiter/profile-setup" replace />;
  }

  if (requiresOrgAdminProfileComplete && user.role === "ORG_ADMIN") {
    if (orgAdminProfileCheck.key !== orgAdminProfileCheckKey) return null;
    if (!orgAdminProfileCheck.complete)
      return <Navigate to="/organization/profile/setup" replace />;
  }

  return <Outlet />;
};

export default ProtectedRoutes;
