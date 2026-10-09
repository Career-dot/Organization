import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import CandidateVerificationReportModal from "./CandidateVerificationReportModal";
import CandidateAnalysisPanel from "./CandidateAnalysisPanel";
import { listOverviewCandidates } from "../../services/jobService";
import { useJobCandidateRealtime } from "../../hooks/useJobCandidateRealtime";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// Read-only candidate table for the recruiter Jobs overview.
//
// SCALABILITY: one paginated, server-searched request per page. The response is a
// lightweight projection - the candidate-analysis `result` JSON is NOT in it, so
// opening a job with many candidates never downloads every report. Each report is
// fetched only when the recruiter opens it.
//
// THE THREE VALUES ARE SHOWN IN THREE DISTINCT COLUMNS AND ARE NEVER COMBINED:
//   * "Verified skill" - the EXISTING platform verification headline (stored,
//     informational, never recomputed here)
//   * "Assessment"     - the authoritative persisted attempt score
//   * "Analysis"       - the job candidate-analysis lifecycle status
// There is deliberately no combined/overall/fit column.
//
// REALTIME: reuses the existing SSE hook. An event is a NOTIFICATION only: it
// schedules an authoritative re-read of this candidate's page. The event payload
// is never rendered, and one candidate's analysis never reloads the job list.
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 25;

const ASSESSMENT_LABEL = {
  NOT_STARTED: "Not started",
  STARTED: "Started",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  TIMED_UP: "Timed up",
  CHEATED: "Terminated",
};

const ANALYSIS_LABEL = {
  PENDING: "Queued",
  PROCESSING: "Running",
  COMPLETED: "Ready",
  FAILED: "Failed",
};

const cellClass = "px-3 py-2.5 align-middle text-sm text-slate-700";
const headerClass =
  "px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";

// A value that was never persisted renders as an explicit dash, never as 0.
const Dash = ({ title }) => (
  <span className="text-slate-400" title={title}>
    —
  </span>
);

