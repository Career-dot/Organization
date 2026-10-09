import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { resendVerificationEmail } from "../../services/authService";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { MailIcon } from "../../components/ui/icons";

const RESEND_COOLDOWN_SECONDS = 30;

const CheckEmail = () => {
  const location = useLocation();
  const stateEmail = location.state?.email ?? "";

  const [email, setEmail] = useState(stateEmail);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [feedback, setFeedback] = useState(null);

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
    if (resending || cooldown > 0 || !email.trim()) return;

    setResending(true);
    setFeedback(null);

    try {
      const data = await resendVerificationEmail(email.trim());
      setFeedback({
        variant: "success",
        message:
          data?.message ??
          "Verification email sent. Please check your inbox.",
      });
      startCooldown();
    } catch (err) {
      setFeedback({
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
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="text-center"
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.1 }}
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 text-white shadow-lg shadow-indigo-500/30"
      >
        <MailIcon className="h-7 w-7" />
      </motion.div>

      <h1 className="font-display mt-5 text-xl font-semibold text-slate-900">
        Verify your email
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        {stateEmail ? (
          <>
            We sent a verification link to{" "}
            <span className="font-semibold text-slate-900">{stateEmail}</span>.
            Click the link in that email to activate your account.
          </>
        ) : (
          "We sent a verification link to your email address. Click the link in that email to activate your account."
        )}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Didn't get it? Check your spam folder, or resend it below.
      </p>

      <form onSubmit={handleResend} className="mt-6 space-y-4 text-left">
        <AnimatePresence>
          {feedback && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <Alert variant={feedback.variant}>{feedback.message}</Alert>
            </motion.div>
          )}
        </AnimatePresence>

        {!stateEmail && (
          <FormField label="Email" id="email">
            <input
              id="email"
              name="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClasses}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </FormField>
        )}

        <Button
          type="submit"
          variant="outline"
          className="w-full"
          disabled={resending || cooldown > 0 || !email.trim()}
        >
          {resending
            ? "Sending..."
            : cooldown > 0
            ? `Resend available in ${cooldown}s`
            : "Resend verification email"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        Already verified?{" "}
        <Link to="/login" className="font-semibold text-indigo-600 hover:text-indigo-700">
          Login
        </Link>
      </p>
    </motion.div>
  );
};

export default CheckEmail;
