import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import Container from "../../components/ui/Container";
import Button from "../../components/ui/Button";
import Reveal from "../../components/ui/Reveal";
import {
  CheckIcon,
  ShieldIcon,
  LockIcon,
  SparkIcon,
  ChartIcon,
  UsersIcon,
  BuildingIcon,
} from "../../components/ui/icons";

const WORKFLOW = [
  { step: "01", title: "Register", description: "Create an account as an employee, recruiter, or organization admin." },
  { step: "02", title: "Verify Email", description: "Confirm ownership of your email through a secure verification link." },
  { step: "03", title: "Get Assessed", description: "Complete structured, AI-assisted assessments that measure real ability." },
  { step: "04", title: "Get Discovered", description: "Share your verified passport, or discover verified talent as a recruiter." },
];

const AUDIENCE_CARDS = [
  {
    to: "/for-employees",
    icon: UsersIcon,
    title: "For Employees",
    description: "Own a portable, AI-verified record of your skills that travels with your career.",
    points: ["Verified, shareable passport", "Stand out beyond your resume", "Reusable across every application"],
  },
  {
    to: "/for-recruiters",
    icon: SparkIcon,
    title: "For Recruiters",
    description: "Shortlist candidates by proven proficiency instead of keyword-matched resumes.",
    points: ["Filter on verified skill", "Fewer redundant screens", "Hire with more confidence"],
  },
  {
    to: "/for-organizations",
    icon: BuildingIcon,
    title: "For Organizations",
    description: "Build and manage a verified talent pool with consistent hiring standards.",
    points: ["Centralized talent oversight", "Team skill coverage tracking", "Org-wide verification standard"],
  },
];

const TRUST_POINTS = [
  { icon: LockIcon, title: "Secure by default", description: "Passwords are hashed and verification tokens are hashed at rest — never stored in plain text." },
  { icon: ShieldIcon, title: "Verified, not self-reported", description: "Every skill entry is backed by a structured, AI-evaluated assessment." },
  { icon: CheckIcon, title: "Auditable trail", description: "Every verification event is traceable, so trust is never just a claim." },
];

const CAPABILITY_STATS = [
  { value: "3", label: "Verified Roles", description: "Employee, Recruiter, and Organization Admin" },
  { value: "AI", label: "Assessment Engine", description: "Structured, consistent skill evaluation" },
  { value: "24/7", label: "Passport Access", description: "Your verified profile, always available" },
  { value: "0", label: "Self-Rated Claims", description: "Skills are verified, never just declared" },
];

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
};

