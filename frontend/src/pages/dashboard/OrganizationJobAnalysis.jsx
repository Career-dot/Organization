import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Spinner from "../../components/ui/Spinner";
import JobStatusBadge from "../../components/jobs/JobStatusBadge";
import OverviewJobModal from "../../components/jobs/OverviewJobModal";
import {
  ORG_ADMIN_NAV_ITEMS,
  ORG_JOB_STATUS_OPTIONS,
  ORG_RANGE_OPTIONS,
  formatOrgDate,
} from "../../components/organization/orgAdminNav";
import { getAuditOrganizationJobs } from "../../services/organizationService";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// PHASE 5 — JOB ANALYSIS (organization-wide).
//
// READ-ONLY AUDIT. Answers "what jobs has this organization run, and how did
// each go?". It exposes NO edit, delete, close, invite, select, re-run or
// assessment control, for active OR closed jobs. "View details" opens the
// EXISTING read-only OverviewJobModal, which reuses the existing candidate table
// and the existing verification-report / candidate-analysis views.
//
// Counts are the persisted JobCandidateReference / JobAssessmentAttempt /
// JobCandidateAnalysis counts. "Hired" is deliberately absent: no persisted
// hiring state exists, and it is never derived from a score.
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 10;

const JobAnalysisPage = () => {
  const [jobs, setJobs] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("ALL");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openJobId, setOpenJobId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAuditOrganizationJobs({
      page,
      limit: PAGE_LIMIT,
      ...(status ? { status } : {}),
      ...(range !== "ALL" ? { range } : {}),
    })
      .then((response) => {
        if (cancelled) return;
        setJobs(response.data?.jobs ?? []);
        setPagination(response.data?.pagination ?? null);
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(extractApiErrorMessage(caught, "Could not load jobs."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, range, page]);
return (
    <DashboardShell
      roleLabel="Organization"
      title="Job Analysis"
      description="Read-only organization-wide job analytics. Active jobs stay untouched; closed jobs remain auditable."
      navItems={ORG_ADMIN_NAV_ITEMS}
      statCards={[]}
    >
      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
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
            {ORG_JOB_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="job-range" className="text-xs font-medium text-slate-600">
            Period
          </label>
          <select
            id="job-range"
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
      </div>

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4" /> Loading jobs…
        </div>
      ) : jobs.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No jobs match this filter.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {jobs.map((job) => (
            <div key={job.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-base font-semibold text-slate-900">
                    {job.title}
                  </p>
                  <p className="text-xs text-slate-500">{job.id}</p>
                </div>
                <JobStatusBadge status={job.status} />
              </div>

              <p className="mt-2 text-xs text-slate-600">
                Recruiter: {job.recruiter.fullName} · Created: {formatOrgDate(job.createdAt)}
                {job.closedAt ? ` · Closed: ${formatOrgDate(job.closedAt)}` : ""}
              </p>

              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-slate-500">Candidates</dt>
                  <dd className="text-lg font-semibold text-slate-900">{job.counts.candidates}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Assessments</dt>
                  <dd className="text-lg font-semibold text-slate-900">{job.counts.attempts}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Analyzed</dt>
                  <dd className="text-lg font-semibold text-slate-900">{job.counts.analyses}</dd>
                </div>
                <div>
                  {/* No persisted hiring state — never derived from a score. */}
                  <dt className="text-xs text-slate-500">Hired</dt>
                  <dd className="text-lg font-semibold text-slate-400">
                    {job.counts.hired ?? "—"}
                  </dd>
                </div>
              </dl>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => setOpenJobId(job.id)}
              >
                View details
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

      {/* The EXISTING read-only job card, reused unchanged. */}
      {openJobId && <OverviewJobModal jobId={openJobId} onClose={() => setOpenJobId(null)} />}
    </DashboardShell>
  );
};

export default JobAnalysisPage;