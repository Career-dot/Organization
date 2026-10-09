// Form-state helpers shared by the Create Job and Edit Draft pages.
//
// Local row shape: { key, name?, weight?, question? } where `key` is a
// client-only React identity. `sortOrder` is NEVER stored or sent as a
// user-controlled value — it is derived from array order at serialization
// time, matching the backend (sortOrder = array index).

// Row factories live here (not in the editor components) so component files
// export only components (react-refresh/only-export-components) and there is
// no util→component import cycle. Keys are per-session unique identifiers
// used solely as React list keys.
let rowSeq = 0;
const nextRowKey = (prefix) => {
  rowSeq += 1;
  return `${prefix}-${rowSeq}-${Date.now()}`;
};

export const makeSkillRow = () => ({ key: nextRowKey("skill"), name: "", weight: "" });
export const makeToolRow = () => ({ key: nextRowKey("tool"), name: "" });
export const makeQuestionRow = () => ({ key: nextRowKey("question"), question: "" });
export const makeResponsibilityRow = () => ({ key: nextRowKey("responsibility"), text: "" });
export const makeEducationRequirementRow = () => ({ key: nextRowKey("educationRequirement"), text: "" });

// Strips empty rows, trims values and derives sortOrder from array order.
// Numeric fields: "" / invalid -> omitted entirely (draft partiality).
export const buildDraftPayload = ({
  title,
  yearsExperience,
  description,
  analysisDays,
  preferredCandidateCount,
  assessmentQuestionCount,
  assessmentDurationMinutes,
  skills,
  tools,
  questions,

  employmentType,
  workMode,
  location,
  responsibilities,
  educationRequirements,
}) => {
  const payload = { title: title.trim() };

  const years = Number(yearsExperience);
  if (yearsExperience !== "" && yearsExperience !== null && yearsExperience !== undefined && Number.isInteger(years)) {
    payload.yearsExperience = years;
  }

  if (description.trim().length > 0) {
    payload.description = description.trim();
  }

  // Structured-job scalars. Omitted when unset (create partiality: absent =
  // "leave unset"); sent only when the recruiter actually chose/typed a value.
  if (employmentType) {
    payload.employmentType = employmentType;
  }
  if (workMode) {
    payload.workMode = workMode;
  }
  if (location && location.trim().length > 0) {
    payload.location = location.trim();
  }

  const days = Number(analysisDays);
  if (analysisDays !== "" && analysisDays !== null && analysisDays !== undefined && Number.isInteger(days)) {
    payload.analysisDays = days;
  }

  // Optional: only sent when the recruiter actually typed a whole number.
  const preferred = Number(preferredCandidateCount);
  if (
    preferredCandidateCount !== "" &&
    preferredCandidateCount !== null &&
    preferredCandidateCount !== undefined &&
    Number.isInteger(preferred)
  ) {
    payload.preferredCandidateCount = preferred;
  }

  // Assessment settings: optional whole numbers. The duration is entered in
  // minutes (UI) and persisted as whole seconds — the backend's canonical
  // unit. Bounds (45 questions, 1–90 minutes) are UX hints; the backend
  // rejects out-of-range values authoritatively.
  const questionCountNum = Number(assessmentQuestionCount);
  if (
    assessmentQuestionCount !== "" &&
    assessmentQuestionCount !== null &&
    assessmentQuestionCount !== undefined &&
    Number.isInteger(questionCountNum)
  ) {
    payload.assessmentQuestionCount = questionCountNum;
  }
  const durationMinutesNum = Number(assessmentDurationMinutes);
  if (
    assessmentDurationMinutes !== "" &&
    assessmentDurationMinutes !== null &&
    assessmentDurationMinutes !== undefined &&
    Number.isInteger(durationMinutesNum)
  ) {
    payload.assessmentDurationSeconds = durationMinutesNum * 60;
  }

  const cleanSkills = skills
    .filter((row) => row.name.trim().length > 0 && row.weight !== "")
    .map((row, index) => ({ name: row.name.trim(), weight: Number(row.weight), sortOrder: index }));
  if (skills.length > 0) {
    payload.skills = cleanSkills;
  }

  const cleanTools = tools
    .filter((row) => row.name.trim().length > 0)
    .map((row, index) => ({ name: row.name.trim(), sortOrder: index }));
  if (tools.length > 0) {
    payload.tools = cleanTools;
  }

  const cleanQuestions = questions
    .filter((row) => row.question.trim().length > 0)
    .map((row, index) => ({ question: row.question.trim(), sortOrder: index }));
  if (questions.length > 0) {
    payload.questions = cleanQuestions;
  }

  // Structured rows are optional and optional before Start. The backend
  // re-derives sortOrder from array position; the frontend does the same.
  const cleanResponsibilities = responsibilities
    .filter((row) => row.text.trim().length > 0)
    .map((row, index) => ({ text: row.text.trim(), sortOrder: index }));
  if (responsibilities.length > 0) {
    payload.responsibilities = cleanResponsibilities;
  }

  const cleanEducationRequirements = educationRequirements
    .filter((row) => row.text.trim().length > 0)
    .map((row, index) => ({ text: row.text.trim(), sortOrder: index }));
  if (educationRequirements.length > 0) {
    payload.educationRequirements = cleanEducationRequirements;
  }

  return payload;
};

const toNumericInput = (value) =>
  value === null || value === undefined ? "" : String(value);

