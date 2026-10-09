import Button from "../ui/Button";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { JOB_FORM_LIMITS } from "../../constants/jobForm";
// Row factories live in utils/jobFormState.js so this component file exports
// only components (react-refresh/only-export-components).
import { makeQuestionRow } from "../../utils/jobFormState";

const { QUESTION_MIN, QUESTION_MAX, MAX_QUESTIONS } = JOB_FORM_LIMITS;

// Relational question rows: { key, question } — sortOrder derives from array
// order. Question text must be 5-2000 characters.

const rowInputClasses =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15";

const QuestionsEditor = ({ questions, onChange }) => {
  const updateRow = (key, patch) =>
    onChange(questions.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const removeRow = (key) => onChange(questions.filter((row) => row.key !== key));

  const moveRow = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const atLimit = questions.length >= MAX_QUESTIONS;

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Questions candidates should answer during assessment ({QUESTION_MIN}–{QUESTION_MAX}{" "}
        characters each).
      </p>

      {questions.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
          <p className="text-sm font-medium text-slate-700">No questions yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add at least one question before starting this job.
          </p>
        </div>
      )}

      {questions.map((row, index) => {
        const length = row.question.trim().length;
        const lengthInvalid = row.question !== "" && (length < QUESTION_MIN || length > QUESTION_MAX);

        return (
          <div
            key={row.key}
            className={`rounded-xl border bg-white p-3 shadow-sm ${
              lengthInvalid ? "border-red-300" : "border-slate-200"
            }`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <span className="hidden w-6 shrink-0 pt-2 text-center text-xs font-semibold text-slate-400 sm:block">
                {index + 1}
              </span>
              <div className="flex-1 space-y-1">
                <textarea
                  rows={2}
                  className={rowInputClasses}
                  placeholder="Job-related question (e.g. Describe how you would design a REST API for payments.)"
                  value={row.question}
                  maxLength={QUESTION_MAX}
                  onChange={(event) => updateRow(row.key, { question: event.target.value })}
                  aria-label={`Question ${index + 1}`}
                />
                <div className="flex justify-between text-xs text-slate-400">
                  <span>
                    {lengthInvalid && (
                      <span className="text-red-600">
                        Must be {QUESTION_MIN}–{QUESTION_MAX} characters
                      </span>
                    )}
                  </span>
                  <span>
                    {length} / {QUESTION_MAX}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                  onClick={() => moveRow(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move question ${index + 1} up`}
                >
                  <ArrowUpIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                  onClick={() => moveRow(index, 1)}
                  disabled={index === questions.length - 1}
                  aria-label={`Move question ${index + 1} down`}
                >
                  <ArrowDownIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
                  onClick={() => removeRow(row.key)}
                  aria-label={`Remove question ${index + 1}`}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...questions, makeQuestionRow()])}
        disabled={atLimit}
      >
        <PlusIcon className="h-4 w-4" />
        {atLimit ? `Maximum of ${MAX_QUESTIONS} questions reached` : "Add question"}
      </Button>
    </div>
  );
};

export default QuestionsEditor;
