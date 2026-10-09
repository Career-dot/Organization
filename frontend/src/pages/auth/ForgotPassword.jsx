import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { forgotPassword } from "../../services/authService";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";

const GENERIC_SUCCESS_MESSAGE =
  "If an account with that email exists and is verified, a password reset link has been sent.";

const ForgotPassword = () => {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const isSubmittingRef = useRef(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;

    isSubmittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);

    try {
      const data = await forgotPassword(email.trim());
      setFeedback({
        variant: "success",
        message: data?.message ?? GENERIC_SUCCESS_MESSAGE,
      });
    } catch (err) {
      setFeedback({
        variant: "error",
        message:
          err.response?.data?.message ??
          "Something went wrong. Please try again.",
      });
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1 className="font-display text-xl font-semibold text-slate-900">
        Forgot your password?
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Enter your email and we&apos;ll send you a link to reset it.
      </p>

      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 24 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <Alert variant={feedback.variant}>{feedback.message}</Alert>
          </motion.div>
        )}
      </AnimatePresence>

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
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

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Sending..." : "Send reset link"}
        </Button>
      </form>

      <Link
        to="/login"
        className="mt-6 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700"
      >
        Back to Login
      </Link>
    </>
  );
};

export default ForgotPassword;
