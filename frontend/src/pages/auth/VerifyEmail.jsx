import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { verifyEmail, resendVerificationEmail } from "../../services/authService";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import Spinner from "../../components/ui/Spinner";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { CheckIcon } from "../../components/ui/icons";

const STATUS = {
  LOADING: "loading",
  SUCCESS: "success",
  EXPIRED: "expired",
  ERROR: "error",
};

const RESEND_COOLDOWN_SECONDS = 30;

const VerifyEmail = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const [status, setStatus] = useState(
    token ? STATUS.LOADING : STATUS.ERROR
  );
  const [message, setMessage] = useState(
    token ? "" : "No verification token was provided."
  );
  const hasRun = useRef(false);

  const [resendEmail, setResendEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resendFeedback, setResendFeedback] = useState(null);

  useEffect(() => {
    if (!token || hasRun.current) return;
    hasRun.current = true;

    // Never log the token — pass it straight through to the API call only.
    verifyEmail(token)
      .then((data) => {
        setStatus(STATUS.SUCCESS);
        setMessage(data?.message ?? "Email verified successfully.");
      })
      .catch((err) => {
        const errorMessage =
          err.response?.data?.message ??
          "This verification link is invalid or has expired.";
        setStatus(
          errorMessage.toLowerCase().includes("expired")
            ? STATUS.EXPIRED
            : STATUS.ERROR
        );
        setMessage(errorMessage);
      });
  }, [token]);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    const interval = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleResend = async (event) => {
    event.preventDefault();
    if (resending || cooldown > 0 || !resendEmail.trim()) return;

    setResending(true);
    setResendFeedback(null);

    try {
      const data = await resendVerificationEmail(resendEmail.trim());
      setResendFeedback({
        variant: "success",
        message:
          data?.message ??
          "Verification email sent. Please check your inbox.",
      });
      startCooldown();
    } catch (err) {
      setResendFeedback({
        variant: "error",
        message:
          err.response?.data?.message ??
          "Could not resend the verification email. Please try again.",
      });
    } finally {
      setResending(false);
    }
  };

  return (
    <AnimatePresence mode="wait">
      {status === STATUS.LOADING && (
        <motion.div
          key="loading"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex flex-col items-center text-center"
        >
          <Spinner className="h-9 w-9 text-indigo-600" />
          <h1 className="font-display mt-4 text-xl font-semibold text-slate-900">
            Verifying your email...
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            This will only take a moment.
          </p>
        </motion.div>
      )}

      {status === STATUS.SUCCESS && (
        <motion.div
          key="success"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="text-center"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-400 text-white shadow-lg shadow-emerald-500/30"
          >
            <CheckIcon className="h-7 w-7" />
          </motion.div>
          <h1 className="font-display mt-5 text-xl font-semibold text-slate-900">
            Email verified
          </h1>
          <Alert variant="success" className="mt-4 text-left">
            {message}
          </Alert>
          <Button as="link" to="/login" className="mt-6 w-full">
            Continue to Login
          </Button>
        </motion.div>
      )}

      {status === STATUS.EXPIRED && (
        <motion.div
          key="expired"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="text-center"
        >
          <h1 className="font-display text-xl font-semibold text-slate-900">
            Verification link expired
          </h1>
          <Alert variant="error" className="mt-4 text-left">
            {message}
          </Alert>
          <p className="mt-4 text-sm text-slate-600">
            Enter your email to get a new verification link.
          </p>

          <form onSubmit={handleResend} className="mt-4 space-y-4 text-left">
            <AnimatePresence>
              {resendFeedback && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <Alert variant={resendFeedback.variant}>
                    {resendFeedback.message}
                  </Alert>
                </motion.div>
              )}
            </AnimatePresence>

            <FormField label="Email" id="resendEmail">
              <input
                id="resendEmail"
                name="resendEmail"
                type="email"
                required
                value={resendEmail}
                onChange={(event) => setResendEmail(event.target.value)}
                className={inputClasses}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </FormField>

            <Button
              type="submit"
              className="w-full"
              disabled={resending || cooldown > 0 || !resendEmail.trim()}
            >
              {resending
                ? "Sending..."
                : cooldown > 0
                ? `Resend available in ${cooldown}s`
                : "Resend verification email"}
            </Button>
          </form>

          <Link
            to="/register"
            className="mt-6 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700"
          >
            Back to Register
          </Link>
        </motion.div>
      )}

      {status === STATUS.ERROR && (
        <motion.div
          key="error"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="text-center"
        >
          <h1 className="font-display text-xl font-semibold text-slate-900">
            Verification failed
          </h1>
          <Alert variant="error" className="mt-4 text-left">
            {message}
          </Alert>
          <Link
            to="/register"
            className="mt-6 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700"
          >
            Back to Register
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default VerifyEmail;
