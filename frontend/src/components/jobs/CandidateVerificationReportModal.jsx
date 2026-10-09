import { useEffect, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { getJobCandidateVerificationReport } from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// Verification report — SECONDARY UI (modal), opened only on demand
// ---------------------------------------------------------------------------
// The candidate table stays compact: the report is fetched and rendered here
// only after the recruiter clicks "View Report" on an IN SYSTEM row, never
// inside a table row and never as permanently expanded row content.
//
// Everything shown comes from the authorized
// GET /job/:jobId/candidates/:referenceId/verification-report read: the stored
// platform verification score, the verified-skill count and the per-skill
// stored values. This is the candidate's PRE-EXISTING platform verification —
// it is not the assessment score (which lives only on the persisted attempt)
// and it is never recalculated in the browser. A NOT_IN_SYSTEM candidate has
// no report, so its row never offers the action in the first place.

// The status column reuses the SAME stored verification statuses the candidate
// dashboard already renders. Only the presentation is defined here; no status
// is computed or reinterpreted.
const VERIFICATION_STATUS_TONE = {
  VERIFIED: "bg-emerald-50 text-emerald-800 border-emerald-200",
  HIGHLY_VERIFIED: "bg-emerald-50 text-emerald-800 border-emerald-200",
  PARTIALLY_VERIFIED: "bg-amber-50 text-amber-800 border-amber-200",
  INSUFFICIENT_EVIDENCE: "bg-rose-50 text-rose-800 border-rose-200",
  PENDING: "bg-slate-100 text-slate-700 border-slate-200",
  NOT_VERIFIED: "bg-slate-100 text-slate-700 border-slate-200",
  REJECTED: "bg-rose-50 text-rose-800 border-rose-200",
};

const StatusBadge = ({ status }) => (
  <span
    className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
      VERIFICATION_STATUS_TONE[status] ?? "bg-slate-100 text-slate-700 border-slate-200"
    }`}
  >
    {status ?? "—"}
  </span>
);

const formatDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
};

const CandidateVerificationReportModal = ({ jobId, candidate, onClose }) => {
  const referenceId = candidate.referenceId;
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const response = await getJobCandidateVerificationReport(jobId, referenceId);
        if (cancelled) return;
        setReport(response?.data ?? null);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(
          extractApiErrorMessage(caught, "The verification report could not be loaded.")
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, referenceId]);

  // Escape closes the modal — the same secondary-UI behaviour as the close
  // button and the backdrop click below.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const score = report?.existingVerifiedSkillScore ?? null;
  const skillCount = report?.existingVerifiedSkillCount ?? 0;
  const skills = report?.verifiedSkills ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Verification report"
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Verification report
            </h3>
            <p className="mt-1 truncate text-lg font-bold text-slate-900">
              {report?.candidateName ?? candidate.name ?? "Candidate"}
            </p>
            <p className="break-all text-xs text-slate-500">{candidate.email ?? "—"}</p>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>


        {loading && (
          <div className="mt-6 flex items-center gap-2 text-sm text-slate-600">
            <Spinner className="h-5 w-5" /> Loading verification report…
          </div>
        )}

        {!loading && error && (
          <div className="mt-5">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="mt-5 flex items-baseline gap-3 border-b border-slate-100 pb-4">
              {score === null ? (
                <p className="text-sm text-slate-500">
                  No completed skill verification on the platform yet.
                </p>
              ) : (
                <>
                  <span className="font-display text-3xl font-bold tabular-nums text-slate-900">
                    {score}%
                  </span>
                  <span className="text-sm text-slate-500">
                    {skillCount === 1 ? "1 verified skill" : `${skillCount} verified skills`}
                  </span>
                </>
              )}
            </div>

            {skills.length > 0 ? (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                      <th scope="col" className="px-2 py-2 font-semibold">Skill</th>
                      <th scope="col" className="px-2 py-2 text-right font-semibold">Score</th>
                      <th scope="col" className="px-2 py-2 font-semibold">Status</th>
                      <th scope="col" className="px-2 py-2 text-right font-semibold">Confidence</th>
                      <th scope="col" className="px-2 py-2 font-semibold">Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skills.map((skill, index) => (
                      <tr
                        key={`${skill.skillName ?? "skill"}-${index}`}
                        className="border-b border-slate-100"
                      >
                        <td className="px-2 py-2 font-medium text-slate-800">
                          {skill.skillName ?? "—"}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold tabular-nums text-slate-900">
                          {skill.score}%
                        </td>
                        <td className="px-2 py-2">
                          <StatusBadge status={skill.verificationStatus} />
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-600">
                          {skill.confidenceScore === null ||
                          skill.confidenceScore === undefined
                            ? "—"
                            : `${skill.confidenceScore}%`}
                        </td>
                        <td className="px-2 py-2 text-slate-600">
                          {formatDate(skill.completedAt) ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* The stored narrative that already belongs to the report. It is
                    the candidate's own persisted verification output — not a new
                    analysis, and never the assessment score. */}
                {skills.some(
                  (skill) =>
                    skill.aiSummary ||
                    (skill.strengths ?? []).length > 0 ||
                    (skill.areasToImprove ?? []).length > 0
                ) && (
                  <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
                    {skills.map((skill, index) =>
                      skill.aiSummary ||
                      (skill.strengths ?? []).length > 0 ||
                      (skill.areasToImprove ?? []).length > 0 ? (
                        <div key={`detail-${index}`}>
                          <p className="text-xs font-semibold text-slate-800">
                            {skill.skillName ?? "Skill"}
                          </p>
                          {skill.aiSummary && (
                            <p className="mt-1 text-xs text-slate-600">
                              {skill.aiSummary}
                            </p>
                          )}
                          {(skill.strengths ?? []).length > 0 && (
                            <p className="mt-1 text-xs text-slate-600">
                              <span className="font-semibold">Strengths: </span>
                              {skill.strengths.join(", ")}
                            </p>
                          )}
                          {(skill.areasToImprove ?? []).length > 0 && (
                            <p className="mt-1 text-xs text-slate-600">
                              <span className="font-semibold">Areas to improve: </span>
                              {skill.areasToImprove.join(", ")}
                            </p>
                          )}
                        </div>
                      ) : null
                    )}
                  </div>
                )}
              </div>
            ) : (
              score === null && (
                <p className="mt-4 text-xs text-slate-500">
                  This candidate has not completed a skill verification on the platform.
                </p>
              )
            )}

            <p className="mt-4 text-xs text-slate-500">
              Stored platform verification results, shown for information only — this is not
              the assessment score. The assessment result lives in the Score column of the
              candidate table.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default CandidateVerificationReportModal;
