import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { getCandidateAnalysis, getCandidateResumeBlob } from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";

const STATUS_TONE = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-800",
  PROCESSING: "border-sky-200 bg-sky-50 text-sky-800",
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-800",
  FAILED: "border-rose-200 bg-rose-50 text-rose-800",
};

const STATUS_LABEL = {
  PENDING: "Analysis queued...",
  PROCESSING: "Analysis in progress...",
  COMPLETED: "Analysis ready",
  FAILED: "Analysis failed.",
};

const Section = ({ title, children, className = "" }) => (
  <section className={`rounded-xl border border-slate-200 bg-slate-50/60 p-4 ${className}`}>
    <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
    <div className="mt-2 text-sm leading-6 text-slate-700">{children}</div>
  </section>
);

const EmptyList = ({ children = "None identified" }) => (
  <p className="text-sm text-slate-500">{children}</p>
);

const StringList = ({ items }) =>
  Array.isArray(items) && items.length > 0 ? (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  ) : (
    <EmptyList />
  );

const EvidenceSection = ({ title, evidence, url }) => (
  <Section title={title}>
    <p className="font-medium">{evidence?.status ?? "UNAVAILABLE"}</p>
    {evidence?.summary && <p className="mt-1">{evidence.summary}</p>}
    {evidence?.status === "NOT_PROVIDED" && <EmptyList>Not provided</EmptyList>}
    {evidence?.status === "UNAVAILABLE" && (
      <p className="mt-1">A reference exists, but no analyzed text was supplied.</p>
    )}
    {Array.isArray(evidence?.details) && evidence.details.length > 0 && (
      <StringList items={evidence.details} />
    )}
    {url && <p className="mt-2 break-all text-xs text-slate-500">Reference: {url}</p>}
  </Section>
);

