import { useMemo, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { CheckIcon, EditIcon, SparkIcon } from "../ui/icons";
import AiStatusBadge from "./AiStatusBadge";
import {
  AI_FAILURE_MESSAGES,
  AI_JOB_STATUS,
  ANALYSIS_SECTIONS,
  ASSESSMENT_STATUS,
} from "../../constants/aiWorkflow";

// Candidate timer label. durationSeconds is recruiter-controlled whole seconds
// (60–9999); the AI never supplies it, so nothing here "guesses" a duration.
const formatDuration = (seconds) => {
  const total = Number(seconds);
  if (!Number.isInteger(total) || total <= 0) return "not set";
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
};

const cardClasses = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7";

const failureMessage = (lastError) =>
  AI_FAILURE_MESSAGES[lastError] ?? AI_FAILURE_MESSAGES.default;

const QUESTION_TYPE_LABELS = {
  SINGLE_CHOICE: "Single choice",
  MULTIPLE_CHOICE: "Multiple choice",
  SCENARIO: "Scenario",
  PROBLEM_SOLVING: "Problem solving",
  SHORT_ANSWER: "Short answer",
};

const DIFFICULTY_LABELS = {
  BEGINNER: "Beginner",
  INTERMEDIATE: "Intermediate",
  ADVANCED: "Advanced",
  EXPERT: "Expert",
};

// The Recruiter's "AI Assessment" card.
//
// States (all real, all from PostgreSQL):
//   * no assessment + ASSESSMENT_GENERATION queued/working → real progress line
//   * no assessment + FAILED → real failure state, job and data safe
//   * DRAFT   → full inspect + Edit/Update/Delete/Continue
//   * FINALIZED → "Ready" + the persisted assessment link + Copy
const AssessmentCard = ({
  assessment,
  generationAiJob,
  busy = false,
  onUpdate,
  onFinalize,
  onDeleteClick,
  onActivate,
}) => {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  // Edit-mode drafts: title/description/duration scalars + per-question
  // prompt/points. durationSeconds is the candidate test timer (whole seconds) —
  // recruiter-controlled and never AI-decided.
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftDurationSeconds, setDraftDurationSeconds] = useState("");
  const [draftQuestions, setDraftQuestions] = useState({}); // id -> { prompt, points }
  // Finalized-stage control: the read-only candidate preview (the invitation
  // action itself lives ONLY on the candidate list rows).
  const [showPreview, setShowPreview] = useState(false);

  const questions = useMemo(() => assessment?.questions ?? [], [assessment]);
  const bySection = useMemo(() => {
    const grouped = Object.fromEntries(ANALYSIS_SECTIONS.map((section) => [section.key, []]));
    for (const question of questions) {
      if (grouped[question.section]) {
        grouped[question.section].push(question);
      }
    }
    return grouped;
  }, [questions]);

  const isGenerating =
    !assessment &&
    generationAiJob &&
    (generationAiJob.status === AI_JOB_STATUS.PENDING ||
      generationAiJob.status === AI_JOB_STATUS.PROCESSING);

  // Activation + invitations are backend states (JobAssessment.activatedAt and
  // JobAssessmentInvitation rows) — this card only reflects them. It never
  // creates an invitation: the candidate list's per-row Invite action is the
  // single entry point.
  const isActivated = Boolean(assessment?.activatedAt);

  const startEdit = () => {
    setDraftTitle(assessment.title);
    setDraftDescription(assessment.description ?? "");
    setDraftDurationSeconds(String(assessment.durationSeconds ?? ""));
    setDraftQuestions(
      Object.fromEntries(
        questions.map((question) => [
          question.id,
          { prompt: question.prompt, points: String(question.points) },
        ])
      )
    );
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setError(null);
    // durationSeconds is the candidate timer (whole seconds, 60–9999). It is
    // recruiter-edited here and must never come from the AI or the provider.
    const durationSeconds = Number(draftDurationSeconds);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 9999) {
      setError("Duration must be a whole number between 60 and 9999 seconds.");
      return;
    }
    const payload = {
      title: draftTitle.trim(),
      description: draftDescription.trim() ? draftDescription.trim() : null,
      durationSeconds,
      // Full-list questions patch: prompts/points for every question, ids set
      // equal — nothing silently discarded. Difficulty is left unchanged.
      questions: questions.map((question) => ({
        id: question.id,
        prompt: (draftQuestions[question.id]?.prompt ?? question.prompt).trim() || question.prompt,
        points: Number(draftQuestions[question.id]?.points ?? question.points),
      })),
    };
    try {
      await onUpdate(payload);
      setEditing(false);
    } catch (caught) {
      setError(caught.message);
    }
  };

  const assessmentLink = assessment?.publicId
    ? `${window.location.origin}/assessment/${assessment.publicId}`
    : null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(assessmentLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("The link could not be copied automatically — select it and copy it manually.");
    }
  };

  return (
    <section className={cardClasses}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold text-slate-900">
          <SparkIcon className="h-5 w-5 text-indigo-600" />
          AI Assessment
        </h2>
        {assessment ? (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
              assessment.status === ASSESSMENT_STATUS.FINALIZED
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            {assessment.status === ASSESSMENT_STATUS.FINALIZED ? (isActivated ? "Active" : "Ready") : "Draft"}
          </span>
        ) : (
          generationAiJob && <AiStatusBadge status={generationAiJob.status} />
        )}
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      {isGenerating && (
        <div className="mt-4 flex items-center gap-3 text-sm text-slate-600">
          <Spinner className="h-4 w-4" />
          Generating the assessment from your approved clarification questions…
        </div>
      )}

      {!assessment && generationAiJob?.status === AI_JOB_STATUS.FAILED && (
        <Alert variant="error" className="mt-4">
          {failureMessage(generationAiJob.lastError)}
        </Alert>
      )}

      {assessment && (
        <div className="mt-4 space-y-5">
          {editing ? (
            <div className="space-y-3">
              <div>
                <label htmlFor="assessment-title" className="text-xs font-medium text-slate-500">
                  Title
                </label>
                <input
                  id="assessment-title"
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15"
                  value={draftTitle}
                  maxLength={200}
                  onChange={(event) => setDraftTitle(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="assessment-description" className="text-xs font-medium text-slate-500">
                  Description
                </label>
                <textarea
                  id="assessment-description"
                  rows={3}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15"
                  value={draftDescription}
                  maxLength={5000}
                  onChange={(event) => setDraftDescription(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="assessment-duration" className="text-xs font-medium text-slate-500">
                  Candidate duration (seconds, 60–9999)
                </label>
                <input
                  id="assessment-duration"
                  type="number"
                  min={60}
                  max={9999}
                  step={1}
                  className="mt-1 w-40 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15"
                  value={draftDurationSeconds}
                  onChange={(event) => setDraftDurationSeconds(event.target.value)}
                />
                <p className="mt-1 text-xs text-slate-500">
                  The countdown shown to the candidate. Never decided by the AI — separate from the
                  job's analysis/invitation window.
                </p>
              </div>
            </div>
          ) : (
            <>
              <h3 className="text-base font-semibold text-slate-900">{assessment.title}</h3>
              {assessment.description && (
                <p className="whitespace-pre-wrap text-sm text-slate-600">
                  {assessment.description}
                </p>
              )}
              <p className="text-xs text-slate-500">
                Candidate duration: {formatDuration(assessment.durationSeconds)}
              </p>
            </>
          )}

          {Object.entries(bySection).map(([sectionKey, sectionQuestions]) =>
            sectionQuestions.length === 0 ? null : (
              <div key={sectionKey}>
                <h4 className="text-sm font-semibold text-slate-900">
                  {ANALYSIS_SECTIONS.find((section) => section.key === sectionKey)?.label ??
                    sectionKey}{" "}
                  <span className="font-normal text-slate-500">({sectionQuestions.length})</span>
                </h4>
                <ol className="mt-2 space-y-2">
                  {sectionQuestions.map((question) => (
                    <li
                      key={question.id}
                      className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
                    >
                      <div className="space-y-1">
                        {editing ? (
                          <>
                            <textarea
                              aria-label={`Question ${question.sortOrder + 1} prompt`}
                              rows={2}
                              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15"
                              value={draftQuestions[question.id]?.prompt ?? question.prompt}
                              maxLength={4000}
                              onChange={(event) =>
                                setDraftQuestions((prev) => ({
                                  ...prev,
                                  [question.id]: { ...prev[question.id], prompt: event.target.value },
                                }))
                              }
                            />
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                              <span>
                                {QUESTION_TYPE_LABELS[question.questionType] ?? question.questionType}
                              </span>
                              <span>·</span>
                              <label htmlFor={`points-${question.id}`}>Points</label>
                              <input
                                id={`points-${question.id}`}
                                type="number"
                                min={1}
                                max={100}
                                className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
                                value={draftQuestions[question.id]?.points ?? String(question.points)}
                                onChange={(event) =>
                                  setDraftQuestions((prev) => ({
                                    ...prev,
                                    [question.id]: { ...prev[question.id], points: event.target.value },
                                  }))
                                }
                              />
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-sm text-slate-800">{question.prompt}</p>
                            <p className="text-xs text-slate-500">
                              {QUESTION_TYPE_LABELS[question.questionType] ?? question.questionType}
                              {" · "}
                              {question.points} point{question.points === 1 ? "" : "s"}
                              {question.difficulty
                                ? ` · ${DIFFICULTY_LABELS[question.difficulty] ?? question.difficulty}`
                                : ""}
                            </p>
                          </>
                        )}
                        {question.options?.length > 0 && !editing && (
                          <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                            {question.options.map((option) => (
                              <li key={option}>{option}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )
          )}

          {assessment.status === ASSESSMENT_STATUS.FINALIZED ? (
            <div className="space-y-4">
              <Alert variant={isActivated ? "success" : "info"}>
                {isActivated
                  ? "Active — invited candidates can access this assessment through its link."
                  : "Finalized but not yet active — preview it, then confirm to enable invitations."}
              </Alert>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={() => setShowPreview((prev) => !prev)}>
                  {showPreview ? "Hide Preview" : "Preview Assessment"}
                </Button>
                {!isActivated && (
                  <Button type="button" onClick={onActivate} disabled={busy}>
                    {busy && <Spinner className="h-4 w-4" />}
                    Confirm &amp; Activate
                  </Button>
                )}
              </div>

              {showPreview && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Candidate preview (read-only)
                  </p>
                  <h4 className="mt-2 text-base font-semibold text-slate-900">{assessment.title}</h4>
                  {assessment.description && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
                      {assessment.description}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-slate-500">
                    Duration: {formatDuration(assessment.durationSeconds)} ·{" "}
                    {questions.length} question{questions.length === 1 ? "" : "s"}
                  </p>
                  <ol className="mt-3 space-y-2">
                    {questions.map((question, index) => (
                      <li key={question.id} className="rounded-lg border border-slate-200 bg-white p-3">
                        <p className="text-sm font-medium text-slate-900">
                          {index + 1}. {question.prompt}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {QUESTION_TYPE_LABELS[question.questionType] ?? question.questionType} ·{" "}
                          {question.points} points
                          {question.difficulty
                            ? ` · ${DIFFICULTY_LABELS[question.difficulty] ?? question.difficulty}`
                            : ""}
                        </p>
                        {Array.isArray(question.options) && question.options.length > 0 && (
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                            {question.options.map((option) => (
                              <li key={option}>{option}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                  <p className="mt-3 text-xs text-slate-500">
                    This preview creates no attempt, starts no timer and verifies no email — it is
                    exactly what an invited candidate sees after email verification.
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Assessment Link
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    readOnly
                    aria-label="Assessment link"
                    className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
                    value={assessmentLink ?? ""}
                    onFocus={(event) => event.target.select()}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={copyLink}>
                    {copied && <CheckIcon className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy Link"}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {isActivated
                    ? "Only candidates invited to this job can pass email verification on this link."
                    : "The link exists but is inactive — candidates cannot access it until you activate the assessment."}
                </p>
              </div>

              {/* There is deliberately NO invitation form here. Invitations are
                  sent from exactly ONE place: the per-category "Invite Selected"
                  action above the candidate list table. Rows carry only
                  checkboxes — an address is never typed into this card to invite
                  someone, because the backend resolves it from persisted
                  candidate data. */}
              <p className="text-xs text-slate-500">
                {isActivated
                  ? "Select candidates in the list below and use that section's Invite Selected button."
                  : "Activate the assessment above to enable the Invite Selected button."}
              </p>
            </div>
          ) : editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={save} disabled={busy}>
                {busy && <Spinner className="h-4 w-4" />}
                Update
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={startEdit} disabled={busy}>
                  <EditIcon className="h-4 w-4" />
                  Edit
                </Button>
                <Button type="button" onClick={onFinalize} disabled={busy}>
                  {busy && <Spinner className="h-4 w-4" />}
                  Continue
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-red-600 hover:bg-red-50"
                  onClick={onDeleteClick}
                  disabled={busy}
                >
                  Delete
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                Continue finalizes the assessment and issues its link. Finalized assessments can no
                longer be edited or deleted. None of these actions consume job quota.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default AssessmentCard;