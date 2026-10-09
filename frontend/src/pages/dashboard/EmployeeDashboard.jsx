import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import { ChartIcon, ShieldIcon, SparkIcon } from "../../components/ui/icons";
import { useAuth } from "../../hooks/useAuth";
import { getDashboardVerificationSummary, getEmployeeDashboard } from "../../services/authService";
import { EMPLOYEE_NAV_ITEMS } from "../../constants/employeeNav";

const cardClasses = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const COUNTED_VERIFIED_STATUSES = new Set(["VERIFIED", "HIGHLY_VERIFIED"]);

const formatProficiency = (value) => value?.replaceAll("_", " ")?.toLowerCase()?.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Not provided";
const formatAvailability = (value) => value?.replaceAll("_", " ") || "Availability not set";
const formatStatusLabel = (value) => value?.replaceAll("_", " ")?.toLowerCase()?.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Not verified";

const isVerifiedStatus = (status) => COUNTED_VERIFIED_STATUSES.has(status);

const skillBadgeClasses = (status) => {
  if (isVerifiedStatus(status)) return "bg-emerald-100 text-emerald-800";
  if (status === "PARTIALLY_VERIFIED") return "bg-amber-100 text-amber-800";
  if (status === "INSUFFICIENT_EVIDENCE") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-600";
};

const EmployeeDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [verification, setVerification] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadDashboard = () => {
    setLoading(true);
    setError(false);
    Promise.all([getEmployeeDashboard(), getDashboardVerificationSummary()])
      .then(([dashboardResponse, verificationResponse]) => {
        setDashboard(dashboardResponse?.data ?? null);
        setVerification(verificationResponse?.data ?? null);
      })
      .catch((requestError) => {
        if (requestError.response?.status === 403 && requestError.response.data?.code === "PROFILE_INCOMPLETE") {
          navigate("/employee/profile/setup", {
            replace: true,
            state: { missingFields: requestError.response.data.data?.missingFields ?? [] },
          });
          return;
        }
        setError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([getEmployeeDashboard(), getDashboardVerificationSummary()])
      .then(([dashboardResponse, verificationResponse]) => {
        if (!mounted) return;
        setDashboard(dashboardResponse?.data ?? null);
        setVerification(verificationResponse?.data ?? null);
      })
      .catch((requestError) => {
        if (requestError.response?.status === 403 && requestError.response.data?.code === "PROFILE_INCOMPLETE") {
          navigate("/employee/profile/setup", {
            replace: true,
            state: { missingFields: requestError.response.data.data?.missingFields ?? [] },
          });
          return;
        }
        if (mounted) setError(true);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [navigate]);

  if (loading) {
    return <div className="p-10 text-sm text-slate-500">Loading Candidate Dashboard...</div>;
  }

  if (error || !dashboard) {
    return (
      <div className="p-10">
        <Alert variant="error">Unable to load your Candidate data.</Alert>
        <Button type="button" variant="outline" size="sm" className="mt-4" onClick={loadDashboard}>
          Try Again
        </Button>
      </div>
    );
  }

  const completion = dashboard.completion ?? {};
  const percentage = Math.max(0, Math.min(100, Number(completion.percentage) || 0));
  const skills = dashboard.skills ?? [];
  const projects = dashboard.projects ?? [];
  const desiredRoles = dashboard.desiredRoles ?? [];
  const missingFields = completion.missingFields ?? [];
  const verificationSkills = verification?.skills ?? [];
  const statusBySkillId = new Map(verificationSkills.map((skill) => [skill.skillId, skill.verificationStatus]));
  const totalSkills = Number.isFinite(verification?.totalSkills) ? verification.totalSkills : skills.length;
  const verifiedSkillsCount = Number.isFinite(verification?.verifiedSkillsCount)
    ? verification.verifiedSkillsCount
    : verificationSkills.filter((skill) => isVerifiedStatus(skill.verificationStatus)).length;
  const verificationRate = Number.isFinite(verification?.verificationRate)
    ? verification.verificationRate
    : totalSkills === 0
      ? 0
      : Math.round((verifiedSkillsCount / totalSkills) * 100);
  const partialCount = verificationSkills.filter((skill) => skill.verificationStatus === "PARTIALLY_VERIFIED").length;
  const pendingCount = verificationSkills.filter((skill) => !isVerifiedStatus(skill.verificationStatus) && skill.verificationStatus !== "PARTIALLY_VERIFIED" && skill.verificationStatus !== "INSUFFICIENT_EVIDENCE").length;
  const insufficientCount = verificationSkills.filter((skill) => skill.verificationStatus === "INSUFFICIENT_EVIDENCE").length;
  const verifiedSkills = verificationSkills.filter((skill) => isVerifiedStatus(skill.verificationStatus));

  const statCards = [
    { label: "Total Skills", value: totalSkills, hint: "Skills on your profile", icon: ChartIcon, accent: "from-indigo-500 to-cyan-400" },
    { label: "Verified Skills", value: verifiedSkillsCount, hint: "Verified or highly verified", icon: ShieldIcon, accent: "from-emerald-500 to-teal-400" },
    { label: "Verification Rate", value: `${verificationRate}%`, hint: "Verified skills ÷ total skills", icon: SparkIcon, accent: "from-indigo-600 to-violet-500" },
  ];

  return (
    <DashboardShell
      roleLabel="Candidate"
      title={`Welcome, ${dashboard.fullName || user?.fullName || "Candidate"}`}
      description="Your verified skills passport — a professional snapshot of what you have claimed and what has been verified."
      navItems={EMPLOYEE_NAV_ITEMS}
    >
      <div className="space-y-6">
        <section className={cardClasses}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Verified Skills Passport</p>
              <h2 className="mt-2 font-display text-xl font-bold text-slate-900">{dashboard.headline || "Add a professional headline"}</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{dashboard.bio || "Add an about description to introduce your experience."}</p>
            </div>
            <div className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">{formatAvailability(dashboard.availability)}</div>
          </div>
          {dashboard.careerInformation && <p className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-500">{dashboard.careerInformation}</p>}
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {statCards.map((card) => (
            <article key={card.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${card.accent} text-white`}>
                <card.icon className="h-5 w-5" />
              </div>
              <p className="mt-4 text-3xl font-bold tracking-tight text-slate-900">{card.value}</p>
              <p className="mt-1 text-sm font-semibold text-slate-800">{card.label}</p>
              <p className="mt-1 text-xs text-slate-500">{card.hint}</p>
            </article>
          ))}
        </section>

        <section className={cardClasses}>
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Verification overview</p>
              <h2 className="mt-2 font-display text-lg font-bold text-slate-900">Skill verification progress</h2>
              <p className="mt-2 max-w-xl text-sm text-slate-600">
                {totalSkills === 0
                  ? "Add skills to your profile to start building a verified passport."
                  : `${verifiedSkillsCount} of ${totalSkills} skills currently count as verified.`}
              </p>
            </div>
            <div
              className="flex h-28 w-28 flex-none items-center justify-center rounded-full"
              style={{ background: `conic-gradient(#059669 ${verificationRate}%, #e2e8f0 ${verificationRate}% 100%)` }}
              aria-label={`Verification rate ${verificationRate}%`}
              role="img"
            >
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-lg font-bold text-slate-900">
                {verificationRate}%
              </div>
            </div>
          </div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={verificationRate} aria-valuemin="0" aria-valuemax="100">
            <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${verificationRate}%` }} />
          </div>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-emerald-50 px-4 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Verified</dt>
              <dd className="mt-1 text-lg font-bold text-emerald-900">{verifiedSkillsCount}</dd>
            </div>
            <div className="rounded-xl bg-amber-50 px-4 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-amber-700">Partially verified</dt>
              <dd className="mt-1 text-lg font-bold text-amber-900">{partialCount}</dd>
            </div>
            <div className="rounded-xl bg-slate-50 px-4 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Not verified yet</dt>
              <dd className="mt-1 text-lg font-bold text-slate-800">{pendingCount}</dd>
            </div>
            <div className="rounded-xl bg-rose-50 px-4 py-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-rose-700">Insufficient evidence</dt>
              <dd className="mt-1 text-lg font-bold text-rose-900">{insufficientCount}</dd>
            </div>
          </dl>
          {verifiedSkills.length > 0 && (
            <div className="mt-5 border-t border-slate-100 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Verified skill names</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {verifiedSkills.map((skill) => (
                  <span key={skill.skillId} className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800">{skill.skillName}</span>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className={cardClasses}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-900">Preferred Roles</h2>
                <p className="mt-1 text-sm text-slate-500">Roles you want to be considered for.</p>
              </div>
              <Button as="link" to="/employee/profile" variant="ghost" size="sm">Edit</Button>
            </div>
            {desiredRoles.length > 0 ? (
              <ul className="mt-4 space-y-3">
                {desiredRoles.map((role) => (
                  <li key={role} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3">
                    <span className="text-sm font-medium text-slate-700">{role}</span>
                    <span className="text-xs font-medium text-slate-400">Alignment pending</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-slate-500">No preferred roles added yet.</p>
            )}
            <p className="mt-4 border-t border-dashed border-slate-200 pt-4 text-xs leading-5 text-slate-500">
              Role alignment scores will appear here once required skills for each preferred role are defined. No alignment percentage is shown yet.
            </p>
          </section>

          <section className={cardClasses}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Profile Completion</p>
                <p className="mt-2 text-3xl font-bold text-slate-900">{percentage}%</p>
                <p className={`mt-2 text-sm font-medium ${completion.isComplete ? "text-emerald-700" : "text-amber-700"}`}>
                  {completion.isComplete ? "Profile complete" : "Profile incomplete"}
                </p>
              </div>
              <div
                className="flex h-24 w-24 flex-none items-center justify-center rounded-full"
                style={{ background: `conic-gradient(#4f46e5 ${percentage}%, #e2e8f0 ${percentage}% 100%)` }}
                aria-label={`Profile completion ${percentage}%`}
                role="img"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-sm font-bold text-slate-900">
                  {percentage}%
                </div>
              </div>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={percentage} aria-valuemin="0" aria-valuemax="100">
              <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${percentage}%` }} />
            </div>
            {!completion.isComplete && missingFields.length > 0 && (
              <p className="mt-3 text-sm text-slate-600">Still needed: {missingFields.join(", ")}</p>
            )}
          </section>
        </div>

        <section className={cardClasses}>
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-slate-900">Skills Summary</h2>
            <Button as="link" to="/employee/skills" variant="ghost" size="sm">View All Skills</Button>
          </div>
          {skills.length > 0 ? (
            <div className="mt-4 space-y-3">
              {skills.slice(0, 4).map((skill) => {
                const status = statusBySkillId.get(skill.id);
                return (
                  <div key={skill.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{skill.name}</p>
                      <p className="text-xs text-slate-500">{skill.category || "Uncategorized"}</p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${skillBadgeClasses(status)}`}>
                        {status ? formatStatusLabel(status) : "Not verified"}
                      </span>
                      <p className="text-right text-sm text-slate-600">{formatProficiency(skill.proficiency)}{skill.yearsOfExperience != null ? ` · ${skill.yearsOfExperience} years` : ""}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No skills added yet.</p>
          )}
        </section>

        <section className={cardClasses}>
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-slate-900">Projects</h2>
            <Button as="link" to="/employee/projects" variant="ghost" size="sm">View All Projects</Button>
          </div>
          {projects.length > 0 ? (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {projects.slice(0, 4).map((project) => (
                <article key={project.id} className="rounded-xl border border-slate-200 p-4">
                  <h3 className="font-semibold text-slate-900">{project.name}</h3>
                  <p className="mt-2 line-clamp-2 text-sm text-slate-600">{project.description}</p>
                  {project.skills?.length > 0 && <p className="mt-3 text-xs text-slate-500">{project.skills.map((skill) => skill.customSkillName || skills.find(({ id }) => id === skill.skillId)?.name).filter(Boolean).join(" · ")}</p>}
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No projects added yet.</p>
          )}
        </section>
      </div>
    </DashboardShell>
  );
};

export default EmployeeDashboard;
