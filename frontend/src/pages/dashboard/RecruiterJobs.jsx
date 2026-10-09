import { useEffect, useRef, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Spinner from "../../components/ui/Spinner";
import { PlusIcon } from "../../components/ui/icons";
import JobStatusBadge from "../../components/jobs/JobStatusBadge";
import OverviewJobModal from "../../components/jobs/OverviewJobModal";
import { RECRUITER_NAV_ITEMS } from "../../constants/recruiterNav";
import useJobContext from "../../hooks/useJobContext";
import {
  getOrganizationLimits,
  getRecruiterLimits,
  listOverviewJobs,
} from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";

const cardClasses = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const PAGE_LIMIT = 10;

// The overview list is READ-ONLY: "Details" opens the read-only card, and the
// existing "Open" link keeps the recruiter's full job workspace reachable.
// Neither control is a mutation.
const TABLE_COLUMNS = [
  { key: "job", label: "Job" },
  { key: "status", label: "Status" },
  { key: "created", label: "Posted" },
  { key: "counts", label: "Candidates" },
  { key: "preferred", label: "Preferred target" },
  { key: "actions", label: "Actions" },
];

const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "CLOSED", label: "Closed / completed" },
];

const DATE_FILTERS = [
  { value: "", label: "Any time" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
  { value: "quarter", label: "Last 90 days" },
  { value: "year", label: "Last 12 months" },
];

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

// Quota is consumed on Start (never on draft save). limit === null means
// unlimited — the recruiter-facing word for that is exactly "Unlimited".
const QuotaBanner = ({ limits, loading }) => {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner className="h-4 w-4" /> Checking your job quota…
      </div>
    );
  }
  if (!limits) return null;

  const unlimited = limits.limit === null;
  const exhausted = !unlimited && limits.remaining <= 0;

  return (
    <div
      className={`rounded-xl border px-4 py-3 text-sm ${
        !limits.allowed || exhausted
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800"
      }`}
    >
      {unlimited ? (
        <>
          <span className="font-semibold">Unlimited</span> job postings on this plan —{" "}
          {limits.used} {limits.used === 1 ? "slot" : "slots"} used.
        </>
      ) : (
        <>
          <span className="font-semibold">
            {limits.used} of {limits.limit}
          </span>{" "}
          job {limits.limit === 1 ? "slot" : "slots"} used — {limits.remaining} remaining.
        </>
      )}{" "}
      <span className="text-xs opacity-80">
        (Slots are consumed when a draft is started, not when it is saved.)
      </span>
      {limits.reason && <span className="sr-only"> {limits.reason}</span>}
    </div>
  );
};

