const VARIANTS = {
  success: "bg-emerald-50 text-emerald-800 border-emerald-200",
  error: "bg-red-50 text-red-800 border-red-200",
  info: "bg-indigo-50 text-indigo-800 border-indigo-200",
};

const Alert = ({ variant = "info", children, className = "" }) => (
  <div
    role="alert"
    className={`rounded-xl border px-4 py-3 text-sm ${VARIANTS[variant]} ${className}`}
  >
    {children}
  </div>
);

export default Alert;
