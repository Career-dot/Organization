import FormField, { inputClasses } from "../ui/FormField";
import {
  EMPLOYMENT_TYPES,
  WORK_MODES,
  JOB_STRUCTURED_FIELDS,
} from "../../constants/jobForm";

const selectClasses =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/15";

// Shared scalar fields for the draft create/edit form: employment type,
// work mode and location. The backend is authoritative for the Start rules
// (location is required before starting a hybrid or on-site job); the UI only
// mirrors that requirement so the recruiter sees it early.
export const JobOverviewSection = ({
  employmentType,
  workMode,
  location,
  onEmploymentTypeChange,
  onWorkModeChange,
  onLocationChange,
}) => {
  return (
    <div className="space-y-5">
      <FormField label={JOB_STRUCTURED_FIELDS.EMPLOYMENT_TYPE} id="job-employment-type">
        <select
          id="job-employment-type"
          className={selectClasses}
          value={employmentType ?? ""}
          onChange={(event) => onEmploymentTypeChange(event.target.value)}
        >
          <option value="">No preference</option>
          {EMPLOYMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label={JOB_STRUCTURED_FIELDS.WORK_MODE} id="job-work-mode">
        <select
          id="job-work-mode"
          className={selectClasses}
          value={workMode ?? ""}
          onChange={(event) => onWorkModeChange(event.target.value)}
        >
          <option value="">No preference</option>
          {WORK_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </FormField>

      <FormField
        label={JOB_STRUCTURED_FIELDS.LOCATION}
        id="job-location"
        error={undefined}
      >
        <input
          id="job-location"
          className={inputClasses}
          placeholder="e.g. Warsaw, Poland"
          maxLength={200}
          value={location ?? ""}
          onChange={(event) => onLocationChange(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate-500">
          {workMode === "HYBRID" || workMode === "ON_SITE"
            ? "Required before the job can be started in hybrid or on-site mode."
            : "Optional. Leave empty for a remote-only job."}
        </p>
      </FormField>
    </div>
  );
};

export default JobOverviewSection;
