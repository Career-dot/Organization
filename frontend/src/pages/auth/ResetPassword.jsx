import { useState, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { resetPassword } from "../../services/authService";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";

const PASSWORD_MIN_LENGTH = 8;

const validate = (form) => {
  const errors = {};

  const pw = form.password;
  if (pw.length < PASSWORD_MIN_LENGTH) {
    errors.password = "Password must be at least 8 characters.";
  } else if (!/[A-Z]/.test(pw)) {
    errors.password = "Add at least one uppercase letter.";
  } else if (!/[a-z]/.test(pw)) {
    errors.password = "Add at least one lowercase letter.";
  } else if (!/[0-9]/.test(pw)) {
    errors.password = "Add at least one number.";
  } else if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw)) {
    errors.password = "Add at least one special character.";
  }

  if (form.confirmPassword !== form.password) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return errors;
};

const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [form, setForm] = useState({ password: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [succeeded, setSucceeded] = useState(false);
  const isSubmittingRef = useRef(false);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => ({ ...prev, [name]: undefined }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;

    setServerError(null);

    if (!token) {
      setServerError("This password reset link is invalid.");
      return;
    }

    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    isSubmittingRef.current = true;
    setSubmitting(true);

    try {
      await resetPassword({ token, password: form.password });
      setSucceeded(true);
    } catch (err) {
      setServerError(
        err.response?.data?.message ??
          "Something went wrong. Please try again."
      );
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (succeeded) {
    return (
      <>
        <h1 className="font-display text-xl font-semibold text-slate-900">
          Password reset successfully.
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          You can now log in with your new password.
        </p>

        <Button as="link" to="/login" className="mt-6 w-full">
          Continue to Login
        </Button>
      </>
    );
  }

  return (
    <>
      <h1 className="font-display text-xl font-semibold text-slate-900">
        Set a new password
      </h1>
      {!token && (
        <p className="mt-1 text-sm text-slate-600">
          This page is normally reached from a password reset email.
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-5">
        <AnimatePresence>
          {serverError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <Alert variant="error">{serverError}</Alert>
            </motion.div>
          )}
        </AnimatePresence>

        <FormField label="New password" id="password" error={fieldErrors.password}>
          <input
            id="password"
            name="password"
            type="password"
            required
            maxLength={100}
            value={form.password}
            onChange={handleChange}
            className={inputClasses}
            placeholder="At least 8 characters"
            autoComplete="new-password"
          />
          {!fieldErrors.password && (
            <p className="text-xs text-slate-500">
              Must include an uppercase letter, a lowercase letter, a number,
              and a special character.
            </p>
          )}
        </FormField>

        <FormField
          label="Confirm new password"
          id="confirmPassword"
          error={fieldErrors.confirmPassword}
        >
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            value={form.confirmPassword}
            onChange={handleChange}
            className={inputClasses}
            placeholder="Re-enter your new password"
            autoComplete="new-password"
          />
        </FormField>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Resetting..." : "Reset password"}
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

export default ResetPassword;
