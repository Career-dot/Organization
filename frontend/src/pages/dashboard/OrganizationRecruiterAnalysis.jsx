import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Spinner from "../../components/ui/Spinner";
import RecruiterJobsPanel from "../../components/organization/RecruiterJobsPanel";
import { ORG_ADMIN_NAV_ITEMS, ORG_RANGE_OPTIONS } from "../../components/organization/orgAdminNav";
import { getAuditRecruiters } from "../../services/organizationService";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// PHASE 2 — RECRUITER ANALYSIS.
//
// READ-ONLY recruiter-wise activity. It is NOT recruiter management (that is the
// separate "Manage Recruiters" page) and NOT a job-details surface (that is
// "Job Analysis"); the existing read-only RecruiterJobsPanel is reused for the
// per-recruiter job list rather than duplicating it here.
//
// SEARCH IS SERVER-SIDE. `search` is sent to the API and applied in PostgreSQL
// against the persisted recruiter name/email. This page deliberately does NOT
// call `.filter()` over the loaded recruiters, so the result is never limited to
// one page of client-side data.
//
// HIRING IS NOT INVENTED. No per-candidate hired/selected state is persisted, so
// the API returns `hiring.available === false` and the UI shows an explicit
// "not tracked yet" state instead of a fabricated number.
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 10;

const STATUS_BADGE = {
  ACTIVE: "border-emerald-200 bg-emerald-50 text-emerald-700",
  INVITED: "border-amber-200 bg-amber-50 text-amber-700",
  REMOVED: "border-slate-200 bg-slate-100 text-slate-500",
};

const Stat = ({ label, value }) => (
  <div>
    <dt className="text-xs text-slate-500">{label}</dt>
    <dd className="text-lg font-semibold text-slate-900">{value}</dd>
  </div>
);

// ---------------------------------------------------------------------------
// PHASE 6 â€” RECRUITER ANALYSIS.
//
// Answers "how much recruiting activity happens through each recruiter?". It is
// the HOME of the per-recruiter audit that used to live on the dashboard; that UI
// was MOVED here, not duplicated, and the dashboard no longer renders it.
//
// CAPACITY IS ORGANIZATION-LEVEL. The platform has no per-recruiter quota
// (JobQuotaConsumption is keyed by the organization's subscription), so the org's
// capacity is shown once at the top and each recruiter's USAGE is listed against
// it. No individual limit is invented.
//
// READ-ONLY: no add / remove / reset-credentials control here â€” those live on the
// separate "Manage Recruiters" page. "View jobs" opens the EXISTING read-only
// jobs panel.
// ---------------------------------------------------------------------------

