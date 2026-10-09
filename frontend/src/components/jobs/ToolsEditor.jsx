import Button from "../ui/Button";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { JOB_FORM_LIMITS } from "../../constants/jobForm";
// Row factories live in utils/jobFormState.js so this component file exports
// only components (react-refresh/only-export-components).
import { makeToolRow } from "../../utils/jobFormState";

const { MAX_TOOLS } = JOB_FORM_LIMITS;

// Relational tool rows: { key, name } — sortOrder derives from array order.

const rowInputClasses =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15";

const ToolsEditor = ({ tools, onChange }) => {
  const updateRow = (key, patch) =>
    onChange(tools.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const removeRow = (key) => onChange(tools.filter((row) => row.key !== key));

  const moveRow = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= tools.length) return;
    const next = [...tools];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const duplicateNames = (() => {
    const seen = new Set();
    const duplicates = new Set();
    tools.forEach((row) => {
      const name = row.name.trim().toLowerCase();
      if (!name) return;
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    });
    return duplicates;
  })();

  const atLimit = tools.length >= MAX_TOOLS;

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Tools, frameworks and software the candidate is expected to work with.
      </p>

      {tools.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
          <p className="text-sm font-medium text-slate-700">No tools or software yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add at least one tool before starting this job.
          </p>
        </div>
      )}

      {tools.map((row, index) => {
        const nameDuplicate = duplicateNames.has(row.name.trim().toLowerCase());

        return (
          <div
            key={row.key}
            className={`rounded-xl border bg-white p-3 shadow-sm ${
              nameDuplicate ? "border-red-300" : "border-slate-200"
            }`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <span className="hidden w-6 shrink-0 text-center text-xs font-semibold text-slate-400 sm:block">
                {index + 1}
              </span>
              <input
                className={rowInputClasses}
                placeholder="Tool or software (e.g. Docker)"
                value={row.name}
                maxLength={100}
                onChange={(event) => updateRow(row.key, { name: event.target.value })}
                aria-label={`Tool ${index + 1} name`}
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                  onClick={() => moveRow(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move tool ${index + 1} up`}
                >
                  <ArrowUpIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                  onClick={() => moveRow(index, 1)}
                  disabled={index === tools.length - 1}
                  aria-label={`Move tool ${index + 1} down`}
                >
                  <ArrowDownIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
                  onClick={() => removeRow(row.key)}
                  aria-label={`Remove tool ${index + 1}`}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            {nameDuplicate && (
              <p className="mt-1.5 text-sm text-red-600">Duplicate tool name</p>
            )}
          </div>
        );
      })}

      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...tools, makeToolRow()])} disabled={atLimit}>
        <PlusIcon className="h-4 w-4" />
        {atLimit ? `Maximum of ${MAX_TOOLS} tools reached` : "Add tool"}
      </Button>
    </div>
  );
};

export default ToolsEditor;
