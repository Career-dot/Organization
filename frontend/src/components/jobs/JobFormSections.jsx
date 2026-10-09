import FormField, { inputClasses } from "../ui/FormField";
import { JOB_FORM_LIMITS } from "../../constants/jobForm";

const {
  TITLE_MIN,
  TITLE_MAX,
  YEARS_MIN,
  YEARS_MAX,
  DESCRIPTION_MAX,
  ANALYSIS_DAYS_MIN,
  ANALYSIS_DAYS_MAX,
  PREFERRED_CANDIDATES_MIN,
  PREFERRED_CANDIDATES_MAX,
  ASSESSMENT_QUESTIONS_MIN,
  ASSESSMENT_QUESTIONS_MAX,
  ASSESSMENT_DURATION_MINUTES_MAX,
} = JOB_FORM_LIMITS;

// Shared scalar-field sections for the Create Job and Edit Draft pages.
// Field order matches the required conceptual order:
//   Title -> Years of Experience -> Description -> (Skills/Tools/Questions,
//   rendered by the pages) -> Job Analysis Days.

export const JobTitleSection = ({ title, onChange, error }) => (
  <FormField label="Job Title" id="job-title" error={error}>
    <input
      id="job-title"
      className={inputClasses}
      placeholder="e.g. Senior Python Developer"
      value={title}
      maxLength={TITLE_MAX}
      onChange={(event) => onChange(event.target.value)}
      required
    />
    <p className="mt-1 text-xs text-slate-500">
      {TITLE_MIN}–{TITLE_MAX} characters. The only field required to save a draft.
    </p>
  </FormField>
);

export const YearsExperienceSection = ({ yearsExperience, onChange, error }) => (
  <FormField label="Years of Experience" id="job-years" error={error}>
    <input
      id="job-years"
      type="number"
      min={YEARS_MIN}
      max={YEARS_MAX}
      className={inputClasses}
      placeholder={`e.g. 3 (${YEARS_MIN}–${YEARS_MAX})`}
      value={yearsExperience}
      onChange={(event) => onChange(event.target.value)}
    />
  </FormField>
);

export const DescriptionSection = ({ description, onChange, error }) => (
  <FormField label="Description" id="job-description" error={error}>
    <textarea
      id="job-description"
      rows={8}
      className={inputClasses}
      placeholder="Describe the role, responsibilities and what a great candidate looks like..."
      value={description}
      maxLength={DESCRIPTION_MAX}
      onChange={(event) => onChange(event.target.value)}
    />
    <p className="mt-1 text-right text-xs text-slate-400">
      {description.length} / {DESCRIPTION_MAX}
    </p>
  </FormField>
);

export const AnalysisDaysSection = ({ analysisDays, onChange, error }) => (
  <FormField label="Job Analysis Days" id="job-analysis-days" error={error}>
    <input
      id="job-analysis-days"
      type="number"
      min={ANALYSIS_DAYS_MIN}
      max={ANALYSIS_DAYS_MAX}
      className={inputClasses}
      placeholder={`e.g. 7 (${ANALYSIS_DAYS_MIN}–${ANALYSIS_DAYS_MAX})`}
      value={analysisDays}
      onChange={(event) => onChange(event.target.value)}
    />
    <p className="mt-1 text-xs text-slate-500">
      Analysis period: {ANALYSIS_DAYS_MIN}–{ANALYSIS_DAYS_MAX} days — how long the analysis runs
      after the job starts (starts on Start, not on draft save).
    </p>
  </FormField>
);

