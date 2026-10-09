import { useNavigate } from "react-router-dom";

// Dedicated "Test Ended" page shown after an assessment finishes through any
// of its ending paths (violation termination or cancellation). It is purely
// informational: it makes NO API calls on mount, so refreshing or going back
// can never restart or regenerate an assessment, and it never renders the
// verification report itself.
const TestEnded = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Dedicated Assessment Header (matches AssessmentTake) */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30 px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 font-bold text-white text-sm shadow-md">
              VS
            </span>
            <div>
              <h1 className="font-display font-bold text-base text-white">Skill Verification Assessment</h1>
              <p className="text-xs text-indigo-400 font-medium">Skill Verification</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-800/80 p-6 sm:p-8 shadow-xl backdrop-blur text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-2xl">
              ✅
            </span>
            <h2 className="mt-5 font-display text-2xl font-bold text-white">
              Your test has ended
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-300">
              Check your dashboard to see your verification results/status.
            </p>
            <button
              type="button"
              onClick={() => navigate("/employee/skills")}
              className="mt-6 w-full rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 shadow-md"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default TestEnded;