const RecruiterAnalysisPage = () => {
  const [recruiters, setRecruiters] = useState([]);
  const [quota, setQuota] = useState(null);
  const [seats, setSeats] = useState(null);
  const [unattributed, setUnattributed] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [range, setRange] = useState("ALL");
  // `searchInput` is what the user has typed; `search` is what is actually sent,
  // so typing does not fire a request on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [jobsFor, setJobsFor] = useState(null);

  // Enter (or the Search button) applies the typed term.
  const applySearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };
  const clearSearch = () => {
    setSearchInput("");
    setPage(1);
    setSearch("");
  };

  useEffect(() => {
    let cancelled = false;

    // Defer the state updates to a microtask so nothing is set synchronously in
    // the effect body (that pattern triggers cascading renders).
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true);
    });

    // Every filter is passed to the SERVER. Nothing is filtered in React, so the
    // list is always the full searched/paged result set from PostgreSQL.
    const params = { page, limit: PAGE_LIMIT };
    if (range !== "ALL") {
      if (range === "CUSTOM") {
        if (from) params.from = from;
        if (to) params.to = to;
      } else {
        params.range = range;
      }
    }
    if (search) params.search = search;

    getAuditRecruiters(params)
      .then((response) => {
        if (cancelled) return;
        setRecruiters(response.data?.recruiters ?? []);
        setQuota(response.data?.organizationJobQuota ?? null);
        setSeats(response.data?.seats ?? null);
        setUnattributed(response.data?.unattributedHistoricalJobs ?? null);
        setPagination(response.data?.pagination ?? null);
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(extractApiErrorMessage(caught, "Could not load recruiter analytics."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, search, page, from, to]);

return (
    <DashboardShell
      roleLabel="Organization"
      title="Recruiter Analysis"
      description="Recruiter-wise activity from persisted job and candidate records."
      navItems={ORG_ADMIN_NAV_ITEMS}
      statCards={[]}
    >
      {error && <Alert variant="error">{error}</Alert>}

      {/* Seats + capacity. Both are ORGANIZATION-level: the platform has no
          per-recruiter quota, so no individual limit is invented here. */}
      {seats && (
        <p className="mb-3 text-sm text-slate-600">
          Recruiter seats: {seats.active} active of {seats.total} total
          {seats.removed > 0 ? ` · ${seats.removed} removed` : ""}
          {" · "}
          {quota
            ? quota.limit === null
              ? `Job capacity: unlimited (${quota.used} used)`
              : `Job capacity: ${quota.used} / ${quota.limit} used`
            : ""}
        </p>
      )}

      {/* Filters. Search is applied SERVER-SIDE (name + email), so this input
          never filters the already-loaded page in React. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="ra-search" className="text-xs font-medium text-slate-600">
            Search recruiters
          </label>
          <input
            id="ra-search"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applySearch();
            }}
            placeholder="Name or email"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={applySearch}>
          Search
        </Button>
        {search && (
          <Button type="button" variant="ghost" size="sm" onClick={clearSearch}>
            Clear
          </Button>
        )}

        <div className="flex items-center gap-2">
          <label htmlFor="ra-range" className="text-xs font-medium text-slate-600">
            Period
          </label>
          <select
            id="ra-range"
            value={range}
            onChange={(event) => {
              setPage(1);
              setRange(event.target.value);
            }}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          >
            {ORG_RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Custom range inputs appear only when CUSTOM is selected, and are sent
            to the server, which validates from <= to and rejects a bad range. */}
        {range === "CUSTOM" && (
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="ra-from" className="text-xs font-medium text-slate-600">
                From
              </label>
              <input
                id="ra-from"
                type="date"
                value={from}
                onChange={(event) => {
                  setPage(1);
                  setFrom(event.target.value);
                }}
                className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="ra-to" className="text-xs font-medium text-slate-600">
                To
              </label>
              <input
                id="ra-to"
                type="date"
                value={to}
                onChange={(event) => {
                  setPage(1);
                  setTo(event.target.value);
                }}
                className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
          </div>
        )}
      </div>

      {search && (
        <p className="mt-2 text-xs text-slate-500">
          Showing server-side search results for &quot;{search}&quot;.
        </p>
      )}

      {/* PHASE 1 interaction: jobs detached from a permanently deleted recruiter
          still belong to the organization, so they are shown explicitly instead
          of vanishing from the totals. They are NEVER attributed to a
          surviving recruiter. */}
      {unattributed && unattributed.total > 0 && (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-700">
            {unattributed.label}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            These jobs belong to a recruiter account that was permanently deleted.
            They are retained as historical organization data and are not counted
            against any current recruiter.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Jobs" value={unattributed.total} />
            <Stat label="Active" value={unattributed.byStatus.ACTIVE} />
            <Stat label="Closed" value={unattributed.byStatus.CLOSED} />
            <Stat label="Candidates" value={unattributed.candidates} />
            <Stat label="Analyses" value={unattributed.analyses} />
          </dl>
        </div>
      )}

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4" /> Loading recruiter analyticsâ€¦
        </div>
      ) : recruiters.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          {search
            ? `No recruiters match "${search}".`
            : "No recruiters yet. Invite one from Manage Recruiters."}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {recruiters.map((recruiter) => (
            <div key={recruiter.membershipId} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-base font-semibold text-slate-900">
                    {recruiter.fullName}
                  </p>
                  <p className="text-sm text-slate-500">{recruiter.email}</p>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                    STATUS_BADGE[recruiter.status] ?? STATUS_BADGE.REMOVED
                  }`}
                >
                  {recruiter.status}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Jobs posted" value={recruiter.jobs.posted} />
                <Stat label="Candidates" value={recruiter.candidates} />
                <Stat label="Analyzed" value={recruiter.analyzed} />
                <Stat
                  label="Assessments"
                  value={recruiter.assessments.total}
                />
              </dl>

              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Active jobs" value={recruiter.jobs.active} />
                <Stat label="Closed jobs" value={recruiter.jobs.closed} />
                <Stat label="Assessments done" value={recruiter.assessments.submitted} />
                {/* Real persisted counts: submitted / total attempts. null when
                    the recruiter has no attempts at all. */}
                <Stat
                  label="Completion"
                  value={
                    recruiter.assessments.completionRate === null
                      ? "—"
                      : `${recruiter.assessments.completionRate}%`
                  }
                />
              </dl>

              <p className="mt-3 text-xs text-slate-500">
                In progress: {recruiter.assessments.inProgress} · Timed out:{" "}
                {recruiter.assessments.timedUp} · Cheated:{" "}
                {recruiter.assessments.cheated}
                {recruiter.inRange
                  ? ` · In period: ${recruiter.inRange.jobsPosted} jobs, ${recruiter.inRange.candidatesAdded} candidates`
                  : ""}
              </p>

              {/* HIRING — honest empty state. No per-candidate hired/selected row
                  exists in the schema, so this is never derived from an
                  assessment score, an AI analysis, a preferred candidate or an
                  invitation. `available` comes from the server, not a guess. */}
              <p className="mt-2 text-xs text-slate-400">
                {recruiter.hiring?.available
                  ? `Hired: ${recruiter.hiring.hired}`
                  : "Hiring: not tracked yet — no hiring decision is recorded in the platform."}
              </p>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => setJobsFor(recruiter)}
              >
                View jobs
              </Button>
            </div>
          ))}
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(current - 1, 1))}
          >
            Previous
          </Button>
          <span className="text-slate-600">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} recruiters)
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {/* The EXISTING read-only recruiter jobs panel, reused unchanged. */}
      {jobsFor && (
        <RecruiterJobsPanel
          recruiter={jobsFor}
          range={range}
          onClose={() => setJobsFor(null)}
        />
      )}
    </DashboardShell>
  );
};

export default RecruiterAnalysisPage;
