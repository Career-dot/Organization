import Button from "../ui/Button";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { JOB_FORM_LIMITS } from "../../constants/jobForm";
// Row factories live in utils/jobFormState.js so this component file exports
// only components (react-refresh/only-export-components).
import { makeSkillRow } from "../../utils/jobFormState";

const { SKILL_WEIGHT_MIN, SKILL_WEIGHT_MAX, TOTAL_SKILL_WEIGHT, MAX_SKILLS } = JOB_FORM_LIMITS;

// Relational skill rows: { key, name, weight }. `key` is a client-only
// stable row identity for React — sortOrder is derived from array order at
// serialization time (in the page), never from user input.

const rowInputClasses =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15";

const SkillsEditor = ({ skills, onChange, errors = {} }) => {
  const updateRow = (key, patch) =>
    onChange(skills.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const removeRow = (key) => onChange(skills.filter((row) => row.key !== key));

  const moveRow = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= skills.length) return;
    const next = [...skills];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const addRow = () => {
    if (skills.length >= MAX_SKILLS) return;
    onChange([...skills, makeSkillRow()]);
  };

  // Live total from current local state; only real numbers count.
  const totalWeight = skills.reduce((sum, row) => {
    const weight = Number(row.weight);
    return Number.isFinite(weight) ? sum + weight : sum;
  }, 0);
  const totalIsExact = skills.length > 0 && totalWeight === TOTAL_SKILL_WEIGHT;
  const totalIsOver = totalWeight > TOTAL_SKILL_WEIGHT;

  const duplicateNames = (() => {
    const seen = new Set();
    const duplicates = new Set();
    skills.forEach((row) => {
      const name = row.name.trim().toLowerCase();
      if (!name) return;
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    });
    return duplicates;
  })();

  const atLimit = skills.length >= MAX_SKILLS;
  const totalBadgeClasses = totalIsExact
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : totalIsOver
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Add the skills this job requires and how much each one matters. Weights must add up to
          exactly {TOTAL_SKILL_WEIGHT}.
        </p>
        <span
          className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${totalBadgeClasses}`}
        >
          Total weight: {totalWeight} / {TOTAL_SKILL_WEIGHT}
          {totalIsExact && " ✓"}
        </span>
      </div>

      {skills.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
          <p className="text-sm font-medium text-slate-700">No skills yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add at least one skill before starting this job.
          </p>
        </div>
      )}

      {skills.map((row, index) => (
        <SkillRow
          key={row.key}
          row={row}
          index={index}
          count={skills.length}
          duplicate={duplicateNames.has(row.name.trim().toLowerCase())}
          errors={errors}
          onUpdate={(patch) => updateRow(row.key, patch)}
          onRemove={() => removeRow(row.key)}
          onMove={(direction) => moveRow(index, direction)}
        />
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={atLimit}>
        <PlusIcon className="h-4 w-4" />
        {atLimit ? `Maximum of ${MAX_SKILLS} skills reached` : "Add skill"}
      </Button>
    </div>
  );
};


const SkillRow = ({ row, index, count, duplicate, errors, onUpdate, onRemove, onMove }) => {
  const weight = Number(row.weight);
  const weightInvalid =
    row.weight !== "" &&
    (!Number.isInteger(weight) || weight < SKILL_WEIGHT_MIN || weight > SKILL_WEIGHT_MAX);
  const rowError = errors[row.key] ?? (duplicate ? "Duplicate skill name" : undefined);

  return (
    <div
      className={`rounded-xl border bg-white p-3 shadow-sm ${
        rowError || weightInvalid ? "border-red-300" : "border-slate-200"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <span className="hidden w-6 shrink-0 pt-2 text-center text-xs font-semibold text-slate-400 sm:block">
          {index + 1}
        </span>
        <input
          className={rowInputClasses}
          placeholder="Skill name (e.g. Python)"
          value={row.name}
          maxLength={100}
          onChange={(event) => onUpdate({ name: event.target.value })}
          aria-label={`Skill ${index + 1} name`}
        />
        <input
          type="number"
          min={SKILL_WEIGHT_MIN}
          max={SKILL_WEIGHT_MAX}
          className={`${rowInputClasses} sm:w-28 ${weightInvalid ? "border-red-400" : ""}`}
          placeholder="Weight"
          value={row.weight}
          onChange={(event) => onUpdate({ weight: event.target.value })}
          aria-label={`Skill ${index + 1} weight (1-${SKILL_WEIGHT_MAX})`}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move skill ${index + 1} up`}
          >
            <ArrowUpIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            aria-label={`Move skill ${index + 1} down`}
          >
            <ArrowDownIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
            onClick={onRemove}
            aria-label={`Remove skill ${index + 1}`}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      {(rowError || weightInvalid) && (
        <p className="mt-1.5 text-sm text-red-600">
          {rowError ??
            `Weight must be a whole number between ${SKILL_WEIGHT_MIN} and ${SKILL_WEIGHT_MAX}`}
        </p>
      )}
    </div>
  );
};

export default SkillsEditor;