// OPTIONAL top-N prioritization target, deliberately separate from the
// candidate-list ceiling: it never limits, filters or deletes candidates and
// never caps the uploaded Excel (that rule is MAX_CANDIDATES). The backend
// persists it on the Job and re-validates it on every draft write.
export const PreferredCandidateCountSection = ({
  preferredCandidateCount,
  onChange,
  error,
  candidateCount = null,
}) => {
  const numeric = preferredCandidateCount === "" ? null : Number(preferredCandidateCount);
  const exceedsUploaded =
    candidateCount !== null && candidateCount !== undefined && numeric !== null && numeric > candidateCount;

  return (
    <FormField
      label="Preferred Number of Candidates (optional)"
      id="job-preferred-candidates"
      error={error}
    >
      <input
        id="job-preferred-candidates"
        type="number"
        min={PREFERRED_CANDIDATES_MIN}
        max={PREFERRED_CANDIDATES_MAX}
        className={inputClasses}
        placeholder={`e.g. 20 (optional, ${PREFERRED_CANDIDATES_MIN}–${PREFERRED_CANDIDATES_MAX.toLocaleString()})`}
        value={preferredCandidateCount}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="mt-1 text-xs text-slate-500">
        Optional. How many candidates would you prefer to prioritize after analysis? The system
        will prioritize this number of highest-relevance candidates while keeping all candidate
        scores visible. This does not limit the uploaded candidate list.
      </p>
      {exceedsUploaded && (
        <p className="mt-1 text-xs text-amber-700">
          Your preferred number is higher than the {candidateCount} candidate
          {candidateCount === 1 ? "" : "s"} in the uploaded list. All uploaded candidates will
          still be analysed and scored.
        </p>
      )}
    </FormField>
  );
};

// Recruiter-configured AI assessment shape and candidate timer (Job Setup).
// Frontend bounds are UX only — the backend re-validates everything and is
// authoritative (job.validation.js: 1–45 questions, 60–5400 seconds). The
// duration is entered in minutes and converted to whole seconds on save.
export const AssessmentSettingsSection = ({
  assessmentQuestionCount,
  onQuestionCountChange,
  assessmentDurationMinutes,
  onDurationMinutesChange,
}) => {
  const questionValue =
    assessmentQuestionCount === "" || assessmentQuestionCount === null || assessmentQuestionCount === undefined
      ? null
      : Number(assessmentQuestionCount);
  const questionProblem =
    questionValue !== null &&
    (!Number.isInteger(questionValue) ||
      questionValue < ASSESSMENT_QUESTIONS_MIN ||
      questionValue > ASSESSMENT_QUESTIONS_MAX)
      ? `Enter a whole number between ${ASSESSMENT_QUESTIONS_MIN} and ${ASSESSMENT_QUESTIONS_MAX} (maximum: 45).`
      : null;

  const minutesValue =
    assessmentDurationMinutes === "" || assessmentDurationMinutes === null || assessmentDurationMinutes === undefined
      ? null
      : Number(assessmentDurationMinutes);
  const durationProblem =
    minutesValue !== null &&
    (!Number.isInteger(minutesValue) || minutesValue < 1 || minutesValue > ASSESSMENT_DURATION_MINUTES_MAX)
      ? `Enter whole minutes between 1 and ${ASSESSMENT_DURATION_MINUTES_MAX} (maximum: 90 minutes = 5400 seconds).`
      : null;

  return (
    <>
      <FormField
        label="Number of Assessment Questions"
        id="job-assessment-questions"
        error={questionProblem}
      >
        <input
          id="job-assessment-questions"
          type="number"
          min={ASSESSMENT_QUESTIONS_MIN}
          max={ASSESSMENT_QUESTIONS_MAX}
          className={inputClasses}
          placeholder={`e.g. 30 (1–${ASSESSMENT_QUESTIONS_MAX})`}
          value={assessmentQuestionCount ?? ""}
          onChange={(event) => onQuestionCountChange(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate-500">
          How many questions the AI assessment should contain. Maximum: 45. Your typed job
          questions are always included, so this must be at least the number of job questions
          you entered.
        </p>
      </FormField>
      <FormField
        label="Assessment Duration (minutes)"
        id="job-assessment-duration"
        error={durationProblem}
      >
        <input
          id="job-assessment-duration"
          type="number"
          min={1}
          max={ASSESSMENT_DURATION_MINUTES_MAX}
          className={inputClasses}
          placeholder={`e.g. 60 (1–${ASSESSMENT_DURATION_MINUTES_MAX} minutes)`}
          value={assessmentDurationMinutes ?? ""}
          onChange={(event) => onDurationMinutesChange(event.target.value)}
        />
        <p className="mt-1 text-xs text-slate-500">
          Candidate time limit for the assessment once it is started. Maximum: 90 minutes
          (5400 seconds). This is separate from the job analysis period above.
        </p>
      </FormField>
    </>
  );
};
