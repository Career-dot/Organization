import { Link, Outlet } from "react-router-dom";
import { motion } from "framer-motion";

const AuthLayout = () => (
  <div className="relative flex min-h-screen flex-col overflow-hidden bg-midnight-950 bg-grid">
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-indigo-600/30 blur-[120px]"
    />
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 right-0 h-[300px] w-[400px] translate-x-1/4 translate-y-1/4 rounded-full bg-cyan-500/20 blur-[110px]"
    />

    <header className="relative py-6 text-center">
      <Link to="/" className="inline-flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white shadow-lg shadow-indigo-500/30">
          VS
        </span>
        <span className="font-display text-base font-semibold text-white">
          Verified Skills Passport
        </span>
      </Link>
    </header>

    <main className="relative flex flex-1 items-center justify-center px-4 pb-12">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-white/95 p-8 shadow-2xl shadow-black/40 backdrop-blur"
      >
        <Outlet />
      </motion.div>
    </main>
  </div>
);

export default AuthLayout;
