import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { loginUser } from "../../services/authService";
import { motion, AnimatePresence } from "framer-motion";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { extractApiErrorMessage } from "../../utils/apiError";
import { resolveOnboardingPath } from "../../utils/onboarding";
import { useAuth } from "../../hooks/useAuth";

const Login = () => {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [form, setForm] = useState({
    email: "",
    password: "",
  });

  const [showNotice, setShowNotice] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
  event.preventDefault();

  setError(null);

  try {
    const response = await loginUser({
      email: form.email,
      password: form.password,
    });

    login(
      response.data.user,
      response.data.accessToken,
      response.data.sessionSelector
    );

    const postLoginPath = resolveOnboardingPath(response.data.user);

    if (postLoginPath) {
      navigate(postLoginPath);
    }

  } catch (err) {
    console.error("LOGIN ERROR:", err.response?.data || err.message);
    setError(extractApiErrorMessage(err));
  }
};
  return (
    <>
      <h1 className="font-display text-xl font-semibold text-slate-900">
        Welcome back
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Don&apos;t have an account?{" "}
        <Link
          to="/register"
          className="font-semibold text-indigo-600 hover:text-indigo-700"
        >
          Register
        </Link>
      </p>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 24 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <Alert variant="error">
              <p className="font-semibold">Login failed</p>
              <p className="mt-0.5">{error}</p>
            </Alert>
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
            value={form.email}
            onChange={handleChange}
            className={inputClasses}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </FormField>

        <FormField label="Password" id="password">
          <input
            id="password"
            name="password"
            type="password"
            required
            value={form.password}
            onChange={handleChange}
            className={inputClasses}
            placeholder="Your password"
            autoComplete="current-password"
          />
        </FormField>

        <div className="flex justify-end">
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" className="w-full">
          Login
        </Button>
      </form>
    </>
  );
};

export default Login;
