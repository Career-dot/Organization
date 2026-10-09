import { useState } from "react";
import { useNavigate } from "react-router-dom";
import DashboardShell from "../../components/ui/DashboardShell";
import Button from "../../components/ui/Button";
import DraftJobForm from "../../components/jobs/DraftJobForm";
import { RECRUITER_NAV_ITEMS } from "../../constants/recruiterNav";
import { JOB_FORM_LIMITS } from "../../constants/jobForm";
import { createJobDraft, startJob, updateJobDraft } from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";
import {
  buildDraftPayload,
  buildEditPayload,
  emptyFormState,
} from "../../utils/jobFormState";

const { TITLE_MIN } = JOB_FORM_LIMITS;

// Draft rule: ONLY the title is required to save. Everything else may be
// incomplete — the backend accepts partial drafts and Start re-validates.
const validateTitleOnly = (title) => {
  const trimmed = title.trim();
  if (trimmed.length < TITLE_MIN) {
    return `Job title must be at least ${TITLE_MIN} characters`;
  }
  if (trimmed.length > JOB_FORM_LIMITS.TITLE_MAX) {
    return `Job title must be at most ${JOB_FORM_LIMITS.TITLE_MAX} characters`;
  }
  return null;
};

// ONE continuous create/edit flow (no second form, no second path):
//
//   /recruiter/jobs/create renders the SAME DraftJobForm the draft editor uses.
//   The Candidate Excel section is visible from the very beginning; the upload
//   itself unlocks the moment the draft exists (the backend persists the file
//   against a saved Job id). Save Draft creates the draft IN PLACE — the
//   recruiter stays on this page with all typed values intact — and the same
//   form then offers the upload, the readiness checklist and Start Job.
const RecruiterJobCreate = () => {
  const navigate = useNavigate();
  const [form, setForm] = useState(emptyFormState());
  // The saved draft's id. Empty until the first Save Draft; it is the only
  // state that changes between "new job" and "draft being edited" — the form
  // itself (fields, Excel section, readiness, Start) is the same component.
  const [jobId, setJobId] = useState(null);
  const [candidateList, setCandidateList] = useState(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState(null); // { variant, message }

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const titleError = validateTitleOnly(form.title);

  const handleSaveDraft = async () => {
    setNotice(null);
    if (titleError) {
      setNotice({ variant: "error", message: titleError });
      return;
    }
    setSaving(true);
    try {
      if (jobId) {
        // Draft already exists: update it in place (same semantics as the
        // draft editor — cleared fields are sent as null).
        const response = await updateJobDraft(jobId, buildEditPayload(form));
        setCandidateList(response.data.candidateList ?? null);
        setNotice({ variant: "success", message: "Draft saved successfully." });
      } else {
        // First save: create the draft and stay on this form. The Candidate
        // Excel upload becomes available immediately — no navigation, no
        // save-and-reopen round trip.
        const response = await createJobDraft(buildDraftPayload(form));
        setJobId(response.data.id);
        setCandidateList(response.data.candidateList ?? null);
        // Capture the server-assigned createdAt so the readiness checklist can
        // classify this as a structured job (it is — it was just created) and
        // enforce the new employmentType/workMode/location rules before Start.
        if (response.data.createdAt) {
          updateField("createdAt", response.data.createdAt);
        }
        setNotice({
          variant: "success",
          message: "Draft created. You can now upload the Candidate Excel right here.",
        });
      }
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  // Same Start contract as the draft editor: persist the visible form first,
  // then call the existing POST /job/:jobId/start (confirmation is handled by
  // the shared form). The backend re-validates everything authoritatively.
  const handleStart = async () => {
    if (starting || !jobId) return;
    setStarting(true);
    setNotice(null);
    try {
      await updateJobDraft(jobId, buildEditPayload(form));
    } catch (error) {
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
      setStarting(false);
      return;
    }
    try {
      await startJob(jobId);
      // The job is ACTIVE now — the detail page owns its further lifecycle
      // (AI analysis card, assessment, close), so hand over to it.
      navigate(`/recruiter/jobs/${jobId}`, {
        state: { flash: "Job started. One job slot was consumed — closing it will not return the slot." },
      });
    } catch (error) {
      // Surface the backend's actual Start validation error (readiness, quota,
      // candidate list …) — the checklist above mirrors it, the API is final.
      setNotice({ variant: "error", message: extractApiErrorMessage(error) });
      setStarting(false);
    }
  };

  return (
    <DashboardShell
      roleLabel="Recruiter"
      title={jobId ? "Create Job — draft saved" : "Create Job"}
      description={
        jobId
          ? "Draft saved. Upload the Candidate Excel, complete the details, then start the job."
          : "Start with a draft — only the title is required to save."
      }
      navItems={RECRUITER_NAV_ITEMS}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button as="link" to="/recruiter/jobs" variant="ghost" size="sm">
            ← Back to jobs
          </Button>
        </div>

        <DraftJobForm
          jobId={jobId}
          form={form}
          updateField={updateField}
          saving={saving}
          onSave={handleSaveDraft}
          notice={notice}
          onStart={handleStart}
          starting={starting}
          candidateList={candidateList}
          onCandidateListChange={setCandidateList}
        />
      </div>
    </DashboardShell>
  );
};

export default RecruiterJobCreate;
