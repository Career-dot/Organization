import Button from "../ui/Button";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { makeEducationRequirementRow } from "../../utils/jobFormState";

const rowInputClasses =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15";

// Relational education-requirement rows: { key, text }. Blank rows are trimmed
// and omitted on serialization; sortOrder is derived from array order at
// serialization time (the backend does the same).
export const EducationRequirementsEditor = ({
  educationRequirements,
  onChange,
}) => {
  const updateRow = (key, patch) =>
    onChange(educationRequirements.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const removeRow = (key) => onChange(educationRequirements.filter((row) => row.key !== key));

  const moveRow = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= educationRequirements.length) return;
    const next = [...educationRequirements];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const addRow = () => onChange([...educationRequirements, makeEducationRequirementRow()]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Education requirements for this role. Add and remove as needed — the order is
        preserved as you type.
      </p>

      {educationRequirements.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
          <p className="text-sm font-medium text-slate-700">No education requirements yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add minimum education requirements for the role. These are optional and do
            not block starting the job.
          </p>
        </div>
      )}

      {educationRequirements.map((row, index) => (
        <div
          key={row.key}
          className={`rounded-xl border bg-white p-3 shadow-sm ${
            !row.text.trim() ? "border-slate-200" : "border-slate-200"
          }`}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <span className="hidden w-6 shrink-0 pt-2 text-center text-xs font-semibold text-slate-400 sm:block">
              {index + 1}
            </span>
            <div className="flex-1 space-y-1">
              <input
                className={rowInputClasses}
                placeholder="e.g. Bachelor's degree in Business, Marketing, or a related field"
                value={row.text}
                maxLength={500}
                onChange={(event) => updateRow(row.key, { text: event.target.value })}
                aria-label={`Education requirement ${index + 1}`}
              />
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                onClick={() => moveRow(index, -1)}
                disabled={index === 0}
                aria-label={`Move education requirement ${index + 1} up`}
              >
                <ArrowUpIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                onClick={() => moveRow(index, 1)}
                disabled={index === educationRequirements.length - 1}
                aria-label={`Move education requirement ${index + 1} down`}
              >
                <ArrowDownIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
                onClick={() => removeRow(row.key)}
                aria-label={`Remove education requirement ${index + 1}`}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <PlusIcon className="h-4 w-4" />
        Add education requirement
      </Button>
    </div>
  );
};

export default EducationRequirementsEditor;