const Home = () => (
  <>
    {/* HERO */}
    <section className="relative overflow-hidden bg-midnight-950 bg-grid">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/4 top-0 h-[480px] w-[600px] -translate-y-1/3 rounded-full bg-indigo-600/30 blur-[130px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-20 h-[380px] w-[480px] rounded-full bg-cyan-500/20 blur-[120px]"
      />

      <Container className="relative grid gap-16 py-20 sm:py-28 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.08 } } }}
        >
          <motion.p
            variants={fadeUp}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm font-medium text-cyan-300"
          >
            <SparkIcon className="h-4 w-4" />
            AI-Powered Skill Verification
          </motion.p>

          <motion.h1
            variants={fadeUp}
            className="font-display mt-6 max-w-xl text-4xl font-bold leading-tight tracking-tight text-white sm:text-6xl"
          >
            Prove your skills.{" "}
            <span className="text-gradient">Not just your resume.</span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            className="mt-6 max-w-xl text-lg text-slate-300"
          >
            Verified Skills Passport gives employees a trustworthy, portable
            record of verified ability — and gives recruiters and
            organizations a faster, fairer way to find them.
          </motion.p>

          <motion.div
            variants={fadeUp}
            className="mt-10 flex flex-col gap-4 sm:flex-row"
          >
            <Button as="link" to="/register" size="lg">
              Get Started Free
            </Button>
            <Button as="link" to="/how-it-works" variant="glass" size="lg">
              See How It Works
            </Button>
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="glass relative rounded-2xl p-6 shadow-2xl shadow-black/40"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Verified Skills Passport
          </p>
          <h3 className="font-display mt-1 text-lg font-semibold text-white">
            Jordan Blake
          </h3>
          <p className="text-sm text-slate-400">Full-Stack Engineer</p>

          <div className="mt-6 space-y-3">
            {[
              { skill: "React & TypeScript", level: 92 },
              { skill: "System Design", level: 84 },
              { skill: "API Security", level: 88 },
            ].map((item) => (
              <div key={item.skill}>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-slate-200">
                    <CheckIcon className="h-4 w-4 text-cyan-300" />
                    {item.skill}
                  </span>
                  <span className="text-slate-400">{item.level}%</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${item.level}%` }}
                    transition={{ duration: 1, delay: 0.6 }}
                    className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-cyan-300"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs font-medium text-emerald-300">
            <CheckIcon className="h-4 w-4" />
            AI-Verified · Last updated recently
          </div>
        </motion.div>
      </Container>
    </section>

    {/* WORKFLOW */}
    <section className="bg-white py-20">
      <Container>
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
            Platform Workflow
          </p>
          <h2 className="font-display mt-2 text-3xl font-bold tracking-tight text-slate-900">
            From sign-up to verified passport
          </h2>
        </Reveal>

        <div className="relative mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div
            aria-hidden="true"
            className="absolute left-0 right-0 top-6 hidden h-px bg-gradient-to-r from-transparent via-indigo-200 to-transparent lg:block"
          />
          {WORKFLOW.map((item, index) => (
            <Reveal key={item.step} delay={index * 0.08} className="relative text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white shadow-lg shadow-indigo-500/25">
                {item.step}
              </div>
              <h3 className="mt-4 text-lg font-semibold text-slate-900">
                {item.title}
              </h3>
              <p className="mt-2 text-sm text-slate-600">
                {item.description}
              </p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>

    {/* AUDIENCE BENEFITS */}
    <section className="bg-slate-50 py-20">
      <Container>
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
            Built For Everyone
          </p>
          <h2 className="font-display mt-2 text-3xl font-bold tracking-tight text-slate-900">
            One platform, three perspectives
          </h2>
        </Reveal>

        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {AUDIENCE_CARDS.map((card, index) => (
            <Reveal key={card.to} delay={index * 0.1}>
              <Link
                to={card.to}
                className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-7 shadow-sm transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-500/10"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
                  <card.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-lg font-semibold text-slate-900">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  {card.description}
                </p>
                <ul className="mt-4 space-y-2">
                  {card.points.map((point) => (
                    <li
                      key={point}
                      className="flex items-start gap-2 text-sm text-slate-600"
                    >
                      <CheckIcon className="mt-0.5 h-4 w-4 flex-none text-indigo-500" />
                      {point}
                    </li>
                  ))}
                </ul>
                <span className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 group-hover:text-indigo-700">
                  Learn more
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
                </span>
              </Link>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>

    {/* TRUST / SECURITY */}
    <section className="relative overflow-hidden bg-midnight-950 bg-grid py-20">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/20 blur-[130px]"
      />
      <Container className="relative">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-cyan-300">
            Trust &amp; Security
          </p>
          <h2 className="font-display mt-2 text-3xl font-bold tracking-tight text-white">
            Verification you can actually trust
          </h2>
        </Reveal>

        <div className="mt-14 grid gap-6 sm:grid-cols-3">
          {TRUST_POINTS.map((point, index) => (
            <Reveal key={point.title} delay={index * 0.1} className="glass rounded-2xl p-6">
              <point.icon className="h-8 w-8 text-cyan-300" />
              <h3 className="mt-4 text-base font-semibold text-white">
                {point.title}
              </h3>
              <p className="mt-2 text-sm text-slate-400">
                {point.description}
              </p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>

    {/* CAPABILITY STATS */}
    <section className="bg-white py-20">
      <Container>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {CAPABILITY_STATS.map((stat, index) => (
            <Reveal key={stat.label} delay={index * 0.08} className="text-center">
              <ChartIcon className="mx-auto h-6 w-6 text-indigo-500" />
              <p className="font-display mt-3 text-3xl font-bold text-slate-900">
                {stat.value}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-800">
                {stat.label}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {stat.description}
              </p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>

    {/* FINAL CTA */}
    <section className="relative overflow-hidden bg-midnight-950 bg-grid py-20">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[380px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-indigo-600/30 to-cyan-500/30 blur-[130px]"
      />
      <Container className="relative text-center">
        <Reveal>
          <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Ready to build your verified passport?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-300">
            Join as an employee, recruiter, or organization — free to get
            started.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Button as="link" to="/register" size="lg">
              Create Your Account
            </Button>
            <Button as="link" to="/how-it-works" variant="glass" size="lg">
              See How It Works
            </Button>
          </div>
        </Reveal>
      </Container>
    </section>
  </>
);

export default Home;
