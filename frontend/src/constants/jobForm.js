// Frontend UX/display constants for the Job Creation module.
//
// These mirror the documented backend contract (backend/src/module/job) for
// immediate client-side feedback only. The backend remains authoritative —
// never add or tighten a rule here that would block a payload the backend
// accepts (e.g. an incomplete draft).

// Structured-job scalars enforced by the backend (new Job columns + child rows).
// The enum VALUES are the authoritative backend contract; the frontend uses these
// constants only to render the choice controls and to validate the payload before
// transit. The backend remains authoritative — never add or tighten a rule here
// that would block a payload the backend accepts (e.g. an incomplete draft).
export const EMPLOYMENT_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACT",
  "INTERNSHIP",
  "TEMPORARY",
];

export const WORK_MODES = ["REMOTE", "HYBRID", "ON_SITE"];

// Framed labels match the backend's own naming so the UI reads identically to the API.
export const JOB_STRUCTURED_FIELDS = {
  EMPLOYMENT_TYPE: "Employment type",
  WORK_MODE: "Work mode",
  LOCATION: "Location",
};

// Frontend mirror of the backend's STRUCTURED_JOB_CUTOFF (job.service.js). A job
// created at/after this UTC instant is a "structured" job and must carry
// employmentType + workMode (plus a location for HYBRID/ON_SITE) before Start;
// a job created before it is LEGACY and starts under the original rules forever.
// Used ONLY for the client-side readiness checklist — the backend re-validates
// authoritatively. Kept identical to the backend constant on purpose.
export const STRUCTURED_JOB_CUTOFF = "2026-10-07T00:00:00.000Z";

// UX-only: does this job follow the structured Start rules? Based purely on
// createdAt, exactly like the backend — never on whether fields happen to be
// null, so a legacy job with empty structured fields still shows as ready.
export const isStructuredJob = (createdAt) =>
  !!createdAt && new Date(createdAt).getTime() >= new Date(STRUCTURED_JOB_CUTOFF).getTime();

export const JOB_FORM_LIMITS = {
  TITLE_MIN: 3,
  TITLE_MAX: 200,
  YEARS_MIN: 0,
  YEARS_MAX: 50,
  DESCRIPTION_MAX: 20000,
  ANALYSIS_DAYS_MIN: 1,
  ANALYSIS_DAYS_MAX: 10,
  SKILL_WEIGHT_MIN: 1,
  SKILL_WEIGHT_MAX: 100,
  TOTAL_SKILL_WEIGHT: 100,
  MAX_SKILLS: 50,
  MAX_TOOLS: 50,
  MAX_QUESTIONS: 50,
  QUESTION_MIN: 5,
  QUESTION_MAX: 2000,
  // Candidate Excel Sheet: at most 1,000 candidates per job. The backend
  // re-parses the stored file at Start and is authoritative.
  MAX_CANDIDATES: 1000,
  // Preferred Number of Candidates is OPTIONAL and is a prioritization target
  // (top-N after candidate analysis), never a limit: it does not filter, hide
  // or delete candidates, and it does not cap the uploaded list (that stays
  // MAX_CANDIDATES). The backend bounds it to the same 1..1,000 range.
  PREFERRED_CANDIDATES_MIN: 1,
  PREFERRED_CANDIDATES_MAX: 1000,
  // Assessment Settings (Job Setup): the recruiter-configured AI assessment
  // shape and candidate timer. Backend hard limits (job.validation.js): at
  // most 45 questions; the timer is whole seconds between 60 and 5400
  // (90 minutes). Frontend values here are UX only — the backend is
  // authoritative and rejects anything beyond these bounds.
  ASSESSMENT_QUESTIONS_MIN: 1,
  ASSESSMENT_QUESTIONS_MAX: 45,
  ASSESSMENT_DURATION_MINUTES_MAX: 90, // = 5400 seconds
  ASSESSMENT_DURATION_SECONDS_MIN: 60,
  ASSESSMENT_DURATION_SECONDS_MAX: 5400,
};

export const JOB_STATUS = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  CLOSED: "CLOSED",
};

