import { useEffect, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import Spinner from "../ui/Spinner";
import {
  AnalysisDaysSection,
  AssessmentSettingsSection,
  DescriptionSection,
  JobTitleSection,
  PreferredCandidateCountSection,
  YearsExperienceSection,
} from "./JobFormSections";
import QuestionsEditor from "./QuestionsEditor";
import SkillsEditor from "./SkillsEditor";
import ToolsEditor from "./ToolsEditor";
import CandidateListUploader from "./CandidateListUploader";
import CandidateListView from "./CandidateListView";
import CandidateWorkflowList from "./CandidateWorkflowList";
import JobOverviewSection from "./JobOverviewSection";
import ResponsibilitiesEditor from "./ResponsibilitiesEditor";
import EducationRequirementsEditor from "./EducationRequirementsEditor";
import { evaluateJobStartReadiness, JOB_FORM_LIMITS } from "../../constants/jobForm";
import {
  deleteCandidateList,
  getCandidateListPreview,
  uploadCandidateList,
} from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";

const cardClasses = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7";

// View modal ceiling: request the full candidate list (up to the same
// 1,000-candidate maximum the parser enforces). The compact card separately
// relies on the endpoint's small default limit, so a 1,000-row sheet is never
// rendered into the card.
const MAX_VIEW_CANDIDATES = JOB_FORM_LIMITS.MAX_CANDIDATES;

// Start-readiness over the CURRENT (possibly unsaved) form state, normalized
// to the job shape the evaluator expects ("" → null so missing values are
// flagged; empty rows excluded, mirroring what the save payloads send).
// Single implementation shared by the Create Job and Edit Draft pages — the
// rules are the backend's own assertJobReadyToStart rules, mirrored in
// evaluateJobStartReadiness.
const formReadiness = (form, candidateList) =>
  evaluateJobStartReadiness({
    title: form.title,
    yearsExperience: form.yearsExperience === "" ? null : Number(form.yearsExperience),
    description: form.description,
    analysisDays: form.analysisDays === "" ? null : Number(form.analysisDays),
    skills: form.skills.filter((row) => row.name.trim() && row.weight !== ""),
    tools: form.tools.filter((row) => row.name.trim()),
    questions: form.questions.filter((row) => row.question.trim()),
    // Structured-job fields drive the new Start rules (employmentType + workMode,
    // and location for HYBRID/ON_SITE) — but only for jobs at/after the cutoff,
    // which `createdAt` decides inside the evaluator. Legacy jobs keep the old
    // readiness rules and are never blocked by these.
    employmentType: form.employmentType || null,
    workMode: form.workMode || null,
    location: form.location?.trim() || null,
    createdAt: form.createdAt ?? null,
    candidateList: candidateList ?? null,
  });

// The ONE recruiter draft form: job fields, Candidate Excel upload, preferred
// candidate count, start readiness and the Start action. Used by BOTH
// RecruiterJobCreate (continuous create flow) and RecruiterJobDetail (reopened
// draft) so the two routes can never diverge again.
//
// The candidate-list upload/preview/view/delete calls run here through the
// existing jobService endpoints (POST/GET/DELETE /job/:jobId/candidate-list) —
// there is deliberately no second uploader, no second candidate API and no
// duplicated readiness logic.
const DraftJobForm = ({
  jobId,
  form,
  updateField,
  saving,
  onSave,
  notice,
  onStart,
  starting = false,
  candidateList,
  onCandidateListChange,
}) => {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewFull, setViewFull] = useState(null);
  const [viewFullLoading, setViewFullLoading] = useState(false);
  const [viewError, setViewError] = useState(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);

  // Which uploaded file the loaded preview belongs to. Adjusted during render
  // (the React-recommended way to reset state when inputs change) so a new
  // upload/replace/delete immediately clears the stale preview and shows the
  // loading state — without synchronous setState inside an effect.
  const currentFileId = candidateList?.file?.id ?? null;
  const [previewFileId, setPreviewFileId] = useState(currentFileId);
  if (previewFileId !== currentFileId) {
    setPreviewFileId(currentFileId);
    setPreview(null);
    setPreviewLoading(Boolean(currentFileId));
  }

  // Compact preview of the uploaded candidate list (GET /job/:jobId/candidate-list).
  // A separate read so the card never renders the entire sheet; the full list
  // is shown only in the View modal. No call when the draft does not exist yet.
  useEffect(() => {
    if (!jobId || !currentFileId) return;
    let cancelled = false;
    getCandidateListPreview(jobId)
      .then((response) => {
        if (!cancelled) {
          setPreview(response.data);
          setPreviewLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreview(null);
          setPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, currentFileId]);

  // Candidate Excel Sheet: free draft action. The backend parses/validates the
  // file BEFORE persisting anything (1,000-candidate limit, case-insensitive
  // duplicate-email rejection), so a rejected upload changes nothing server
  // side. Client-side only the extension is pre-checked for fast feedback.
  const handleCandidateUpload = async (file) => {
    if (uploading || !jobId) return;
    if (!/\.(xlsx|xls)$/i.test(file?.name ?? "")) {
      setUploadError("Candidate list must be an Excel file (.xlsx or .xls).");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const response = await uploadCandidateList(jobId, file);
      onCandidateListChange(response.data);
    } catch (error) {
      setUploadError(extractApiErrorMessage(error, "The candidate list could not be uploaded."));
    } finally {
      setUploading(false);
    }
  };

  const handleCandidateRemove = async () => {
    if (uploading || !jobId) return;
    setUploading(true);
    setUploadError(null);
    try {
      await deleteCandidateList(jobId);
      onCandidateListChange(null);
    } catch (error) {
      setUploadError(extractApiErrorMessage(error, "The candidate list could not be removed."));
    } finally {
      setUploading(false);
      setDeleteConfirmOpen(false);
    }
  };

  // View: loads the FULL candidate list (up to the 1,000-candidate ceiling) on
  // demand through the same read-only endpoint, using ?limit=1000. The compact
  // card keeps its own 5-row preview; this read is never persisted anywhere.
  const handleCandidateView = async () => {
    if (!jobId) return;
    setViewOpen(true);
    setViewFull(null);
    setViewError(null);
    setViewFullLoading(true);
    try {
      const response = await getCandidateListPreview(jobId, MAX_VIEW_CANDIDATES);
      setViewFull(response.data);
    } catch (error) {
      setViewFull(null);
      setViewError(extractApiErrorMessage(error, "The candidate list could not be loaded."));
    } finally {
      setViewFullLoading(false);
    }
  };

  const handleCandidateViewClose = () => {
    setViewOpen(false);
    setViewFull(null);
    setViewError(null);
  };

  const readiness = formReadiness(form, candidateList);

  return (
    <>
      {notice && <Alert variant={notice.variant}>{notice.message}</Alert>}

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Job information</h2>
        <div className="mt-5 space-y-5">
          <JobTitleSection title={form.title} onChange={(value) => updateField("title", value)} />
          <YearsExperienceSection
            yearsExperience={form.yearsExperience}
            onChange={(value) => updateField("yearsExperience", value)}
          />
          <DescriptionSection
            description={form.description}
            onChange={(value) => updateField("description", value)}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Job overview</h2>
        <div className="mt-5">
          <JobOverviewSection
            employmentType={form.employmentType}
            workMode={form.workMode}
            location={form.location}
            onEmploymentTypeChange={(value) => updateField("employmentType", value)}
            onWorkModeChange={(value) => updateField("workMode", value)}
            onLocationChange={(value) => updateField("location", value)}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Skills &amp; weights</h2>
        <div className="mt-5">
          <SkillsEditor skills={form.skills} onChange={(skills) => updateField("skills", skills)} />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Tools &amp; software</h2>
        <div className="mt-5">
          <ToolsEditor tools={form.tools} onChange={(tools) => updateField("tools", tools)} />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Job-related questions</h2>
        <div className="mt-5">
          <QuestionsEditor
            questions={form.questions}
            onChange={(questions) => updateField("questions", questions)}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">
          Key responsibilities
        </h2>
        <div className="mt-5">
          <ResponsibilitiesEditor
            responsibilities={form.responsibilities}
            onChange={(responsibilities) => updateField("responsibilities", responsibilities)}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">
          Education requirements
        </h2>
        <div className="mt-5">
          <EducationRequirementsEditor
            educationRequirements={form.educationRequirements}
            onChange={(educationRequirements) =>
              updateField("educationRequirements", educationRequirements)}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">
          Candidate list <span className="text-rose-600" aria-hidden="true">*</span>
          <span className="ml-2 align-middle text-xs font-semibold uppercase tracking-wide text-rose-600">
            Required
          </span>
        </h2>
        {uploadError && (
          <Alert variant="error" className="mt-4">
            {uploadError}
          </Alert>
        )}
        <div className="mt-4">
          {jobId ? (
            <>
              <CandidateListUploader
                candidateList={candidateList}
                preview={preview}
                previewLoading={previewLoading}
                uploading={uploading}
                onUpload={handleCandidateUpload}
                onView={handleCandidateView}
                onDelete={() => setDeleteConfirmOpen(true)}
              />
              {/* Phase 1 of the candidate workflow — the persisted list as the
                  backend classifies it (IN SYSTEM / NOT IN SYSTEM) with each
                  candidate's EXISTING verified skill score for display. Rendered
                  only once a list exists; it re-reads whenever the file is
                  replaced (currentFileId). */}
              {candidateList && (
                <div className="mt-6">
                  <CandidateWorkflowList jobId={jobId} candidateListFileId={currentFileId} />
                </div>
              )}
            </>
          ) : (
            /* The backend persists the Excel against a saved Job id, so the
               upload unlocks the moment the draft exists — without leaving this
               form. The step itself stays visible from the very beginning. */
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
              <p className="text-sm font-medium text-slate-700">
                Candidate Excel upload unlocks as soon as the draft is saved.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Click Save Draft below — the form stays right here and the upload appears in this
                same section.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Candidate preferences</h2>
        <div className="mt-5">
          <PreferredCandidateCountSection
            preferredCandidateCount={form.preferredCandidateCount}
            onChange={(value) => updateField("preferredCandidateCount", value)}
            candidateCount={candidateList?.candidateCount ?? null}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Analysis period</h2>
        <div className="mt-5">
          <AnalysisDaysSection
            analysisDays={form.analysisDays}
            onChange={(value) => updateField("analysisDays", value)}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Assessment settings</h2>
        <p className="mt-1 text-xs text-slate-500">
          Requested shape of the AI assessment generated for this job. Hard platform limits:
          at most 45 questions, at most 90 minutes of candidate time.
        </p>
        <div className="mt-5 space-y-5">
          <AssessmentSettingsSection
            assessmentQuestionCount={form.assessmentQuestionCount}
            onQuestionCountChange={(value) => updateField("assessmentQuestionCount", value)}
            assessmentDurationMinutes={form.assessmentDurationMinutes}
            onDurationMinutesChange={(value) => updateField("assessmentDurationMinutes", value)}
          />
        </div>
      </section>

      <section className={cardClasses}>
        <h2 className="font-display text-lg font-bold text-slate-900">Start readiness</h2>
        {readiness.ready ? (
          <div className="mt-4 space-y-4">
            <Alert variant="success">
              All required job details are complete. Starting will consume one job slot — closing the
              job later does not return the slot.
            </Alert>
            <Button type="button" onClick={() => setConfirmStartOpen(true)} disabled={starting}>
              {starting && <Spinner className="h-4 w-4" />}
              Start Job
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-600">
              You can save the draft at any time. These items are required before the job can be
              started:
            </p>
            <ul className="space-y-2 text-sm text-slate-700">
              {readiness.problems.map((problem) => (
                <li key={problem} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-amber-400" />
                  <span>{problem}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={onSave} disabled={saving}>
          {saving && <Spinner className="h-4 w-4" />}
          Save Draft
        </Button>
      </div>
      <p className="text-right text-xs text-slate-500">
        Saving a draft is free — job quota is only consumed when the job is started.
      </p>

      <ConfirmDialog
        open={confirmStartOpen}
        title="Start this job?"
        description="Starting makes the job active and consumes one job slot from your plan. Closing the job later does not return the slot."
        confirmLabel="Start job"
        onConfirm={() => {
          setConfirmStartOpen(false);
          onStart();
        }}
        onClose={() => setConfirmStartOpen(false)}
      />
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Remove this candidate list?"
        description="The uploaded Excel file and its candidate list will be deleted. This does not affect your job, your job slot or the AI analysis. You can upload a new file afterwards."
        confirmLabel="Remove candidate list"
        onConfirm={handleCandidateRemove}
        onClose={() => setDeleteConfirmOpen(false)}
      />
      <CandidateListView
        open={viewOpen}
        loading={viewFullLoading}
        fileName={viewFull?.fileName ?? preview?.fileName}
        candidateCount={viewFull?.candidateCount ?? preview?.candidateCount}
        rows={viewFull?.rows ?? []}
        error={viewError}
        onClose={handleCandidateViewClose}
      />
    </>
  );
};

export default DraftJobForm;
