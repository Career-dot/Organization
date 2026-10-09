import { motion } from "framer-motion";
import Container from "./Container";

const PageHero = ({ eyebrow, title, description, children }) => (
  <section className="relative overflow-hidden bg-midnight-950 bg-grid">
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-indigo-600/30 blur-[120px]"
    />
    <div
      aria-hidden="true"
      className="pointer-events-none absolute right-0 bottom-0 h-[300px] w-[400px] translate-x-1/4 translate-y-1/4 rounded-full bg-cyan-500/20 blur-[110px]"
    />

    <Container className="relative py-20 text-center sm:py-24">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        {eyebrow && (
          <p className="text-sm font-semibold uppercase tracking-wide text-cyan-300">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display mx-auto mt-3 max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
          {title}
        </h1>
        {description && (
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-300">
            {description}
          </p>
        )}
        {children}
      </motion.div>
    </Container>
  </section>
);

export default PageHero;
