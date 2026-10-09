import { useEffect, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import JobStatusBadge from "./JobStatusBadge";
import OverviewCandidateTable from "./OverviewCandidateTable";
import { getOverviewJob } from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// The read-only job-details CARD.
//
// READ-ONLY BY CONSTRUCTION: there is no form, no input bound to a mutation, no
// save/cancel/submit affordance and no onUpdate handler anywhere in this tree.
// Opening, reading and closing it issue GET requests only.
//
// It is a self-contained card (no route change) using the same modal conventions
// as the existing CandidateVerificationReportModal: backdrop click closes, Escape
// closes, role="dialog" + aria-modal, and the body scrolls internally. The
// header/ID row is rendered in a reserved slot so opening it never shifts layout.
// ---------------------------------------------------------------------------

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

const Field = ({ label, children }) => (
  <div>
    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
    <dd className="mt-0.5 text-sm text-slate-800">{children}</dd>
  </div>
);

const ChipList = ({ items, empty }) => {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return <span className="text-sm text-slate-400">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((item, index) => (
        <span
          key={`${item.name ?? item}-${index}`}
          className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
        >
          {item.name}
          {item.weight !== null && item.weight !== undefined && (
            <span className="ml-1 text-slate-500">({item.weight})</span>
          )}
        </span>
      ))}
    </div>
  );
};

const OverviewJobModal = ({ jobId, onClose }) => {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const response = await getOverviewJob(jobId);
        if (cancelled) return;
        setPayload(response?.data ?? null);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(extractApiErrorMessage(caught, "The job details could not be loaded."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const job = payload?.job ?? null;
  const counts = payload?.counts ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Job details"
        className="my-4 max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Job details
            </h3>
            <p className="mt-1 truncate text-lg font-bold text-slate-900">
              {job?.title ?? "Loading…"}
            </p>
            {/* The Job ID is always rendered in this reserved slot, so it is
                readable while loading and the row height never changes. */}
            <p className="break-all font-mono text-xs text-slate-500">{jobId}</p>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {loading && (
          <div className="mt-6 flex items-center gap-2 text-sm text-slate-600">
            <Spinner className="h-5 w-5" /> Loading job details…
          </div>
        )}

        {!loading && error && (
          <div className="mt-5">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        {!loading && !error && job && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <JobStatusBadge status={job.status} />
              {payload.isClosed && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  Closed — historical, read-only
                </span>
              )}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Field label="Posted">{formatDate(job.createdAt)}</Field>
              <Field label="Started">{formatDate(job.startedAt)}</Field>
              <Field label="Expires">{formatDate(job.analysisEndsAt)}</Field>
              <Field label="Closed">{formatDate(job.closedAt)}</Field>
              <Field label="Candidates">{counts?.candidates ?? 0}</Field>
              {/* The recruiter-configured preferred-candidate TARGET, reported
                  exactly as set on the job: a number the recruiter chose, never a
                  computed ranking and never a score. */}
              <Field label="Preferred target">
                {job.preferredCandidateTarget ?? <span className="text-slate-400">—</span>}
              </Field>
              {/* Reported as unavailable rather than 0: no per-candidate preferred
                  or selected state is persisted anywhere in the platform. */}
              <Field label="Preferred (actual)">
                <span className="text-slate-400" title="Not tracked by the platform yet">
                  —
                </span>
              </Field>
              <Field label="Selected">
                <span className="text-slate-400" title="Not tracked by the platform yet">
                  —
                </span>
              </Field>
            </dl>

            <div className="mt-5 space-y-4">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Description
                </h4>
                <p className="mt-1 whitespace-pre-line text-sm leading-6 text-slate-700">
                  {job.description || <span className="text-slate-400">No description.</span>}
                </p>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Requirements
                </h4>
                <div className="mt-1">
                  <ChipList items={job.requirements} empty="No requirements recorded." />
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Required skills (with weights)
                </h4>
                <div className="mt-1">
                  <ChipList items={job.skills} empty="No skills recorded." />
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Tools &amp; software
                </h4>
                <div className="mt-1">
                  <ChipList items={job.tools} empty="No tools recorded." />
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Assessment
                </h4>
                {job.assessment ? (
                  <p className="mt-1 text-sm text-slate-700">
                    {job.assessment.title} — {job.assessment.status},{" "}
                    {job.assessment.questionCount} question
                    {job.assessment.questionCount === 1 ? "" : "s"}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-slate-400">No assessment yet.</p>
                )}
              </div>
            </div>

            {/* PHASE 3 — the backend is authoritative: it decides whether candidate
                data may be shown for THIS job and returns that decision as
                `candidateLevelAccess`. When it is denied the candidate request is
                never made, so no candidate data is fetched, rendered, or left in
                component state from an earlier open of a different job. Job-level
                information above stays complete either way. */}
            {payload.candidateLevelAccess?.allowed ? (
              <OverviewCandidateTable jobId={job.id} isClosed={payload.isClosed} />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5">
                <p className="text-sm font-semibold text-slate-700">
                  Candidate reporting is not available yet
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {payload.candidateLevelAccess?.reason ??
                    "Candidate-level reporting becomes available once this job is closed."}
                  {" The job-level information above is still complete."}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default OverviewJobModal;