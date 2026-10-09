import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getSubscriptionPlans,
  initiateCheckout,
  confirmPayment,
} from "../../services/subscriptionService";
import { extractApiErrorMessage } from "../../utils/apiError";
import Container from "../ui/Container";
import Button from "../ui/Button";
import Alert from "../ui/Alert";
import Spinner from "../ui/Spinner";
import { CheckIcon } from "../ui/icons";

const STAGE = {
  PLANS: "plans",
  CONFIRM: "confirm",
  SUCCESS: "success",
};

const formatPrice = (price) =>
  `$${Number(price).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const formatBillingCycle = (cycle) =>
  cycle.charAt(0) + cycle.slice(1).toLowerCase();

// Shared subscription/checkout/payment flow for both the recruiter and
// organization subscription pages. Every value that matters — price, plan
// type, owner, subscription creation — is decided by the backend from
// planId / checkoutToken alone; this component never sends anything else
// and never invents a success state without a real backend response. The
// backend's payment gateway is a simulated one (no real card/provider is
// integrated), and the UI says so plainly rather than pretending otherwise.
const SubscriptionCheckout = ({
  planType,
  title,
  description,
  emptyPlansMessage,
  onPaymentSuccess,
  targetRole,
  organizationName,
}) => {
  const [stage, setStage] = useState(STAGE.PLANS);

  const [plans, setPlans] = useState(null);
  const [plansError, setPlansError] = useState(null);
  const [plansReloadToken, setPlansReloadToken] = useState(0);

  const [checkingOutPlanId, setCheckingOutPlanId] = useState(null);
  const [checkoutError, setCheckoutError] = useState(null);

  // Held only in component state for the current operation — never in the
  // URL, never in localStorage.
  const [checkout, setCheckout] = useState(null);

  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;

    getSubscriptionPlans()
      .then((data) => {
        if (!cancelled) {
          setPlans(data.data);
          setPlansError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPlansError(
            extractApiErrorMessage(err, "Unable to load subscription plans.")
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [plansReloadToken]);

  const handleRetryPlans = () => {
    setPlansError(null);
    setPlans(null);
    setPlansReloadToken((token) => token + 1);
  };

  const availablePlans = (plans ?? []).filter((plan) => plan.type === planType);

  const handleSelectPlan = async (plan) => {
    setCheckoutError(null);
    setCheckingOutPlanId(plan.id);

    try {
      const data = await initiateCheckout(plan.id, targetRole, organizationName);
      setCheckout(data.data);
      setStage(STAGE.CONFIRM);
    } catch (err) {
      setCheckoutError(extractApiErrorMessage(err, "Unable to start checkout."));
    } finally {
      setCheckingOutPlanId(null);
    }
  };

  const handleCancelCheckout = () => {
    setCheckout(null);
    setPaymentError(null);
    setStage(STAGE.PLANS);
  };

  const handleConfirmPayment = async () => {
    if (!checkout || isPaying) return;

    setPaymentError(null);
    setIsPaying(true);

    try {
      const data = await confirmPayment(checkout.checkoutToken);
      setSuccessMessage(
        data?.message ?? "Payment successful. Subscription is now active."
      );
      setStage(STAGE.SUCCESS);
      await onPaymentSuccess(data.data);
    } catch (err) {
      setPaymentError(extractApiErrorMessage(err, "Payment was not successful."));
      setIsPaying(false);
    }
  };

  return (
    <Container className="max-w-4xl py-16">
      <h1 className="font-display text-2xl font-bold text-slate-900">
        {title}
      </h1>
      <p className="mt-2 text-slate-600">{description}</p>

      <AnimatePresence mode="wait">
        {stage === STAGE.PLANS && (
          <motion.div
            key="plans"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-8"
          >
            {checkoutError && (
              <Alert variant="error" className="mb-6">
                {checkoutError}
              </Alert>
            )}

            {plansError && (
              <Alert variant="error" className="mb-6">
                <p>{plansError}</p>
                <button
                  type="button"
                  onClick={handleRetryPlans}
                  className="mt-2 font-semibold underline"
                >
                  Try again
                </button>
              </Alert>
            )}

            {plans === null && !plansError && (
              <div className="flex flex-col items-center py-12 text-center">
                <Spinner className="h-8 w-8 text-indigo-600" />
                <p className="mt-3 text-sm text-slate-600">Loading plans...</p>
              </div>
            )}

            {plans !== null && availablePlans.length === 0 && !plansError && (
              <p className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">
                {emptyPlansMessage}
              </p>
            )}

            {availablePlans.length > 0 && (
              <div className="grid gap-6 sm:grid-cols-2">
                {availablePlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                  >
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      {plan.name}
                    </h2>

                    <p className="mt-2">
                      <span className="text-3xl font-bold text-slate-900">
                        {formatPrice(plan.price)}
                      </span>
                      <span className="text-sm text-slate-500">
                        {" "}
                        / {formatBillingCycle(plan.billingCycle)}
                      </span>
                    </p>

                    {plan.description && (
                      <p className="mt-3 text-sm text-slate-600">
                        {plan.description}
                      </p>
                    )}

                    {plan.maxUsers != null && (
                      <p className="mt-2 text-sm text-slate-500">
                        Up to {plan.maxUsers} users
                      </p>
                    )}

                    <Button
                      type="button"
                      className="mt-6 w-full"
                      disabled={checkingOutPlanId !== null}
                      onClick={() => handleSelectPlan(plan)}
                    >
                      {checkingOutPlanId === plan.id ? (
                        <>
                          <Spinner className="h-4 w-4" />
                          Starting checkout...
                        </>
                      ) : (
                        "Choose plan"
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {stage === STAGE.CONFIRM && checkout && (
          <motion.div
            key="confirm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-8 max-w-md"
          >
            {paymentError && (
              <Alert variant="error" className="mb-6">
                {paymentError}
              </Alert>
            )}

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                Confirm your subscription
              </h2>

              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Plan</dt>
                  <dd className="font-medium text-slate-900">
                    {checkout.plan.name}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Billing cycle</dt>
                  <dd className="font-medium text-slate-900">
                    {formatBillingCycle(checkout.plan.billingCycle)}
                  </dd>
                </div>
                {checkout.plan.maxUsers != null && (
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Users included</dt>
                    <dd className="font-medium text-slate-900">
                      Up to {checkout.plan.maxUsers}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-slate-100 pt-2">
                  <dt className="text-slate-500">Amount due today</dt>
                  <dd className="font-semibold text-slate-900">
                    {formatPrice(checkout.amount)}
                  </dd>
                </div>
              </dl>

              <Alert variant="info" className="mt-4">
                This is a simulated payment for testing — no real charge will
                be made and no card details are collected.
              </Alert>

              <div className="mt-6 flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  disabled={isPaying}
                  onClick={handleCancelCheckout}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={isPaying}
                  onClick={handleConfirmPayment}
                >
                  {isPaying ? (
                    <>
                      <Spinner className="h-4 w-4" />
                      Processing payment...
                    </>
                  ) : (
                    "Confirm payment"
                  )}
                </Button>
              </div>
            </div>
          </motion.div>
        )}

        {stage === STAGE.SUCCESS && (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="mt-8 max-w-md text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-400 text-white shadow-lg shadow-emerald-500/30"
            >
              <CheckIcon className="h-7 w-7" />
            </motion.div>
            <h2 className="font-display mt-5 text-xl font-semibold text-slate-900">
              Payment successful
            </h2>
            <Alert variant="success" className="mt-4 text-left">
              {successMessage}
            </Alert>
            <p className="mt-4 text-sm text-slate-600">Taking you to the next step...</p>
          </motion.div>
        )}
      </AnimatePresence>
    </Container>
  );
};

export default SubscriptionCheckout;
