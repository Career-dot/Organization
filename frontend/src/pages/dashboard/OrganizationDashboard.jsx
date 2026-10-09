import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Spinner from "../../components/ui/Spinner";
import { ActivityChart, AssessmentActivityChart, HiringChart } from "../../components/organization/OrgAnalyticsCharts";
import { ORG_ADMIN_NAV_ITEMS, ORG_RANGE_OPTIONS, formatOrgDate } from "../../components/organization/orgAdminNav";
import { getAuditSummary, getAuditAnalytics } from "../../services/organizationService";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// PHASE 1/2/3 — the ORG ADMIN EXECUTIVE DASHBOARD.
//
// Its single responsibility is "how is the organization doing overall?". It is
// deliberately ORGANIZATION-LEVEL ONLY:
//
//   * recruiter add / remove / reset credentials live on the separate
//     "Manage Recruiters" page (unchanged, pre-existing);
//   * per-recruiter audit lives on the separate "Recruiter Analysis" page;
//   * job/candidate inspection lives on the separate "Job Analysis" page.
//
// This page renders NO recruiter-management control and NO per-job/per-candidate
// audit table, and it exposes NO mutation at all. The recruiter-management
// components were MOVED to those sections, not duplicated here.
//
// Every figure comes from the existing aggregate endpoints, which read the
// EXISTING Job / JobCandidateReference / JobAssessmentAttempt / AiJob rows.
// Nothing is persisted here, and no AI service is called to fill a card.
// ---------------------------------------------------------------------------

// `limit === null` means UNLIMITED on the current plan. Rendering that as 0 or
// "—" would be misleading, so it is spelled out.
const MetricCard = ({ label, used, limit, remaining }) => {
  const unlimited = limit === null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">
        {unlimited ? `${used}` : `${used} / ${limit}`}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {unlimited ? "Unlimited plan" : `${remaining} remaining`}
      </p>
    </div>
  );
};