const ResultSections = ({ result }) => {
  if (!result) return null;
  const performance = result.assessmentPerformance ?? {};
  return (
    <div className="space-y-4">
      <Section title="Job Fit Summary">{result.jobFitSummary}</Section>
      <Section title="Assessment Performance">
        <p>
          Status: <span className="font-medium">{performance.status}</span>
        </p>
        {performance.score !== null && performance.score !== undefined && (
          <p>
            Assessment score: {performance.score} / {performance.maxScore ?? "—"}
            {performance.scorePercentage !== null &&
              performance.scorePercentage !== undefined
              ? ` (${Number(performance.scorePercentage).toFixed(2)}%)`
              : ""}
          </p>
        )}
        <p>Unanswered: {performance.unanswered ?? 0}</p>
        {performance.summary && <p className="mt-1">{performance.summary}</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><p className="font-medium">Strengths</p><StringList items={performance.strengths} /></div>
          <div><p className="font-medium">Gaps</p><StringList items={performance.gaps} /></div>
        </div>
      </Section>
      <Section title="Skill Alignment">
        {result.skillAlignment?.length ? (
          <div className="space-y-3">
            {result.skillAlignment.map((item, index) => (
              <div key={`${item.skill}-${index}`} className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="font-medium">{item.skill} — {item.status}</p>
                <p>{item.rationale}</p>
                {item.evidence?.length > 0 && <StringList items={item.evidence} />}
              </div>
            ))}
          </div>
        ) : (
          <EmptyList />
        )}
      </Section>
      <div className="grid gap-4 lg:grid-cols-3">
        <EvidenceSection title="Resume Evidence" evidence={result.resumeEvidence} />
        <EvidenceSection title="LinkedIn Evidence" evidence={result.linkedinEvidence} />
        <EvidenceSection title="GitHub Evidence" evidence={result.githubEvidence} />
      </div>
      <Section title="Preferred Role Alignment">
        <p className="font-medium">{result.preferredRoleAlignment?.status}</p>
        {result.preferredRoleAlignment?.summary && <p>{result.preferredRoleAlignment.summary}</p>}
        {result.preferredRoleAlignment?.rationale && <p>{result.preferredRoleAlignment.rationale}</p>}
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Strengths"><StringList items={result.strengths} /></Section>
        <Section title="Skill Gaps"><StringList items={result.skillGaps} /></Section>
        <Section title="Missing Requirements"><StringList items={result.missingRequirements} /></Section>
        <Section title="Conflicts"><StringList items={result.conflicts} /></Section>
        <Section title="Concerns"><StringList items={result.concerns} /></Section>
        <Section title="Final Recruiter Review">{result.finalRecruiterReview}</Section>
      </div>
    </div>
  );
};

const CandidateAnalysisPanel = forwardRef(function CandidateAnalysisPanel(
  { jobId, candidate, onClose },
  ref
) {
  const [data, setData] = useState(null);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [resumeUrl, setResumeUrl] = useState(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeError, setResumeError] = useState(null);

  const load = useCallback(async ({ background = false, version = selectedVersion } = {}) => {
    if (!candidate?.referenceId) return null;
    if (background) setRefreshing(true);
    try {
      const response = await getCandidateAnalysis(jobId, candidate.referenceId, version);
      setData((current) =>
        version == null && selectedVersion != null && response?.data
          ? { ...response.data, selected: current?.selected ?? null }
          : response?.data ?? null
      );
      setError(null);
      return response?.data ?? null;
    } catch (caught) {
      setError(extractApiErrorMessage(caught, "Candidate analysis could not be loaded."));
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [candidate, jobId, selectedVersion]);

  useImperativeHandle(ref, () => ({
    reconcileLatest: () => load({ background: true, version: null }),
  }), [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load({ version: null });
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [candidate, load]);

  const handleVersionChange = async (event) => {
    const version = event.target.value === "latest" ? null : Number(event.target.value);
    setSelectedVersion(version);
    await load({ version });
  };

  const handleViewResume = async () => {
    if (!candidate?.referenceId || resumeLoading) return;
    setResumeLoading(true);
    setResumeError(null);
    try {
      const blob = await getCandidateResumeBlob(jobId, candidate.referenceId);
      if (resumeUrl) URL.revokeObjectURL(resumeUrl);
      setResumeUrl(URL.createObjectURL(blob));
    } catch (caught) {
      setResumeError(extractApiErrorMessage(caught, "The private resume could not be opened."));
    } finally {
      setResumeLoading(false);
    }
  };

  useEffect(() => () => {
    if (resumeUrl) URL.revokeObjectURL(resumeUrl);
  }, [resumeUrl]);

  const displayed = useMemo(() => {
    if (selectedVersion != null) return data?.selected ?? null;
    if (data?.latest?.status === "COMPLETED") return data.latest;
    return data?.latestCompleted ?? data?.latest ?? null;
  }, [data, selectedVersion]);

  if (!candidate?.referenceId) {
    return <Alert variant="error">This candidate has no server-resolved reference identity.</Alert>;
  }

  const latest = data?.latest ?? null;

  return (
    <section className="mt-5 rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold text-slate-900">Candidate Analysis</h3>
          <p className="mt-1 text-sm text-slate-600">
            Evidence-based recruiter decision support. It is not an overall
            score or automatic hiring decision. Analysis is queued by the
            platform the moment this candidate's assessment closes - recruiters
            never start it by hand.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {candidate.hasResume && (
            <Button type="button" size="sm" variant="outline" onClick={handleViewResume} disabled={resumeLoading}>
              {resumeLoading && <Spinner className="h-4 w-4" />} View Resume
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => load({ background: true })} disabled={refreshing}>
            {refreshing && <Spinner className="h-4 w-4" />} Refresh
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>

      {error && <div className="mt-4"><Alert variant="error">{error}</Alert></div>}
      {resumeError && <div className="mt-4"><Alert variant="error">{resumeError}</Alert></div>}

      {loading && !data && (
        <div className="mt-5 flex items-center gap-2 text-sm text-slate-600">
          <Spinner className="h-5 w-5" /> Loading candidate analysis…
        </div>
      )}

      {data && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_TONE[latest?.status] ?? "border-slate-200 bg-slate-50 text-slate-700"}`}>
              {STATUS_LABEL[latest?.status] ?? "No candidate analysis yet."}
            </span>
            {latest && <span className="text-xs text-slate-500">Latest version: v{latest.analysisVersion}</span>}
            {latest && latest.status !== "COMPLETED" && data.latestCompleted && (
              <span className="text-xs text-amber-700">
                New analysis in progress. The latest completed result remains available.
              </span>
            )}
            {data.versions?.length > 1 && (
              <label className="ml-auto text-xs font-medium text-slate-600">
                Version
                <select
                  className="ml-2 rounded-lg border border-slate-300 bg-white px-2 py-1.5"
                  value={selectedVersion ?? "latest"}
                  onChange={handleVersionChange}
                >
                  <option value="latest">Latest</option>
                  {data.versions.map((version) => (
                    <option key={version.analysisId} value={version.analysisVersion}>
                      v{version.analysisVersion} — {version.status}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {resumeUrl && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-slate-600">Authenticated private resume preview</p>
              <iframe
                title="Candidate resume"
                src={resumeUrl}
                className="h-[36rem] w-full rounded-xl border border-slate-200"
              />
            </div>
          )}


          {displayed?.status === "COMPLETED" && displayed.result ? (
            <div className="mt-5"><ResultSections result={displayed.result} /></div>
          ) : displayed?.status === "FAILED" ? (
            <div className="mt-4">
              <Alert variant="error">
                Candidate analysis failed for this attempt. Earlier completed
                versions, if any, remain available above.
              </Alert>
            </div>
          ) : ["PENDING", "PROCESSING"].includes(displayed?.status) ? (
            <p className="mt-4 text-sm text-slate-600">
              Status updates arrive through the authorized recruiter realtime stream.
            </p>
          ) : (
            <p className="mt-4 text-sm text-slate-600">
              No candidate analysis yet. Analysis starts automatically as soon
              as this candidate's assessment closes, so this panel fills itself
              in - no action is needed here.
            </p>
          )}
        </>
      )}
    </section>
  );
});

CandidateAnalysisPanel.displayName = "CandidateAnalysisPanel";

export default CandidateAnalysisPanel;