const RecruiterJobs = () => {
  const jobContext = useJobContext();
  const [jobs, setJobs] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [limits, setLimits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [limitsLoading, setLimitsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Server-side filters. These are never applied in the browser: the browser
  // only ever holds ONE page, so a large organization never downloads (or
  // filters client-side) thousands of jobs.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [withinFilter, setWithinFilter] = useState("");
  const [detailJobId, setDetailJobId] = useState(null);

  const contextBlocked = jobContext.kind === "error" || jobContext.kind === "unresolved";

  // Monotonically increasing request sequence: discards stale responses when
  // pagination clicks or typing outrun the network.
  const requestSeq = useRef(0);

  // Debounce the search box so typing does not issue a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Fetchers perform NO synchronous setState (react-hooks/set-state-in-effect
  // runs them from an effect): every update happens after an await. Pagination
  // buttons set loading / clear errors in their own event handlers instead.
  const fetchJobs = async (targetPage) => {
    const seq = (requestSeq.current += 1);
    try {
      // The overview endpoint derives ownership server-side from the
      // authenticated principal, so no organizationId is sent from here.
      const response = await listOverviewJobs({
        page: targetPage,
        limit: PAGE_LIMIT,
        search,
        status: statusFilter,
        within: withinFilter,
      });
      if (seq !== requestSeq.current) return;
      setJobs(response.data ?? []);
      setPagination(response.pagination ?? null);
      setError(null);
    } catch (requestError) {
      if (seq !== requestSeq.current) return;
      setJobs([]);
      setError(extractApiErrorMessage(requestError, "Unable to load your jobs."));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  const fetchLimits = async () => {
    try {
      const response =
        jobContext.kind === "organization"
          ? await getOrganizationLimits(jobContext.organizationId)
          : await getRecruiterLimits();
      setLimits(response.data ?? null);
    } catch {
      // Non-fatal: the list is still usable without the quota banner.
      setLimits(null);
    } finally {
      setLimitsLoading(false);
    }
  };

  // The limits banner is fetched once; it does not depend on the filters.
  useEffect(() => {
    if (contextBlocked) return;
    let cancelled = false;
    (async () => {
      await fetchLimits();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextBlocked, jobContext.kind, jobContext.organizationId]);

  useEffect(() => {
    if (contextBlocked) return;
    // Both fetchers only setState after their awaits; the async IIFE keeps
    // the effect body itself free of synchronous state updates.
    let cancelled = false;
    (async () => {
      await fetchJobs(page);
      if (!cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
    // jobContext (and the fetchers closing over it) is derived per render from
    // the session; only context liveness, the page number and the filters change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextBlocked, page, search, statusFilter, withinFilter]);

  const hasActiveFilters = Boolean(search || statusFilter || withinFilter);

  if (contextBlocked) {
    return (
      <DashboardShell roleLabel="Recruiter" title="Jobs" navItems={RECRUITER_NAV_ITEMS}>
        <Alert variant="error">{jobContext.message}</Alert>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      roleLabel="Recruiter"
      title="Jobs"
      description="Drafts are free to save — quota is consumed only when a job is started."
      navItems={RECRUITER_NAV_ITEMS}
    >
      <div className="space-y-6">
        {error && <Alert variant="error">{error}</Alert>}

        <section className={cardClasses}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-bold text-slate-900">Job postings</h2>
              <p className="mt-1 text-sm text-slate-500">
                Every job you create will be listed here with its analysis, assessment and
                candidate progress.
              </p>
            </div>
            <Button as="link" to="/recruiter/jobs/create" size="sm">
              <PlusIcon className="h-4 w-4" />
              Create Job
            </Button>
          </div>

          <div className="mt-5">
            <QuotaBanner limits={limits} loading={limitsLoading} />
          </div>

          {/* Server-side filters. Every control maps to a query parameter the
              backend applies with an indexed, parameterized query — nothing is
              filtered in the browser. */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by job title or Job ID"
              aria-label="Search jobs by title or ID"
              className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:w-72"
            />
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by job status"
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={withinFilter}
              onChange={(event) => {
                setWithinFilter(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by date posted"
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            >
              {DATE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {hasActiveFilters && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                  setStatusFilter("");
                  setWithinFilter("");
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {TABLE_COLUMNS.map(({ key, label }) => (
                    <th key={key} className="px-3 py-2.5 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && jobs.length === 0 ? (
                  <tr>
                    <td colSpan={TABLE_COLUMNS.length} className="px-3 py-12 text-center">
                      <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
                        <Spinner className="h-4 w-4" /> Loading your jobs…
                      </div>
                    </td>
                  </tr>
                ) : jobs.length === 0 ? (
                  <tr>
                    <td colSpan={TABLE_COLUMNS.length} className="px-3 py-12 text-center">
                      {hasActiveFilters ? (
                        <>
                          <p className="text-sm font-medium text-slate-700">
                            No jobs match your search
                          </p>
                          <p className="mt-1 text-sm text-slate-500">
                            Try a different title or Job ID, or widen the status and date filters.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-medium text-slate-700">No jobs yet</p>
                          <p className="mt-1 text-sm text-slate-500">
                            Create your first job draft to get started — only the title is required.
                          </p>
                          <div className="mt-4 flex justify-center">
                            <Button as="link" to="/recruiter/jobs/create" size="sm" variant="outline">
                              <PlusIcon className="h-4 w-4" /> Create Job
                            </Button>
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => (
                    <tr key={job.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-3.5">
                        <button
                          type="button"
                          onClick={() => setDetailJobId(job.id)}
                          className="text-left text-indigo-600 hover:text-indigo-700 hover:underline"
                          title="Open the read-only job details"
                        >
                          <span className="font-medium text-slate-900">{job.title}</span>
                        </button>
                        {/* The Job ID is on the row so it can be searched for. */}
                        <p className="mt-0.5 break-all font-mono text-xs text-slate-400">
                          {job.id}
                        </p>
                      </td>
                      <td className="px-3 py-3.5">
                        <JobStatusBadge status={job.status} closedReason={job.closedReason} />
                      </td>
                      <td className="px-3 py-3.5 text-slate-600">{formatDate(job.createdAt)}</td>
                      <td className="px-3 py-3.5 text-slate-600">
                        <span className="font-medium text-slate-900">
                          {job.counts?.candidates ?? 0}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {job.counts?.analyses ?? 0} analysed
                        </span>
                      </td>
                      {/* The recruiter-configured preferred-candidate TARGET exactly as
                          they set it — a number they chose, not a ranking or a score. */}
                      <td className="px-3 py-3.5 text-slate-600">
                        {job.preferredCandidateTarget ?? (
                          <span className="text-slate-400" title="No preference configured">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3.5">
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setDetailJobId(job.id)}
                          >
                            Details
                          </Button>
                          <Button as="link" to={`/recruiter/jobs/${job.id}`} variant="ghost" size="sm">
                            Open
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* The read-only job-details card: details + candidates + the two
              separate report types. It issues GET requests only. */}
          {detailJobId && (
            <OverviewJobModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />
          )}

          {pagination && pagination.totalPages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
              <span>
                Page {pagination.page} of {pagination.totalPages} — {pagination.total}{" "}
                {pagination.total === 1 ? "job" : "jobs"}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading || pagination.page <= 1}
                  onClick={() => {
                    setLoading(true);
                    setError(null);
                    setPage((current) => Math.max(current - 1, 1));
                  }}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading || pagination.page >= pagination.totalPages}
                  onClick={() => {
                    setLoading(true);
                    setError(null);
                    setPage((current) => current + 1);
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </DashboardShell>
  );
};

export default RecruiterJobs;