const CountCard = ({ label, value, hint }) => (
  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
    {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
  </div>
);

const SectionCard = ({ title, description, children, action }) => (
  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-base font-semibold text-slate-900">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
      </div>
      {action}
    </div>
    <div className="mt-4">{children}</div>
  </section>
);


const OrganizationDashboard = () => {
  const [summary, setSummary] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [range, setRange] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // The summary is the small, executive-level payload; analytics is fetched
    // alongside it for the charts. Neither returns candidate-analysis JSON.
    Promise.all([
      getAuditSummary(),
      getAuditAnalytics(range === "ALL" ? {} : { range }),
    ])
      .then(([summaryResponse, analyticsResponse]) => {
        if (cancelled) return;
        setSummary(summaryResponse.data ?? null);
        setAnalytics(analyticsResponse.data ?? null);
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(extractApiErrorMessage(caught, "Could not load the organization dashboard."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [range]);

  const subscription = summary?.subscription;

  return (
    <DashboardShell
      roleLabel="Organization"
      title={summary?.organization?.name ?? "Organization"}
      description="Organization-level overview and analytics. Recruiter, job and candidate detail live in their own sections."
      navItems={ORG_ADMIN_NAV_ITEMS}
      statCards={[]}
    >
      {error && <Alert variant="error">{error}</Alert>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4" /> Loading organization overview…
        </div>
      ) : (
        summary && (
          <div className="space-y-8">
            {/* ---- PHASE 1: organization overview -------------------------- */}
            <section>
              <h2 className="font-display text-base font-semibold text-slate-900">
                Organization Overview
              </h2>

              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label="Recruiter Seats"
                  used={summary.seats.used}
                  limit={summary.seats.limit}
                  remaining={summary.seats.remaining}
                />
                <MetricCard
                  label="Jobs"
                  used={summary.jobs.used}
                  limit={summary.jobs.limit}
                  remaining={summary.jobs.remaining}
                />
                <CountCard label="Recruiters" value={summary.recruiters.active} hint={`${summary.recruiters.total} total`} />
                <CountCard
                  label="Candidates"
                  value={summary.candidates.total}
                  hint={`${summary.candidates.withCompletedAssessment} assessed`}
                />
              </div>

              {/* Recruiter management is a SEPARATE section; the dashboard only
                  links to it and never renders its controls. */}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-sm text-slate-600">
                  {summary.recruiters.active} active recruiter
                  {summary.recruiters.active === 1 ? "" : "s"}
                </p>
                <Button as="link" to="/organization/dashboard/recruiters" size="sm">
                  Manage Recruiters
                </Button>
              </div>
            </section>
{/* ---- PHASE 1: subscription (read-only, from existing data) ---- */}
            <SectionCard
              title="Subscription"
              description="Read from your organization's existing subscription. No changes are made here."
              action={
                <Button as="link" to="/organization/subscription" size="sm" variant="outline">
                  Manage subscription
                </Button>
              }
            >
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <CountCard label="Plan" value={subscription?.planName ?? "—"} />
                <div className="rounded-xl border border-slate-200 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</p>
                  <p
                    className={`mt-1 inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                      subscription?.active
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-amber-200 bg-amber-50 text-amber-700"
                    }`}
                  >
                    {subscription?.status ?? "No subscription"}
                  </p>
                </div>
                <CountCard label="Expires" value={formatOrgDate(subscription?.expiryDate)} />
                <CountCard
                  label="Job quota"
                  value={
                    summary.jobs.limit === null
                      ? "Unlimited"
                      : `${summary.jobs.used} / ${summary.jobs.limit}`
                  }
                  hint={
                    summary.jobs.limit === null
                      ? "No posting cap on this plan"
                      : `${summary.jobs.remaining} remaining`
                  }
                />
              </div>
            </SectionCard>

            {/* ---- PHASE 1/3: analysis state ------------------------------- */}
            <SectionCard
              title="Analysis"
              description="Candidate-analysis pipeline state from the platform's own job records."
            >
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <CountCard label="Analyzed" value={summary.analysis.completed} />
                <CountCard label="Pending" value={summary.analysis.pending} />
                <CountCard label="Failed" value={summary.analysis.failed} />
                <CountCard label="Total analyses" value={summary.analysis.total} />
              </div>
            </SectionCard>

            {/* ---- PHASE 2: hiring overview -------------------------------
                The chart renders a real Hired / Not hired split ONLY when the
                backend reports hiring.available === true, i.e. only once an
                explicit persisted recruiter hiring decision exists. Until then it
                shows an empty state and never estimates a number from an
                assessment score, an AI analysis or a preference. */}
            <SectionCard
              title="Hiring Overview"
              description="Hiring is an explicit recruiter decision. It is not inferred from assessment scores or AI analysis."
              action={
                <div className="flex items-center gap-2">
                  <label htmlFor="hiring-range" className="text-xs font-medium text-slate-600">
                    Period
                  </label>
                  <select
                    id="hiring-range"
                    value={range}
                    onChange={(event) => setRange(event.target.value)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
                  >
                    {ORG_RANGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              }
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <CountCard
                  label="Total candidates"
                  value={summary.hiring?.totalCandidates ?? 0}
                />
                {/* null renders as an em dash: "unknown", not "zero hired". */}
                <CountCard
                  label="Hired"
                  value={summary.hiring?.available ? summary.hiring.hired : "—"}
                />
                <CountCard
                  label="Hiring rate"
                  value={
                    summary.hiring?.available && Number.isFinite(summary.hiring.hiringRate)
                      ? `${summary.hiring.hiringRate}%`
                      : "—"
                  }
                />
              </div>

              <div className="mt-5">
                <HiringChart hiring={summary.hiring} />
                {!summary.hiring?.available && summary.hiring?.reason ? (
                  <p className="mt-3 text-xs text-slate-500">{summary.hiring.reason}</p>
                ) : null}
              </div>
            </SectionCard>

            {/* ---- PHASE 3: activity over time ----------------------------- */}
            <SectionCard
              title="Job & candidate activity"
              description="Monthly totals computed in the database from persisted records."
            >
              <ActivityChart series={analytics?.series ?? []} />
            </SectionCard>

            {/* ---- PHASE 4: organization-level assessment activity --------- */}
            {/*
              Aggregate-only. Counts persisted ATTEMPTS by lifecycle state for the
              whole organization — never candidates, and never a score. The
              all-time cards come from /dashboard/summary; the monthly trend is
              windowed by the selected range via /dashboard/analytics.
            */}
            <SectionCard
              title="Assessment activity"
              description="Counts of assessment attempts by persisted lifecycle state across the organization. No candidate-level data."
            >
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <CountCard
                  label="Started"
                  value={summary.assessments?.started ?? 0}
                  hint="Persisted STARTED attempts"
                />
                <CountCard
                  label="In progress"
                  value={summary.assessments?.inProgress ?? 0}
                  hint="Started or in progress, not finished"
                />
                <CountCard
                  label="Submitted"
                  value={summary.assessments?.submitted ?? 0}
                  hint="Completed attempts"
                />
                <CountCard
                  label="Timed up"
                  value={summary.assessments?.timedUp ?? 0}
                  hint="Reached the deadline"
                />
                <CountCard
                  label="Cheated"
                  value={summary.assessments?.cheated ?? 0}
                  hint="Integrity rule triggered"
                />
              </div>

              <div className="mt-5">
                <AssessmentActivityChart series={analytics?.series ?? []} />
                {/* Only claim a "selected period" figure when a real window is
                    actually active — with All time the all-time cards above are
                    the honest numbers, and repeating them would be misleading. */}
                {analytics?.range?.label && analytics.range.label !== "ALL" ? (
                  <p className="mt-3 text-xs text-slate-500">
                    In the selected period: {analytics?.assessments?.submitted ?? 0} submitted,{" "}
                    {analytics?.assessments?.timedUp ?? 0} timed up,{" "}
                    {analytics?.assessments?.cheated ?? 0} cheated.
                  </p>
                ) : null}
              </div>
            </SectionCard>

            {/* Section links: detail lives elsewhere, never inline here. */}
            <section>
              <h2 className="font-display text-base font-semibold text-slate-900">Explore</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button as="link" to="/organization/dashboard/recruiters" size="sm" variant="outline">
                  Manage Recruiters
                </Button>
                <Button as="link" to="/organization/dashboard/jobs" size="sm" variant="outline">
                  Job Analysis
                </Button>
                <Button
                  as="link"
                  to="/organization/dashboard/recruiter-analysis"
                  size="sm"
                  variant="outline"
                >
                  Recruiter Analysis
                </Button>
              </div>
            </section>
          </div>
        )
      )}
    </DashboardShell>
  );
};

export default OrganizationDashboard;