// Maps a GET /job/:jobId response onto editable local row state.
export const jobToFormState = (job) => ({
  title: job?.title ?? "",
  yearsExperience: toNumericInput(job?.yearsExperience),
  description: job?.description ?? "",
  analysisDays: toNumericInput(job?.analysisDays),
  preferredCandidateCount: toNumericInput(job?.preferredCandidateCount),
  assessmentQuestionCount: toNumericInput(job?.assessmentQuestionCount),
  // Persisted as whole seconds; shown/edited as minutes.
  assessmentDurationMinutes:
    job?.assessmentDurationSeconds == null ? "" : String(job.assessmentDurationSeconds / 60),
  skills: (job?.skills ?? []).map((skill) => ({ ...makeSkillRow(), name: skill.name, weight: String(skill.weight) })),
  tools: (job?.tools ?? []).map((tool) => ({ ...makeToolRow(), name: tool.name })),
  questions: (job?.questions ?? []).map((question) => ({ ...makeQuestionRow(), question: question.question })),
  // Structured-job scalars. A legacy job has all three null; the select
  // controls coerce null/"" to their "No preference" option, and the WYSIWYG
  // edit payload sends an empty string back as null (no change on the server).
  employmentType: job?.employmentType ?? "",
  workMode: job?.workMode ?? "",
  location: job?.location ?? "",
  // `createdAt` is carried purely so the readiness checklist can tell a legacy
  // job from a structured one — it is never sent back to the backend.
  createdAt: job?.createdAt ?? null,
  // Structured rows are read from the persisted job with a fresh client-side
  // key; the detail page keeps them editable. `sortOrder` is derived from
  // array position at serialization time (jobFormState.js).
  responsibilities: (job?.responsibilities ?? []).map((row) => ({
    ...makeResponsibilityRow(),
    text: row.text,
  })),
  educationRequirements: (job?.educationRequirements ?? []).map((row) => ({
    ...makeEducationRequirementRow(),
    text: row.text,
  })),
});


// Empty form state for the Create page.
export const emptyFormState = () => ({
  title: "",
  yearsExperience: "",
  description: "",
  analysisDays: "",
  preferredCandidateCount: "",
  assessmentQuestionCount: "",
  assessmentDurationMinutes: "",
  skills: [],
  tools: [],
  questions: [],
  // Structured-job fields. A brand-new draft is always a "structured" job (its
  // createdAt is now), so these default to empty/optional; the backend still
  // only gates them at Start. `createdAt` is null until the draft is saved.
  employmentType: "",
  workMode: "",
  location: "",
  responsibilities: [],
  educationRequirements: [],
  createdAt: null,
});

// WYSIWYG edit payload for the draft editor. Unlike buildDraftPayload (the
// create-page builder, where omitted = "leave unset"), the edit page shows
// the FULL current state, so:
//   * cleared scalars are sent as null (omitting them would keep the old
//     value on the server and desync the readiness checklist),
//   * every child collection is ALWAYS sent — an empty array clears the
//     section, matching what the recruiter sees on screen.
// Backend remains authoritative (updateDraftSchema accepts null scalars and
// replaces arrays it receives).
export const buildEditPayload = (form) => ({
  title: form.title.trim(),
  yearsExperience: form.yearsExperience === "" ? null : Number(form.yearsExperience),
  description: form.description.trim() || null,
  analysisDays: form.analysisDays === "" ? null : Number(form.analysisDays),
  // Optional: cleared input is sent as null (explicit "no preference").
  preferredCandidateCount:
    form.preferredCandidateCount === "" || form.preferredCandidateCount === null
      ? null
      : Number(form.preferredCandidateCount),
  // Assessment settings: cleared input is sent as null (explicit "unset").
  // The duration is edited in minutes and sent as whole seconds.
  assessmentQuestionCount:
    form.assessmentQuestionCount === "" || form.assessmentQuestionCount === null
      ? null
      : Number(form.assessmentQuestionCount),
  assessmentDurationSeconds:
    form.assessmentDurationMinutes === "" || form.assessmentDurationMinutes === null
      ? null
      : Number(form.assessmentDurationMinutes) * 60,
  // Structured-job scalars. WYSIWYG: an unset (empty) select/input is sent as
  // null so the server clears it, matching every other cleared field here. The
  // backend accepts null (draft partiality) and only requires these at Start.
  employmentType: form.employmentType || null,
  workMode: form.workMode || null,
  location: form.location.trim() || null,
  skills: form.skills
    .filter(
      (row) => row.name.trim() && row.weight !== "" && Number.isInteger(Number(row.weight))
    )
    .map((row, index) => ({ name: row.name.trim(), weight: Number(row.weight), sortOrder: index })),
  tools: form.tools
    .filter((row) => row.name.trim())
    .map((row, index) => ({ name: row.name.trim(), sortOrder: index })),
  questions: form.questions
    .filter((row) => row.question.trim())
    .map((row, index) => ({ question: row.question.trim(), sortOrder: index })),
  // Structured rows are always sent on edit: an empty array clears the rows,
  // and the backend re-derives sortOrder from array position.
  responsibilities: form.responsibilities
    .filter((row) => row.text.trim().length > 0)
    .map((row, index) => ({ text: row.text.trim(), sortOrder: index })),
  educationRequirements: form.educationRequirements
    .filter((row) => row.text.trim().length > 0)
    .map((row, index) => ({ text: row.text.trim(), sortOrder: index })),
});
