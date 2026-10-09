import { useLocation, useNavigate } from "react-router-dom";
import SubscriptionCheckout from "../../components/subscription/SubscriptionCheckout";
import { resolveOnboardingPath } from "../../utils/onboarding";
import { useAuth } from "../../hooks/useAuth";

const OrganizationSubscription = () => {
  const navigate = useNavigate();
  const { state } = useLocation();
  const { updateUser, switchRole } = useAuth();

  // Never assume where payment leads — activate the target account through the
  // same switch-role endpoint the Switch Account flow uses. That endpoint
  // issues the target-role token AND computes the target role's real onboarding
  // step from live organization/profile state (never from the JWT role of the
  // account the user was on during checkout), so the user lands on Org Admin
  // Profile Setup when it is not yet complete and straight on the Org Admin
  // Dashboard once it is — and never sees setup again afterwards.
  const handlePaymentSuccess = async () => {
    const targetRole = state?.targetRole ?? "ORG_ADMIN";
    try {
      const nextUser = await switchRole(targetRole);
      updateUser(nextUser);
      navigate(resolveOnboardingPath(nextUser));
    } catch {
      // Role activation failed after a successful payment (e.g. transient
      // network issue) — the dashboard's own profile-complete gate will route
      // to Org Admin Profile Setup if it is still incomplete.
      navigate("/organization/dashboard");
    }
  };

  return (
    <SubscriptionCheckout
      planType="ORGANIZATION"
      title="Choose an organization subscription plan"
      description="An active organization subscription is required before you can access the organization dashboard."
      emptyPlansMessage="No organization subscription plans are currently available. Please check back later."
      onPaymentSuccess={handlePaymentSuccess}
      targetRole={state?.targetRole}
      organizationName={state?.organizationName}
    />
  );
};

export default OrganizationSubscription;