const CandidateRow = ({ candidate, onOpenVerification, onOpenAnalysis }) => {
  const name = candidate.candidateName || candidate.candidateEmail;
  const inSystem = candidate.systemStatus === "IN_SYSTEM";

  return (
    <tr className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/70">
      <td className={cellClass}>
        <p className="font-medium text-slate-900">{name}</p>
        <p className="break-all text-xs text-slate-500">{candidate.candidateEmail}</p>
        {candidate.preferredRole && (
          <p className="text-xs text-slate-500">{candidate.preferredRole}</p>
        )}
      </td>

      <td className={cellClass}>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            inSystem ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          {inSystem ? "In system" : "Not in system"}
        </span>
      </td>

      {/* (1) EXISTING PLATFORM VERIFIED SKILL SCORE - informational only. */}
      <td className={cellClass}>
        {candidate.existingVerifiedSkillScore == null ? (
          <Dash title="No stored platform verification report for this candidate" />
        ) : (
          <>
            <span className="font-medium text-slate-900">
              {candidate.existingVerifiedSkillScore}
            </span>
            <span className="text-xs text-slate-500">
              {" "}
              ({candidate.existingVerifiedSkillCount} verified skill
              {candidate.existingVerifiedSkillCount === 1 ? "" : "s"})
            </span>
          </>
        )}
      </td>

      {/* (2) ASSESSMENT STATUS + authoritative persisted score. */}
      <td className={cellClass}>
        {candidate.assessmentStatus ? (
          <>
            <p className="font-medium text-slate-900">
              {ASSESSMENT_LABEL[candidate.assessmentStatus] ?? candidate.assessmentStatus}
            </p>
            {candidate.assessmentScore == null ? (
              <p className="text-xs text-slate-500">No score recorded</p>
            ) : (
              <p className="text-xs text-slate-500">
                Score {candidate.assessmentScore} / {candidate.assessmentMaxScore ?? "—"}
                {candidate.assessmentScorePercentage != null
                  ? ` (${Number(candidate.assessmentScorePercentage).toFixed(2)}%)`
                  : ""}
              </p>
            )}
          </>
        ) : (
          <Dash title="This candidate has no assessment attempt" />
        )}
      </td>

      {/* (3) JOB CANDIDATE ANALYSIS lifecycle. */}
      <td className={cellClass}>
        {candidate.analysisStatus ? (
          <span className="font-medium text-slate-900">
            {ANALYSIS_LABEL[candidate.analysisStatus] ?? candidate.analysisStatus}
            {candidate.analysisVersion ? (
              <span className="text-xs font-normal text-slate-500">
                {" "}
                v{candidate.analysisVersion}
              </span>
            ) : null}
          </span>
        ) : (
          <Dash title="No candidate analysis has been produced for this candidate" />
        )}
      </td>

      <td className={cellClass}>
        <div className="flex flex-wrap gap-2">
          {/* Report A - EXISTING PLATFORM VERIFICATION. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!inSystem}
            title={
              inSystem
                ? "Open the existing platform verified-skill report"
                : "This candidate has no platform account, so no verification report exists"
            }
            onClick={() => onOpenVerification(candidate)}
          >
            Verified skill report
          </Button>
          {/* Report B - JOB CANDIDATE ANALYSIS. Separate button, separate fetch. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            title="Open the candidate analysis for this job"
            onClick={() => onOpenAnalysis(candidate)}
          >
            Candidate analysis
          </Button>
        </div>
      </td>
    </tr>
  );
};

const COLUMNS = [
  "Candidate",
  "System",
  "Verified skill",
  "Assessment",
  "Analysis",
  "Reports",
];

const OverviewCandidateTable = ({ jobId, isClosed }) => {
  const [candidates, setCandidates] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [verificationCandidate, setVerificationCandidate] = useState(null);
  const [analysisCandidate, setAnalysisCandidate] = useState(null);

  // Monotonic request sequence: a slow response can never overwrite a newer one.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (targetPage, term) => {
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      setLoading(true);
      try {
        const response = await listOverviewCandidates(jobId, {
          page: targetPage,
          limit: PAGE_LIMIT,
          search: term,
        });
        if (seq !== requestSeq.current) return;
        setCandidates(response?.data?.candidates ?? []);
        setPagination(response?.data?.pagination ?? null);
        setError(null);
      } catch (caught) {
        if (seq !== requestSeq.current) return;
        setCandidates([]);
        setError(extractApiErrorMessage(caught, "Unable to load this job's candidates."));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [jobId]
  );

  // Debounce so typing does not issue one request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load(page, search);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load, page, search]);

  // EXISTING SSE hook, unchanged. Events are NOTIFICATIONS only: the handler
  // re-reads the authoritative candidate page through the API. The event's status
  // is never written into state, so duplicate / out-of-order / stale events cannot
  // corrupt a row, and one candidate's analysis never touches another candidate.
  const reconcileCandidate = useCallback(
    (event) => {
      if (!event || event.jobId !== jobId) return;
      load(page, search);
    },
    [jobId, page, search, load]
  );

  useJobCandidateRealtime({
    jobId,
    enabled: Boolean(jobId),
    onReconcile: () => load(page, search),
    onCandidateAnalysisUpdate: reconcileCandidate,
  });

  const tableState = useMemo(() => {
    if (loading && candidates.length === 0) return "loading";
    if (candidates.length === 0) return search ? "no-results" : "empty";
    return "ready";
  }, [loading, candidates.length, search]);

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-display text-base font-bold text-slate-900">Candidates</h4>
        <input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search by name or email"
          aria-label="Search candidates"
          className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:w-64"
        />
      </div>

      {isClosed && (
        <p className="mt-2 text-xs text-slate-500">
          This job is closed. Everything below is historical read-only data.
        </p>
      )}

      {error && (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[820px] text-left">
          <thead>
            <tr className="border-b border-slate-200">
              {COLUMNS.map((label) => (
                <th key={label} className={headerClass}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableState === "loading" && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-12 text-center">
                  <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
                    <Spinner className="h-4 w-4" /> Loading candidates…
                  </div>
                </td>
              </tr>
            )}

            {(tableState === "empty" || tableState === "no-results") && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-12 text-center">
                  <p className="text-sm text-slate-500">
                    {tableState === "no-results"
                      ? "No candidates match your search."
                      : "This job has no candidates yet."}
                  </p>
                </td>
              </tr>
            )}

            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.referenceId}
                candidate={candidate}
                onOpenVerification={setVerificationCandidate}
                onOpenAnalysis={setAnalysisCandidate}
              />
            ))}
          </tbody>
        </table>
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} candidates)
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page >= pagination.totalPages || loading}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Report A - EXISTING PLATFORM VERIFIED SKILL REPORT (existing endpoint). */}
      {verificationCandidate && (
        <CandidateVerificationReportModal
          jobId={jobId}
          candidate={{
            referenceId: verificationCandidate.referenceId,
            name: verificationCandidate.candidateName,
            email: verificationCandidate.candidateEmail,
          }}
          onClose={() => setVerificationCandidate(null)}
        />
      )}

      {/* Report B - JOB CANDIDATE ANALYSIS REPORT (existing endpoint + panel). */}
      {analysisCandidate && (
        <CandidateAnalysisPanel
          jobId={jobId}
          candidate={{ referenceId: analysisCandidate.referenceId }}
          onClose={() => setAnalysisCandidate(null)}
        />
      )}
    </section>
  );
};

export default OverviewCandidateTable;