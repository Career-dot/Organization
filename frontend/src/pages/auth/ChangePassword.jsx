import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { changePassword, getCurrentUser } from "../../services/authService";
import { useAuth } from "../../hooks/useAuth";
import { resolveOnboardingPath } from "../../utils/onboarding";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";

const PASSWORD_MIN_LENGTH = 8;

const validate = (form) => {
  const errors = {};

  const pw = form.newPassword;
  if (pw.length < PASSWORD_MIN_LENGTH) {
    errors.newPassword = "Password must be at least 8 characters.";
  } else if (!/[A-Z]/.test(pw)) {
    errors.newPassword = "Add at least one uppercase letter.";
  } else if (!/[a-z]/.test(pw)) {
    errors.newPassword = "Add at least one lowercase letter.";
  } else if (!/[0-9]/.test(pw)) {
    errors.newPassword = "Add at least one number.";
  } else if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw)) {
    errors.newPassword = "Add at least one special character.";
  }

  if (form.confirmPassword !== form.newPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return errors;
};

// Reached whenever onboarding.nextStep === "PASSWORD_CHANGE_REQUIRED" (a
// server-issued temporary password not yet changed — see
// User.mustChangePassword). Any authenticated role can land here, so this
// route carries no allowedRoles restriction (see App.jsx).
const ChangePassword = () => {
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();

  const [form, setForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);
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

    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    isSubmittingRef.current = true;
    setSubmitting(true);

    try {
      await changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });

      // Re-fetch fresh onboarding state — mustChangePassword is now false,
      // so the backend will resolve a real destination (PAYMENT,
      // PROFILE_SETUP, or DASHBOARD) instead of PASSWORD_CHANGE_REQUIRED.
      const me = await getCurrentUser();
      const freshUser = { ...user, ...me.data };
      updateUser(freshUser);
      navigate(resolveOnboardingPath(freshUser), { replace: true });
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

  return (
    <>
      <h1 className="font-display text-xl font-semibold text-slate-900">
        Set a new password
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        You&apos;re using a temporary password. Choose a new one to continue.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-5">
        {serverError && <Alert variant="error">{serverError}</Alert>}

        <FormField label="Temporary password" id="currentPassword">
          <input
            id="currentPassword"
            name="currentPassword"
            type="password"
            required
            value={form.currentPassword}
            onChange={handleChange}
            className={inputClasses}
            placeholder="The password from your email"
            autoComplete="current-password"
          />
        </FormField>

        <FormField
          label="New password"
          id="newPassword"
          error={fieldErrors.newPassword}
        >
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            required
            maxLength={100}
            value={form.newPassword}
            onChange={handleChange}
            className={inputClasses}
            placeholder="At least 8 characters"
            autoComplete="new-password"
          />
          {!fieldErrors.newPassword && (
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
          {submitting ? "Updating..." : "Set new password"}
        </Button>
      </form>
    </>
  );
};

export default ChangePassword;
