import { useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { registerUser } from "../../services/authService";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";

const ROLE_OPTIONS = [
  { value: "EMPLOYEE", label: "Employee" },
  { value: "RECRUITER", label: "Recruiter" },
  { value: "ORG_ADMIN", label: "Organization Admin" },
];

const INITIAL_FORM = {
  fullName: "",
  email: "",
  password: "",
  confirmPassword: "",
  role: "EMPLOYEE",
  organizationName: "",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

const validate = (form) => {
  const errors = {};

  if (form.fullName.trim().length < 3) {
    errors.fullName = "Full name must be at least 3 characters.";
  }

  if (!EMAIL_PATTERN.test(form.email)) {
    errors.email = "Enter a valid email address.";
  }

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

  if (form.role === "ORG_ADMIN" && form.organizationName.trim().length < 2) {
    errors.organizationName = "Organization name must be at least 2 characters.";
  }

  return errors;
};

const Register = () => {
  const navigate = useNavigate();
  const [form, setForm] = useState(INITIAL_FORM);
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
      const payload = {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        ...(form.role === "ORG_ADMIN"
          ? { organizationName: form.organizationName.trim() }
          : {}),
      };

      await registerUser(payload);
      const email = payload.email;
      setForm(INITIAL_FORM);
      navigate("/check-email", { state: { email } });
    } catch (err) {
      setServerError(
        err.response?.data?.message ??
          "Something went wrong while registering. Please try again."
      );
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1 className="font-display text-xl font-semibold text-slate-900">
        Create your account
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Already have an account?{" "}
        <Link to="/login" className="font-semibold text-indigo-600 hover:text-indigo-700">
          Login
        </Link>
      </p>

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

        <FormField label="Full name" id="fullName" error={fieldErrors.fullName}>
          <input
            id="fullName"
            name="fullName"
            type="text"
            required
            maxLength={100}
            value={form.fullName}
            onChange={handleChange}
            className={inputClasses}
            placeholder="Jane Doe"
            autoComplete="name"
          />
        </FormField>

        <FormField label="Email" id="email" error={fieldErrors.email}>
          <input
            id="email"
            name="email"
            type="email"
            required
            value={form.email}
            onChange={handleChange}
            className={inputClasses}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </FormField>

        <FormField label="Password" id="password" error={fieldErrors.password}>
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
          label="Confirm password"
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
            placeholder="Re-enter your password"
            autoComplete="new-password"
          />
        </FormField>

        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-slate-700">
            I am registering as
          </span>
          <div className="grid grid-cols-3 gap-2">
            {ROLE_OPTIONS.map((option) => {
              const isActive = form.role === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() =>
                    handleChange({
                      target: { name: "role", value: option.value },
                    })
                  }
                  className={`rounded-xl border px-2 py-2.5 text-xs font-semibold transition-colors ${
                    isActive
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm"
                      : "border-slate-300 text-slate-600 hover:border-indigo-300"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <AnimatePresence>
          {form.role === "ORG_ADMIN" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <FormField
                label="Organization name"
                id="organizationName"
                error={fieldErrors.organizationName}
              >
                <input
                  id="organizationName"
                  name="organizationName"
                  type="text"
                  maxLength={150}
                  value={form.organizationName}
                  onChange={handleChange}
                  className={inputClasses}
                  placeholder="Acme Inc."
                  autoComplete="organization"
                />
              </FormField>
            </motion.div>
          )}
        </AnimatePresence>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Creating account..." : "Create account"}
        </Button>
      </form>
    </>
  );
};

export default Register;
