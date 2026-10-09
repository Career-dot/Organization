import { Link } from "react-router-dom";
import Container from "../ui/Container";

const FOOTER_LINKS = {
  Product: [
    { to: "/how-it-works", label: "How It Works" },
    { to: "/about", label: "About" },
  ],
  Solutions: [
    { to: "/for-employees", label: "For Employees" },
    { to: "/for-recruiters", label: "For Recruiters" },
    { to: "/for-organizations", label: "For Organizations" },
  ],
  Account: [
    { to: "/login", label: "Login" },
    { to: "/register", label: "Register" },
  ],
};

const PublicFooter = () => (
  <footer className="border-t border-white/10 bg-midnight-950 bg-grid">
    <Container className="grid gap-10 py-16 md:grid-cols-[2fr_1fr_1fr_1fr]">
      <div>
        <Link to="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white">
            VS
          </span>
          <span className="font-display text-base font-semibold text-white">
            Verified Skills Passport
          </span>
        </Link>
        <p className="mt-4 max-w-sm text-sm text-slate-400">
          AI-verified proof of skill for employees, recruiters, and
          organizations — one trustworthy passport for every hire.
        </p>
      </div>

      {Object.entries(FOOTER_LINKS).map(([heading, links]) => (
        <div key={heading}>
          <h3 className="text-sm font-semibold text-white">{heading}</h3>
          <ul className="mt-4 space-y-3">
            {links.map((link) => (
              <li key={link.to}>
                <Link
                  to={link.to}
                  className="text-sm text-slate-400 hover:text-cyan-300"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Container>

    <div className="border-t border-white/10 py-6">
      <Container>
        <p className="text-sm text-slate-500">
          © {new Date().getFullYear()} Verified Skills Passport. All rights
          reserved.
        </p>
      </Container>
    </div>
  </footer>
);

export default PublicFooter;
