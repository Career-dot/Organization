import { useLocation, useNavigate } from "react-router-dom";
import SubscriptionCheckout from "../../components/subscription/SubscriptionCheckout";
import { resolveOnboardingPath } from "../../utils/onboarding";
import { useAuth } from "../../hooks/useAuth";

const RecruiterSubscription = () => {
  const navigate = useNavigate();
  const { state } = useLocation();
  const { updateUser, switchRole } = useAuth();

  // Never assume where payment leads — activate the target account through the
  // same switch-role endpoint the Switch Account flow uses. That endpoint
  // issues the target-role token AND computes the recruiter's real onboarding
  // step from live subscription/profile state (never from the JWT role of the
  // account the user was on during checkout), so the user lands on Recruiter
  // Profile Setup when it is not yet complete and straight on the Recruiter
  // Dashboard once it is — and never sees setup again afterwards.
  const handlePaymentSuccess = async () => {
    const targetRole = state?.targetRole ?? "RECRUITER";
    try {
      const nextUser = await switchRole(targetRole);
      updateUser(nextUser);
      navigate(resolveOnboardingPath(nextUser));
    } catch {
      // Role activation failed after a successful payment (e.g. transient
      // network issue) — fall back to the step this page exists for; the
      // recruiter dashboard's profile-complete gate re-checks it anyway.
      navigate("/recruiter/profile-setup");
    }
  };

  return (
    <SubscriptionCheckout
      planType="RECRUITER"
      title="Choose a subscription plan"
      description="An active subscription is required before you can access the recruiter dashboard."
      emptyPlansMessage="No recruiter subscription plans are currently available. Please check back later."
      onPaymentSuccess={handlePaymentSuccess}
      targetRole={state?.targetRole}
      organizationName={state?.organizationName}
    />
  );
};

export default RecruiterSubscription;
