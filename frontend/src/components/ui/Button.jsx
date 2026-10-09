import { Link } from "react-router-dom";
import { motion } from "framer-motion";

const MotionLink = motion.create(Link);
const MotionAnchor = motion.a;
const MotionButton = motion.button;

const VARIANTS = {
  primary:
    "bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:shadow-indigo-500/30 focus-visible:outline-indigo-600",
  secondary:
    "bg-slate-900 text-white hover:bg-slate-800 focus-visible:outline-slate-900",
  outline:
    "border border-slate-300 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/60 focus-visible:outline-indigo-600",
  ghost: "text-slate-700 hover:bg-slate-100 focus-visible:outline-indigo-600",
  glass:
    "glass text-white hover:bg-white/10 focus-visible:outline-white/60",
};

const SIZES = {
  sm: "px-3.5 py-2 text-sm",
  md: "px-5 py-2.5 text-sm",
  lg: "px-6 py-3.5 text-base",
};

const baseClasses =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 disabled:pointer-events-none";

const motionProps = {
  whileHover: { scale: 1.03 },
  whileTap: { scale: 0.97 },
  transition: { type: "spring", stiffness: 400, damping: 20 },
};

const Button = ({
  as = "button",
  to,
  href,
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}) => {
  const classes = `${baseClasses} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;

  if (as === "link" && to) {
    return (
      <MotionLink to={to} className={classes} {...motionProps} {...props}>
        {children}
      </MotionLink>
    );
  }

  if (as === "a" && href) {
    return (
      <MotionAnchor href={href} className={classes} {...motionProps} {...props}>
        {children}
      </MotionAnchor>
    );
  }

  return (
    <MotionButton className={classes} {...motionProps} {...props}>
      {children}
    </MotionButton>
  );
};

export default Button;
