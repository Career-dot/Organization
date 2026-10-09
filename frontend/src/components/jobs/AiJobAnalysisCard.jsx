import { useMemo, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { EditIcon, SparkIcon } from "../ui/icons";
import AiStatusBadge from "./AiStatusBadge";
import {
  AI_FAILURE_MESSAGES,
  AI_JOB_STATUS,
  ANALYSIS_SECTIONS,
} from "../../constants/aiWorkflow";

const cardClasses = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7";

const failureMessage = (lastError) =>
  AI_FAILURE_MESSAGES[lastError] ?? AI_FAILURE_MESSAGES.default;

// The Recruiter's "AI Job Analysis" card for an ACTIVE/CLOSED job.
//
// Every state comes from the real AiJob row (PENDING / PROCESSING / COMPLETED /
// FAILED) — nothing here is faked. When the analysis is COMPLETED the card
// shows one message box per analysis section, communicating ONLY the number of
// clarification questions the AI generated for that section; "View / Edit"
// reveals and edits that section's actual questions.
//
// `questions` is the persisted, recruiter-editable copy (JobClarificationQuestion
// rows) — saving calls onSaveQuestions with the FULL list, so nothing can be
// silently discarded and a refresh can never lose work.
const AiJobAnalysisCard = ({
  aiJob,
  approved,
  questions = [],
  busy = false,
  onSaveQuestions,
  onContinue,
}) => {
  const [openSection, setOpenSection] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({}); // id -> text for the open section
  const [sectionError, setSectionError] = useState(null);

  const bySection = useMemo(() => {
    const grouped = Object.fromEntries(ANALYSIS_SECTIONS.map((section) => [section.key, []]));
    for (const question of questions) {
      if (grouped[question.section]) {
        grouped[question.section].push(question);
      }
    }
    return grouped;
  }, [questions]);

  const totalQuestions = questions.length;
  const isWorking =
    aiJob?.status === AI_JOB_STATUS.PENDING || aiJob?.status === AI_JOB_STATUS.PROCESSING;

  const startEdit = (sectionKey) => {
    setOpenSection(sectionKey);
    setEditing(true);
    setSectionError(null);
    setDraft(
      Object.fromEntries(bySection[sectionKey].map((question) => [question.id, question.question]))
    );
  };

  const toggleView = (sectionKey) => {
    setOpenSection((prev) => (prev === sectionKey ? null : sectionKey));
    setEditing(false);
    setSectionError(null);
  };

  const saveSection = async () => {
    setSectionError(null);
    // Full-list save: this section's drafts, every other question untouched.
    const payload = questions.map((question) =>
      draft[question.id] !== undefined
        ? { id: question.id, question: String(draft[question.id]).trim() || question.question }
        : { id: question.id, question: question.question }
    );
    try {
      await onSaveQuestions(payload);
      setEditing(false);
    } catch (error) {
      setSectionError(error.message);
    }
  };

  return (
    <section className={cardClasses}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold text-slate-900">
          <SparkIcon className="h-5 w-5 text-indigo-600" />
          AI Job Analysis
        </h2>
        {aiJob && <AiStatusBadge status={aiJob.status} />}
      </div>

      {isWorking && (
        <div className="mt-4 flex items-center gap-3 text-sm text-slate-600">
          <Spinner className="h-4 w-4" />
          Analyzing this job…
        </div>
      )}

      {aiJob?.status === AI_JOB_STATUS.FAILED && (
        <Alert variant="error" className="mt-4">
          {failureMessage(aiJob.lastError)}
        </Alert>
      )}

      {aiJob?.status === AI_JOB_STATUS.COMPLETED && (
        <div className="mt-4 space-y-5">
          <p className="text-sm text-slate-600">
            The AI reviewed the job as it was when it started and generated{" "}
            <span className="font-semibold text-slate-800">
              {totalQuestions} clarification question{totalQuestions === 1 ? "" : "s"}
            </span>
            . Review them by section — your edits are saved per section.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {ANALYSIS_SECTIONS.map((section) => {
              const sectionQuestions = bySection[section.key];
              const isOpen = openSection === section.key;
              return (
                <div
                  key={section.key}
                  className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"
                >
                  <h3 className="text-sm font-semibold text-slate-900">{section.label}</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    AI generated{" "}
                    <span className="font-semibold text-slate-800">{sectionQuestions.length}</span>{" "}
                    question{sectionQuestions.length === 1 ? "" : "s"}
                  </p>

                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      variant={isOpen ? "outline" : "secondary"}
                      size="sm"
                      onClick={() => toggleView(section.key)}
                      disabled={busy}
                    >
                      {isOpen ? "Hide" : "View"}
                    </Button>
                    {!approved && (
                      <Button
                        type="button"
                        variant={editing && isOpen ? "outline" : "ghost"}
                        size="sm"
                        onClick={() => (editing && isOpen ? setEditing(false) : startEdit(section.key))}
                        disabled={busy || sectionQuestions.length === 0}
                      >
                        <EditIcon className="h-3.5 w-3.5" />
                        {editing && isOpen ? "Cancel" : "Edit"}
                      </Button>
                    )}
                  </div>

                  {isOpen && (
                    <div className="mt-3 space-y-2">
                      {sectionError && <Alert variant="error">{sectionError}</Alert>}
                      {editing ? (
                        <>
                          {sectionQuestions.map((question, index) => (
                            <div key={question.id}>
                              <label
                                htmlFor={`clarification-${question.id}`}
                                className="text-xs font-medium text-slate-500"
                              >
                                Question {index + 1}
                                {question.edited && (
                                  <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600">
                                    Edited
                                  </span>
                                )}
                              </label>
                              <textarea
                                id={`clarification-${question.id}`}
                                rows={2}
                                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15"
                                value={draft[question.id] ?? question.question}
                                onChange={(event) =>
                                  setDraft((prev) => ({ ...prev, [question.id]: event.target.value }))
                                }
                              />
                            </div>
                          ))}
                          <div className="flex items-center gap-2 pt-1">
                            <Button type="button" size="sm" onClick={saveSection} disabled={busy}>
                              {busy && <Spinner className="h-3.5 w-3.5" />}
                              Save
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditing(false)}
                              disabled={busy}
                            >
                              Cancel
                            </Button>
                          </div>
                        </>
                      ) : (
                        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
                          {sectionQuestions.map((question) => (
                            <li key={question.id}>
                              {question.question}
                              {question.edited && (
                                <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-600">
                                  Edited
                                </span>
                              )}
                            </li>
                          ))}
                          {sectionQuestions.length === 0 && (
                            <li className="list-none text-slate-500">
                              No clarification questions for this section.
                            </li>
                          )}
                        </ol>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {approved ? (
            <Alert variant="success">
              Clarification questions approved — the assessment stage continues below.
            </Alert>
          ) : (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
              <p className="text-sm text-slate-700">
                Continue when you are happy with the questions. Your questions are approved exactly
                as they stand — nothing is regenerated, and AI assessment generation starts from
                them.
              </p>
              <div className="mt-3">
                <Button type="button" onClick={onContinue} disabled={busy}>
                  {busy && <Spinner className="h-4 w-4" />}
                  Edit &amp; Continue
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default AiJobAnalysisCard;