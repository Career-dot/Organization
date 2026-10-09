import { useEffect, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import JobStatusBadge from "../jobs/JobStatusBadge";
import OverviewJobModal from "../jobs/OverviewJobModal";
import { getAuditRecruiterJobs } from "../../services/organizationService";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// PHASE 3 — one recruiter's jobs, read-only, inside the Org Admin audit view.
//
// REUSES the existing read-only job card: opening "Details" renders the SAME
// OverviewJobModal the recruiter dashboard uses, which in turn renders the
// existing OverviewCandidateTable and the existing verification-report /
// candidate-analysis modals. No org-specific copy of any of that was created.
//
// This panel exposes no edit, close, invite, select, re-run or delete control:
// the Org Admin is an auditor, and every read is served by an existing
// organization-scoped endpoint.
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 10;

const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "CLOSED", label: "Closed / completed" },
];

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

const JobCard = ({ job, onOpen }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-display text-sm font-semibold text-slate-900">{job.title}</p>
        <p className="text-xs text-slate-500">{job.id}</p>
      </div>
      <JobStatusBadge status={job.status} />
    </div>

    <p className="mt-3 text-xs text-slate-600">
      Candidates: <span className="font-semibold">{job.counts.candidates}</span> · Attempts:{" "}
      <span className="font-semibold">{job.counts.attempts}</span> · Analyses:{" "}
      <span className="font-semibold">{job.counts.analyses}</span> · Selected:{" "}
      {/* Not persisted anywhere -> "—" rather than a fabricated 0. */}
      <span className="font-semibold text-slate-400">{job.counts.selected ?? "—"}</span>
    </p>

    <p className="mt-1 text-xs text-slate-500">
      Created: {formatDate(job.createdAt)}
      {job.closedAt ? ` · Closed: ${formatDate(job.closedAt)}` : ""}
    </p>

    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3"
      onClick={() => onOpen(job.id)}
    >
      View details
    </Button>
  </div>
);

const RecruiterJobsPanel = ({ recruiter, range, onClose }) => {
  const [jobs, setJobs] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openJobId, setOpenJobId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAuditRecruiterJobs(recruiter.userId, {
      page,
      limit: PAGE_LIMIT,
      ...(status ? { status } : {}),
      ...(range && range !== "ALL" ? { range } : {}),
    })
      .then((response) => {
        if (cancelled) return;
        setJobs(response.data?.jobs ?? []);
        setPagination(response.data?.pagination ?? null);
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(extractApiErrorMessage(caught, "Could not load this recruiter's jobs."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recruiter.userId, status, page, range]);

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-semibold text-slate-900">
            {recruiter.fullName} — jobs
          </h3>
          <p className="text-xs text-slate-500">
            Read-only audit view. Open a job to inspect its details and candidates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="job-status" className="text-xs font-medium text-slate-600">
            Status
          </label>
          <select
            id="job-status"
            value={status}
            onChange={(event) => {
              setPage(1);
              setStatus(event.target.value);
            }}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4" /> Loading jobs…
        </div>
      ) : jobs.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          No jobs match this filter.
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} onOpen={setOpenJobId} />
            ))}
          </div>

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
                Page {pagination.page} of {pagination.totalPages}
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
        </>
      )}

      {/* The EXISTING read-only job card. It fetches GET /api/job/overview/:jobId,
          already authorized for an ORG_ADMIN of the owning organization. */}
      {openJobId && (
        <OverviewJobModal jobId={openJobId} onClose={() => setOpenJobId(null)} />
      )}
    </section>
  );
};

export default RecruiterJobsPanel;