export const JOB_STATUS_BADGES = {
  DRAFT: {
    label: "Draft",
    classes: "bg-slate-100 text-slate-700 border-slate-200",
  },
  ACTIVE: {
    label: "Active",
    classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  CLOSED: {
    label: "Closed",
    classes: "bg-rose-50 text-rose-700 border-rose-200",
  },
};

export const JOB_CLOSED_REASON_LABELS = {
  RECRUITER_CLOSED: "Closed by recruiter",
  SYSTEM_EXPIRED: "Analysis period ended",
};

// Checks the start-readiness rules client-side so the UI can show a
// checklist and disable the Start action. Returns { ready, problems[] }.
// This is UX only — the backend re-validates everything on POST /start.
export const evaluateJobStartReadiness = (job) => {
  const problems = [];
  const skills = Array.isArray(job?.skills) ? job.skills : [];
  const tools = Array.isArray(job?.tools) ? job.tools : [];
  const questions = Array.isArray(job?.questions) ? job.questions : [];
  const { SKILL_WEIGHT_MIN, SKILL_WEIGHT_MAX, TOTAL_SKILL_WEIGHT, ANALYSIS_DAYS_MIN, ANALYSIS_DAYS_MAX } =
    JOB_FORM_LIMITS;

  if (!job?.title || job.title.trim().length < JOB_FORM_LIMITS.TITLE_MIN) {
    problems.push("Title (at least 3 characters)");
  }
  if (job?.yearsExperience === null || job?.yearsExperience === undefined) {
    problems.push("Years of experience");
  }
  if (!job?.description || job.description.trim().length < 20) {
    problems.push("Description (at least 20 characters)");
  }
  if (skills.length === 0) {
    problems.push("At least one skill");
  }
  const totalWeight = skills.reduce((sum, skill) => sum + (Number(skill.weight) || 0), 0);
  if (
    skills.length > 0 &&
    skills.some(
      (skill) =>
        Number(skill.weight) < SKILL_WEIGHT_MIN || Number(skill.weight) > SKILL_WEIGHT_MAX
    )
  ) {
    problems.push(`Every skill weight between ${SKILL_WEIGHT_MIN} and ${SKILL_WEIGHT_MAX}`);
  } else if (skills.length > 0 && totalWeight !== TOTAL_SKILL_WEIGHT) {
    problems.push(`Skill weights adding up to exactly ${TOTAL_SKILL_WEIGHT}`);
  }
  if (tools.length === 0) {
    problems.push("At least one tool or software entry");
  }
  if (questions.length === 0) {
    problems.push("At least one job-related question");
  }
  if (
    job?.analysisDays === null ||
    job?.analysisDays === undefined ||
    job.analysisDays < ANALYSIS_DAYS_MIN ||
    job.analysisDays > ANALYSIS_DAYS_MAX
  ) {
    problems.push(`Analysis days between ${ANALYSIS_DAYS_MIN} and ${ANALYSIS_DAYS_MAX}`);
  }
  // The Candidate Excel Sheet is REQUIRED before Start. The backend enforces
  // this authoritatively (re-parsing the stored file before any quota is
  // consumed); this mirror only gives the recruiter the early checklist item.
  if (!job?.candidateList) {
    problems.push("Candidate Excel sheet (required before start)");
  }

  // Structured-job rules (UX mirror of the backend's Phase 2 Start checks).
  // Applied ONLY to jobs created at/after the deployment cutoff — a legacy job
  // (createdAt before cutoff) keeps the original readiness rules and is NEVER
  // blocked by missing structured metadata. Responsibilities/education are
  // optional and are NOT Start blockers, so they are intentionally absent here.
  if (isStructuredJob(job?.createdAt)) {
    if (!job?.employmentType) {
      problems.push("Employment type");
    }
    if (!job?.workMode) {
      problems.push("Work mode");
    }
    if ((job?.workMode === "HYBRID" || job?.workMode === "ON_SITE") && !job?.location?.trim()) {
      problems.push("Location (required for hybrid or on-site jobs)");
    }
  }

  return { ready: problems.length === 0, problems };
};
