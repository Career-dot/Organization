import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import Spinner from "../../components/ui/Spinner";
import JobStatusBadge from "../../components/jobs/JobStatusBadge";
import DraftJobForm from "../../components/jobs/DraftJobForm";
import AiJobAnalysisCard from "../../components/jobs/AiJobAnalysisCard";
import AssessmentCard from "../../components/jobs/AssessmentCard";
import CandidateWorkflowList from "../../components/jobs/CandidateWorkflowList";
import { RECRUITER_NAV_ITEMS } from "../../constants/recruiterNav";
import { JOB_CLOSED_REASON_LABELS, JOB_STATUS } from "../../constants/jobForm";
import {
  AI_JOB_OPERATION,
  AI_JOB_STATUS,
} from "../../constants/aiWorkflow";
import {
  closeJob,
  deleteAssessment,
  continueClarifications,
  finalizeAssessment,
  getJob,
  startJob,
  updateAssessment,
  updateClarificationQuestions,
  updateJobDraft,
  activateAssessment,
} from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";
import { buildEditPayload, jobToFormState } from "../../utils/jobFormState";
import useJobContext from "../../hooks/useJobContext";

const cardClasses = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7";

const formatDate = (value) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;

const RecruiterJobDetail = () => {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const jobContext = useJobContext();

  const [job, setJob] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);
  // Flash message handed over from the Create page navigation is seeded
  // directly as the initial value � no setState-in-effect on the happy path.
  const [notice, setNotice] = useState(
    location.state?.flash ? { variant: "success", message: location.state.flash } : null
  );
  const [confirmAction, setConfirmAction] = useState(null); // "start" | "close" | ...
  // AI workflow actions (clarification saves, Continue, assessment CRUD). Free
  // actions — quota is only ever consumed by Start.
  const [workflowBusy, setWorkflowBusy] = useState(false);

  // Fetch + map the job. Deliberately performs NO synchronous setState so it
  // can be awaited from the mount effect (react-hooks/set-state-in-effect)
  // and reused as a fire-and-forget resync after a failed Start.
  const fetchJob = async () => {
    try {
      const response = await getJob(jobId);
      setJob(response.data);
      setForm(jobToFormState(response.data));
      setLoadError(null);
    } catch (error) {
      setLoadError(extractApiErrorMessage(error, "Unable to load this job."));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchJob();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Clear the flash state from history so a refresh does not replay it.
  useEffect(() => {
    if (location.state?.flash) {
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSaveDraft = async () => {
    setNotice(null);
    if (form.title.trim().length < 3) {
      setNotice({ variant: "error", message: "Job title must be at least 3 characters" });
      return;
    }
    setSaving(true);
    try {
      const response = await updateJobDraft(jobId, buildEditPayload(form));
      setJob(response.data);
      setForm(jobToFormState(response.data));
      setNotice({ variant: "success", message: "Draft saved successfully." });
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  // Current backend Start endpoint: activates the job and consumes one quota
  // slot. The AI pipeline is intentionally NOT part of this phase — no fake
  // AI processing states are shown.
  const handleStart = async () => {
    if (acting) return;
    setActing(true);
    setNotice(null);
    try {
      // Persist the visible form first, so the readiness checklist the
      // recruiter reviewed is exactly what the backend validates on Start.
      await updateJobDraft(jobId, buildEditPayload(form));
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
      setActing(false);
      setConfirmAction(null);
      return;
    }
    try {
      const response = await startJob(jobId);
      setJob(response.data);
      setForm(jobToFormState(response.data));
      setNotice({
        variant: "success",
        message: "Job started. One job slot was consumed — closing it will not return the slot.",
      });
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
      // The save may have landed before Start failed — resync with the server.
      fetchJob();
    } finally {
      setActing(false);
      setConfirmAction(null);
    }
  };

  const handleClose = async () => {
    if (acting) return;
    setActing(true);
    setNotice(null);
    try {
      const response = await closeJob(jobId);
      setJob(response.data);
      setNotice({ variant: "success", message: "Job closed. Closed jobs cannot be reopened." });
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
    } finally {
      setActing(false);
      setConfirmAction(null);
    }
  };

  // --- AI workflow (analysis → clarifications → assessment → link) -----------
  // The AiJob rows are the single source of truth for every state shown.
  const analysisAiJob =
    job?.aiJobs?.find((row) => row.operation === AI_JOB_OPERATION.JOB_ANALYSIS) ?? null;
  const assessmentAiJob =
    job?.aiJobs?.find((row) => row.operation === AI_JOB_OPERATION.ASSESSMENT_GENERATION) ?? null;
  const clarificationsApproved = Boolean(job?.clarificationsApprovedAt);

  // Live status while real AI work is in flight. No fake progress states: the
  // poll simply re-reads the server state (the same GET the page loads with)
  // until the AiJob rows reach a terminal status. Single-flight + cleanup.
  const hasPendingAiWork = job?.status !== JOB_STATUS.DRAFT &&
    [analysisAiJob, assessmentAiJob].some(
      (row) => row?.status === AI_JOB_STATUS.PENDING || row?.status === AI_JOB_STATUS.PROCESSING
    );

  useEffect(() => {
    if (!hasPendingAiWork) {
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const response = await getJob(jobId);
        if (!cancelled) {
          setJob(response.data);
          setForm(jobToFormState(response.data));
        }
      } catch {
        // Keep the last good state; the next tick retries.
      } finally {
        inFlight = false;
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasPendingAiWork, jobId]);

  const handleSaveClarificationQuestions = async (questions) => {
    setWorkflowBusy(true);
    try {
      await updateClarificationQuestions(jobId, questions);
      const response = await getJob(jobId);
      setJob(response.data);
      setNotice({ variant: "success", message: "Clarification questions updated." });
    } catch (error) {
      // Surfaced inline by the section card.
      throw new Error(extractApiErrorMessage(error, "The clarification questions could not be saved."), { cause: error });
    } finally {
      setWorkflowBusy(false);
    }
  };

  const handleContinueClarifications = async () => {
    if (workflowBusy) return;
    setWorkflowBusy(true);
    setNotice(null);
    try {
      const response = await continueClarifications(jobId);
      const detail = await getJob(jobId);
      setJob(detail.data);
      setForm(jobToFormState(detail.data));
      setNotice({
        variant: "success",
        message: `Clarifications approved at ${new Date(response.clarificationsApprovedAt).toLocaleTimeString()} — the AI assessment is being generated.`,
      });
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
    } finally {
      setWorkflowBusy(false);
    }
  };

  const handleUpdateAssessment = async (payload) => {
    setWorkflowBusy(true);
    try {
      await updateAssessment(jobId, payload);
      const detail = await getJob(jobId);
      setJob(detail.data);
      setNotice({ variant: "success", message: "Assessment updated." });
    } catch (error) {
      throw new Error(extractApiErrorMessage(error, "The assessment could not be updated."), { cause: error });
    } finally {
      setWorkflowBusy(false);
    }
  };

  const handleFinalizeAssessment = async () => {
    if (workflowBusy) return;
    setWorkflowBusy(true);
    setNotice(null);
    try {
      await finalizeAssessment(jobId);
      const detail = await getJob(jobId);
      setJob(detail.data);
      setForm(jobToFormState(detail.data));
      setNotice({ variant: "success", message: "Assessment finalized — its link is ready below." });
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
    } finally {
      setWorkflowBusy(false);
      setConfirmAction(null);
    }
  };

  const handleDeleteAssessment = async () => {
    if (workflowBusy) return;
    setWorkflowBusy(true);
    setNotice(null);
    try {
      await deleteAssessment(jobId);
      const detail = await getJob(jobId);
      setJob(detail.data);
      setNotice({ variant: "success", message: "Draft assessment deleted. The job and its candidate list were not affected." });
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
    } finally {
      setWorkflowBusy(false);
      setConfirmAction(null);
    }
  };

  const handleActivateAssessment = async () => {
    if (workflowBusy) return;
    setWorkflowBusy(true);
    setNotice(null);
    try {
      const response = await activateAssessment(jobId);
      const detail = await getJob(jobId);
      setJob(detail.data);
      setNotice({
        variant: "success",
        message: response?.activated
          ? "Assessment activated — invitations are now enabled below."
          : "Assessment is already active.",
      });
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
    } finally {
      setWorkflowBusy(false);
      setConfirmAction(null);
    }
  };

  // Invitation creation has no handler here on purpose: the ONLY invitation
  // entry point is the per-row Invite action in the candidate list below. There
  // is no email-textarea form on the assessment card, so there is nothing for
  // this page to submit.

  const isDraft = job?.status === JOB_STATUS.DRAFT;
  const isActive = job?.status === JOB_STATUS.ACTIVE;
  const isClosed = job?.status === JOB_STATUS.CLOSED;

  if (jobContext.kind === "error" || jobContext.kind === "unresolved") {
    return (
      <DashboardShell roleLabel="Recruiter" title="Job" navItems={RECRUITER_NAV_ITEMS}>
        <Alert variant="error">{jobContext.message}</Alert>
        <div className="mt-4">
          <Button as="link" to="/recruiter/jobs" variant="outline" size="sm">
            ← Back to jobs
          </Button>
        </div>
      </DashboardShell>
    );
  }

  if (loading) {
    return (
      <DashboardShell roleLabel="Recruiter" title="Job" navItems={RECRUITER_NAV_ITEMS}>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <Spinner className="h-5 w-5" /> Loading job…
        </div>
      </DashboardShell>
    );
  }

  if (loadError || !job || !form) {
    return (
      <DashboardShell roleLabel="Recruiter" title="Job" navItems={RECRUITER_NAV_ITEMS}>
        <Alert variant="error">{loadError ?? "Job not found."}</Alert>
        <div className="mt-4 flex gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              fetchJob();
            }}
          >
            Retry
          </Button>
          <Button as="link" to="/recruiter/jobs" variant="ghost" size="sm">
            ← Back to jobs
          </Button>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      roleLabel="Recruiter"
      title={job.title}
      description={
        isDraft ? "Draft — complete the details, then start the job when you are ready." : undefined
      }
      navItems={RECRUITER_NAV_ITEMS}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button as="link" to="/recruiter/jobs" variant="ghost" size="sm">
            ← Back to jobs
          </Button>
          <JobStatusBadge status={job.status} closedReason={job.closedReason} />
        </div>

        {notice && <Alert variant={notice.variant}>{notice.message}</Alert>}

        {isDraft ? (
          /* The ONE draft form (fields, Candidate Excel, readiness, Start) —
             identical to the one the Create page renders. */
          <DraftJobForm
            jobId={jobId}
            form={form}
            updateField={updateField}
            saving={saving}
            onSave={handleSaveDraft}
            notice={null}
            onStart={handleStart}
            starting={acting}
            candidateList={job.candidateList ?? null}
            onCandidateListChange={(list) =>
              setJob((prev) => (prev ? { ...prev, candidateList: list } : prev))
            }
          />
        ) : (
          <>
            <AiJobAnalysisCard
              aiJob={analysisAiJob}
              approved={clarificationsApproved}
              questions={job.clarificationQuestions ?? []}
              busy={workflowBusy}
              onSaveQuestions={handleSaveClarificationQuestions}
              onContinue={handleContinueClarifications}
            />
            {(clarificationsApproved || assessmentAiJob || job.assessment) && (
              <AssessmentCard
                assessment={job.assessment ?? null}
                generationAiJob={assessmentAiJob}
                busy={workflowBusy}
                onUpdate={handleUpdateAssessment}
                onFinalize={() => setConfirmAction("finalize-assessment")}
                onDeleteClick={() => setConfirmAction("delete-assessment")}
                onActivate={() => setConfirmAction("activate-assessment")}
              />
            )}
            {job.candidateList && (
              <CandidateWorkflowList
                jobId={jobId}
                candidateListFileId={job.candidateList.file?.id ?? null}
                analysisEnabled={isActive}
                title={isActive ? "Candidate analysis" : "Candidates"}
              />
            )}
            <ReadOnlyJobDetails
              job={job}
              isActive={isActive}
              isClosed={isClosed}
              onCloseClick={() => setConfirmAction("close")}
            />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmAction === "close"}
        title="Close this job?"
        description="The job becomes read-only for everyone and closed jobs cannot be reopened. Create a new job if you want to hire for the same position again."
        confirmLabel="Close job"
        onConfirm={handleClose}
        onClose={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === "finalize-assessment"}
        title="Finalize this assessment?"
        description="Finalizing issues the assessment link for this job. A finalized assessment can no longer be edited or deleted. This does not consume any job quota."
        confirmLabel="Continue"
        onConfirm={handleFinalizeAssessment}
        onClose={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === "activate-assessment"}
        title="Confirm & activate this assessment?"
        description="Activation opens the assessment for candidate invitations. Invited candidates will verify their email through the link before they can proceed. This does not consume any job quota."
        confirmLabel="Confirm & Activate"
        onConfirm={handleActivateAssessment}
        onClose={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === "delete-assessment"}
        title="Delete this draft assessment?"
        description="Only the generated assessment and its questions are deleted. The job, its candidate list and your job slot are not affected. A deleted draft cannot be regenerated on your own — contact support if you change your mind."
        confirmLabel="Delete assessment"
        onConfirm={handleDeleteAssessment}
        onClose={() => setConfirmAction(null)}
      />
    </DashboardShell>
  );
};

// --- Local render helpers ---------------------------------------------------

function DetailRow({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function ReadOnlyJobDetails({ job, isActive, isClosed, onCloseClick }) {
  const skills = job.skills ?? [];
  const tools = job.tools ?? [];
  const questions = job.questions ?? [];
  // Structured-job collections. Legacy jobs may not carry these (and the
  // detail endpoint omits them if empty), so they are defaulted to [] here —
  // the same guard skills/tools/questions already use — so the page never
  // crashes and simply renders the "none recorded" state.
  const responsibilities = job.responsibilities ?? [];
  const educationRequirements = job.educationRequirements ?? [];

  return (
    <>
      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Job information</h2>
        <dl className="mt-5 grid gap-5 sm:grid-cols-3">
          <DetailRow label="Years of experience" value={job.yearsExperience ?? "—"} />
          <DetailRow label="Analysis days" value={job.analysisDays ?? "—"} />
          <DetailRow label="Created" value={formatDate(job.createdAt) ?? "—"} />
          <DetailRow
            label="Preferred candidates"
            value={
              job.preferredCandidateCount
                ? `${job.preferredCandidateCount} (priority target)`
                : "No preference"
            }
          />
          <DetailRow
            label="Candidate list"
            value={
              job.candidateList
                ? `${job.candidateList.file?.originalName ?? "Uploaded file"} (${job.candidateList.candidateCount} candidate${job.candidateList.candidateCount === 1 ? "" : "s"})`
                : "—"
            }
          />
        </dl>
        <dl className="mt-5 grid gap-5 sm:grid-cols-3">
          <DetailRow label="Employment type" value={job.employmentType ?? "—"} />
          <DetailRow label="Work mode" value={job.workMode ?? "—"} />
          <DetailRow label="Location" value={job.location ?? "—"} />
        </dl>
        {job.description && (
          <div className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Description
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{job.description}</p>
          </div>
        )}

        <h3 className="mt-6 text-sm font-semibold text-slate-900">
          Skills {skills.length > 0 && <span className="text-slate-500">({skills.length})</span>}
        </h3>
        {skills.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No skills were recorded for this job.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {skills.map((skill) => (
              <li
                key={skill.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-2.5 text-sm"
              >
                <span className="font-medium text-slate-800">{skill.name}</span>
                <span className="text-slate-600">Weight {skill.weight}/100</span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-6 text-sm font-semibold text-slate-900">
          Tools &amp; software{" "}
          {tools.length > 0 && <span className="text-slate-500">({tools.length})</span>}
        </h3>
        {tools.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No tools were recorded for this job.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {tools.map((tool) => (
              <li
                key={tool.id}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700"
              >
                {tool.name}
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-6 text-sm font-semibold text-slate-900">
          Job-related questions{" "}
          {questions.length > 0 && <span className="text-slate-500">({questions.length})</span>}
        </h3>
        {questions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No questions were recorded for this job.</p>
        ) : (
          <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-slate-700">
            {questions.map((question) => (
              <li key={question.id}>{question.question}</li>
            ))}
          </ol>
        )}
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">
          Key responsibilities
        </h2>
        {responsibilities.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No key responsibilities recorded.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {responsibilities.map((resp, index) => (
              <li
                key={resp.id ?? index}
                className="flex items-start gap-2 text-sm text-slate-700"
              >
                <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-slate-400" />
                {resp.text ?? ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">
          Education requirements
        </h2>
        {educationRequirements.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No education requirements recorded.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {educationRequirements.map((req, index) => (
              <li
                key={req.id ?? index}
                className="flex items-start gap-2 text-sm text-slate-700"
              >
                <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-slate-400" />
                {req.text ?? ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Timeline</h2>
        <dl className="mt-5 grid gap-5 sm:grid-cols-2">
          <DetailRow label="Created" value={formatDate(job.createdAt) ?? "—"} />
          <DetailRow label="Started" value={formatDate(job.startedAt) ?? "Not started"} />
          <DetailRow label="Analysis ends" value={formatDate(job.analysisEndsAt) ?? "—"} />
          <DetailRow
            label="Closed"
            value={
              job.closedAt
                ? `${formatDate(job.closedAt)}${
                    job.closedReason
                      ? ` — ${JOB_CLOSED_REASON_LABELS[job.closedReason] ?? job.closedReason}`
                      : ""
                  }`
                : "Not closed"
            }
          />
        </dl>
      </section>

      {isActive && (
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onCloseClick}>
            Close Job
          </Button>
        </div>
      )}
      {isClosed && (
        <p className="text-right text-xs text-slate-500">
          This job is closed. Closed jobs cannot be reopened — create a new job for the same
          position.
        </p>
      )}
    </>
  );
}

export default RecruiterJobDetail;

