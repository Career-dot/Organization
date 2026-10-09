const { z } = require("zod");

// ---------------------------------------------------------------------------
// Job module validation (zod).
//
// Two distinct validation contexts:
//   * DRAFT create/update — the title is the only hard requirement
//     (D3: minimum 3 characters). Everything else may be incomplete; drafts
//     never consume quota.
//   * START — no HTTP-body schema: Start validates the SAVED job
//     (job.service.assertJobReadyToStart), including the
//     skill-weights-total-exactly-100 rule.
// ---------------------------------------------------------------------------

const MAX_CHILD_ITEMS = 50; // D5
const MAX_DESCRIPTION_LENGTH = 20000; // D5

// --- Assessment configuration hard limits (platform rules) ------------------
// The ONE backend source of truth for how large an assessment may be:
//   * at most 45 questions
//   * at most 5400 seconds (90 minutes) of candidate time, at least 60 seconds
// Mirrored by the AI contract (typeof in aiJob.validation.js, FastAPI schemas.py
// and the assessment-generation prompt) and by the frontend UX constants in
// frontend/src/constants/jobForm.js. The backend stays authoritative: no
// frontend, API caller or AI response may exceed these values.
const MAX_ASSESSMENT_QUESTIONS = 45;
const MIN_ASSESSMENT_DURATION_SECONDS = 60;
const MAX_ASSESSMENT_DURATION_SECONDS = 5400; // 90 minutes

// The recruiter's preferred number of candidates (top-N priority target) is
// bounded by the same ceiling as the candidate list itself: a job can never
// hold more than 1,000 candidates, so "prioritize more than 1,000" is
// meaningless. It is NOT a candidate limit — the uploaded list stays whole and
// every candidate keeps its relevance score regardless of this value.
const MAX_PREFERRED_CANDIDATES = 1000;

const titleField = z
  .string({ message: "Job title is required" })
  .trim()
  .min(3, "Job title must be at least 3 characters")
  .max(200, "Job title must be at most 200 characters");

const yearsExperienceField = z
  .number({ message: "Years of experience must be a number" })
  .int("Years of experience must be a whole number")
  .min(0, "Years of experience cannot be negative")
  .max(50, "Years of experience cannot exceed 50");

const descriptionField = z
  .string({ message: "Job description must be text" })
  .trim()
  .max(
    MAX_DESCRIPTION_LENGTH,
    `Job description must be at most ${MAX_DESCRIPTION_LENGTH} characters`
  );

const analysisDaysField = z
  .number({ message: "Analysis days must be a number" })
  .int("Analysis days must be a whole number")
  .min(1, "Analysis days must be at least 1")
  .max(10, "Analysis days must be at most 10");

// Optional top-N priority target. Omitted/null = "no preference" and is always
// valid; when provided it must be a whole number >= 1 (no zero, no negatives,
// no decimals, no non-numeric input).
const preferredCandidateCountField = z
  .number({ message: "Preferred number of candidates must be a number" })
  .int("Preferred number of candidates must be a whole number")
  .min(1, "Preferred number of candidates must be at least 1")
  .max(
    MAX_PREFERRED_CANDIDATES,
    `Preferred number of candidates must be at most ${MAX_PREFERRED_CANDIDATES}`
  );

// Recruiter-selected assessment configuration, captured at job setup. Both are
// OPTIONAL (null = legacy/unset), but when provided they are bounded by the hard
// platform limits above — the backend, not the form, decides what is legal.
// assessmentQuestionCount: how many questions the generated assessment should
// contain. The service additionally requires it to be at least the number of
// mandatory recruiter JobQuestions (preservation is never traded for a count).
const assessmentQuestionCountField = z
  .number({ message: "Number of assessment questions must be a number" })
  .int("Number of assessment questions must be a whole number")
  .min(1, "Number of assessment questions must be at least 1")
  .max(
    MAX_ASSESSMENT_QUESTIONS,
    `Number of assessment questions must be at most ${MAX_ASSESSMENT_QUESTIONS}`
  );

const assessmentConfiguredDurationField = z
  .number({ message: "Assessment duration must be a number" })
  .int("Assessment duration must be a whole number")
  .min(
    MIN_ASSESSMENT_DURATION_SECONDS,
    `Assessment duration must be at least ${MIN_ASSESSMENT_DURATION_SECONDS} seconds`
  )
  .max(
    MAX_ASSESSMENT_DURATION_SECONDS,
    `Assessment duration must be at most ${MAX_ASSESSMENT_DURATION_SECONDS} seconds (90 minutes)`
  );

const skillField = z.object({
  name: z
    .string({ message: "Skill name is required" })
    .trim()
    .min(1, "Skill name is required")
    .max(100, "Skill name must be at most 100 characters"),
  // D4: 1-100. A 0-weight skill would be meaningless padding against the
  // total-100 rule, so it is rejected at the boundary.
  weight: z
    .number({ message: "Skill weight must be a number" })
    .int("Skill weight must be a whole number")
    .min(1, "Skill weight must be at least 1")
    .max(100, "Skill weight must be at most 100"),
});

const toolField = z.object({
  name: z
    .string({ message: "Tool name is required" })
    .trim()
    .min(1, "Tool name is required")
    .max(100, "Tool name must be at most 100 characters"),
});

const questionField = z.object({
  question: z
    .string({ message: "Job question is required" })
    .trim()
    .min(5, "Job question must be at least 5 characters")
    .max(2000, "Job question must be at most 2000 characters"),
});

const noDuplicateNames = (items) => {
  const names = items.map((item) => item.name.toLowerCase());
  return new Set(names).size === names.length;
};

const skillsField = z
  .array(skillField, { message: "Skills must be a list" })
  .max(MAX_CHILD_ITEMS, `A job can have at most ${MAX_CHILD_ITEMS} skills`)
  .refine(noDuplicateNames, { message: "Duplicate skill names are not allowed" });

const toolsField = z
  .array(toolField, { message: "Tools must be a list" })
  .max(MAX_CHILD_ITEMS, `A job can have at most ${MAX_CHILD_ITEMS} tools`)
  .refine(noDuplicateNames, { message: "Duplicate tool names are not allowed" });

const questionsField = z
  .array(questionField, { message: "Questions must be a list" })
  .max(MAX_CHILD_ITEMS, `A job can have at most ${MAX_CHILD_ITEMS} questions`);

// ---------------------------------------------------------------------------
// Phase 2 — structured job requirements (Phase 1 database columns).
//
// Scalars are NULLABLE in the draft schemas on purpose: legacy jobs and
// partial drafts must stay valid. Whether employmentType/workMode/location are
// REQUIRED is decided only at Start by job.service.assertJobReadyToStart,
// against the STRUCTURED_JOB_CUTOFF — never here.
//
// The child arrays follow the exact skills/tools/questions conventions:
// bounded list of plain rows, sortOrder is NEVER client-supplied (the
// repository derives it from array position), replaced wholesale whenever
// present (empty array = clear all) and untouched when absent.
// ---------------------------------------------------------------------------

const MAX_RESPONSIBILITIES = 30;
const MAX_EDUCATION_REQUIREMENTS = 10;

const employmentTypeField = z.enum(
  ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"],
  {
    message:
      "Employment type must be FULL_TIME, PART_TIME, CONTRACT, INTERNSHIP or TEMPORARY",
  }
);

const workModeField = z.enum(["REMOTE", "HYBRID", "ON_SITE"], {
  message: "Work mode must be REMOTE, HYBRID or ON_SITE",
});

const locationField = z
  .string({ message: "Location must be text" })
  .trim()
  .max(200, "Location must be at most 200 characters");

const responsibilityField = z.object({
  text: z
    .string({ message: "Responsibility is required" })
    .trim()
    .min(5, "Responsibility must be at least 5 characters")
    .max(1000, "Responsibility must be at most 1000 characters"),
});

const educationRequirementField = z.object({
  text: z
    .string({ message: "Education requirement is required" })
    .trim()
    .min(5, "Education requirement must be at least 5 characters")
    .max(500, "Education requirement must be at most 500 characters"),
});

const responsibilitiesField = z
  .array(responsibilityField, { message: "Responsibilities must be a list" })
  .max(
    MAX_RESPONSIBILITIES,
    `A job can have at most ${MAX_RESPONSIBILITIES} responsibilities`
  );

const educationRequirementsField = z
  .array(educationRequirementField, { message: "Education requirements must be a list" })
  .max(
    MAX_EDUCATION_REQUIREMENTS,
    `A job can have at most ${MAX_EDUCATION_REQUIREMENTS} education requirements`
  );

// Draft payloads. Scalar fields accept explicit null so a client can clear
// them; the children arrays reject null and are replaced wholesale whenever
// present (absent = untouched).
const draftJobFields = {
  title: titleField,
  yearsExperience: yearsExperienceField.nullish(),
  description: descriptionField.nullish(),
  analysisDays: analysisDaysField.nullish(),
  // Optional: null (or absent) clears it, matching the other nullable scalars.
  preferredCandidateCount: preferredCandidateCountField.nullish(),
  // Recruiter's requested assessment configuration. Same nullish semantics:
  // absent = untouched, null = cleared (falls back to legacy behaviour).
  assessmentQuestionCount: assessmentQuestionCountField.nullish(),
  assessmentDurationSeconds: assessmentConfiguredDurationField.nullish(),
  skills: skillsField.optional(),
  tools: toolsField.optional(),
  questions: questionsField.optional(),
  // Phase 2 — structured job requirements. Scalars are nullish (null = clear,
  // absent = untouched/unset); the child arrays follow the replace semantics
  // described above (empty array = clear all, absent = untouched).
  employmentType: employmentTypeField.nullish(),
  workMode: workModeField.nullish(),
  location: locationField.nullish(),
  responsibilities: responsibilitiesField.optional(),
  educationRequirements: educationRequirementsField.optional(),
};

const createDraftSchema = z.object(draftJobFields);

// Updates may omit any field. The title stays a plain optional string (null
// would clear a NOT NULL column, so it is rejected rather than nullish).
const updateDraftSchema = z.object({
  ...draftJobFields,
  title: titleField.optional(),
});

// ---------------------------------------------------------------------------
// AI workflow validation (clarification-question edits + assessment edits)
// ---------------------------------------------------------------------------

// The AI contract caps clarification questions at 50 — the same ceiling the
// worker validates live AI output against.
const MAX_CLARIFICATION_QUESTIONS = 50;

// Recruiter edit of ONE clarification question: its row id plus the (possibly
// re-typed) text. The service requires the full id set to match the job's rows,
// so a question cannot be silently dropped or invented here.
const clarificationEditField = z.object({
  id: z
    .string({ message: "Question id is required" })
    .min(1, "Question id is required")
    .max(100, "Question id is invalid"),
  question: z
    .string({ message: "Question text is required" })
    .trim()
    .min(1, "Question text is required")
    .max(2000, "Question text must be at most 2000 characters"),
});

const clarificationQuestionsSchema = z.object({
  questions: z
    .array(clarificationEditField, { message: "Questions must be a list" })
    .max(
      MAX_CLARIFICATION_QUESTIONS,
      `Clarification questions cannot exceed ${MAX_CLARIFICATION_QUESTIONS}`
    ),
});

// Assessment title/description edits. Same bounds the generation contract uses
// (title max 200; description free recruiter copy, bounded for sanity).
const assessmentTitleField = z
  .string({ message: "Assessment title is required" })
  .trim()
  .min(3, "Assessment title must be at least 3 characters")
  .max(200, "Assessment title must be at most 200 characters");

const assessmentDescriptionField = z
  .string({ message: "Assessment description must be text" })
  .trim()
  .max(5000, "Assessment description must be at most 5000 characters");

// Recruiter edit of ONE assessment question. questionType and options are NOT
// editable (changing a question's shape would invalidate its options and the
// candidate flow that the next stage builds on them).
const assessmentQuestionEditField = z.object({
  id: z
    .string({ message: "Question id is required" })
    .min(1, "Question id is required")
    .max(100, "Question id is invalid"),
  prompt: z
    .string({ message: "Question prompt is required" })
    .trim()
    .min(1, "Question prompt is required")
    .max(4000, "Question prompt must be at most 4000 characters"),
  points: z
    .number({ message: "Points must be a number" })
    .int("Points must be a whole number")
    .min(1, "Points must be at least 1")
    .max(100, "Points must be at most 100"),
  difficulty: z
    .enum(["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"], {
      message: "Difficulty must be BEGINNER, INTERMEDIATE, ADVANCED or EXPERT",
    })
    .nullish(),
});

// Recruiter-set candidate assessment timer, in whole seconds. Bounded by the
// platform maximum (5400s = 90 minutes); never AI-decided, never confused with
// analysisDays. The 600s default is applied by the backend at
// assessment-generation time when the Job carries no configured duration.
const assessmentDurationField = z
  .number({ message: "Duration must be a number" })
  .int("Duration must be a whole number")
  .min(
    MIN_ASSESSMENT_DURATION_SECONDS,
    `Duration must be at least ${MIN_ASSESSMENT_DURATION_SECONDS} seconds`
  )
  .max(
    MAX_ASSESSMENT_DURATION_SECONDS,
    `Duration must be at most ${MAX_ASSESSMENT_DURATION_SECONDS} seconds (90 minutes)`
  );

const assessmentUpdateSchema = z.object({
  title: assessmentTitleField.optional(),
  description: assessmentDescriptionField.nullish(),
  durationSeconds: assessmentDurationField.optional(),
  questions: z
    .array(assessmentQuestionEditField, { message: "Questions must be a list" })
    .max(
      MAX_ASSESSMENT_QUESTIONS,
      `An assessment can have at most ${MAX_ASSESSMENT_QUESTIONS} questions`
    )
    .optional(),
});

// --- Invitation stage --------------------------------------------------------
// The candidate email field, used ONLY by the CANDIDATE-FACING verification
// flow (the code the invited candidate receives and confirms on the assessment
// link). Emails are matched case-insensitively everywhere; zod trims/lowercases
// at the boundary so the service only ever sees normalized values.
//
// There is deliberately NO recruiter-side invitation body schema: a recruiter
// never submits an email to invite someone. Invitations are issued exclusively
// from a row of the recruiter's own candidate list
// (POST /:jobId/candidates/:candidateId/invite), and the backend resolves the
// address from persisted candidate data server-side.
const invitationEmailField = z
  .string({ message: "Email must be a string" })
  .trim()
  .toLowerCase()
  .min(6, "Email is too short")
  .max(320, "Email is too long")
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Email must be a valid email address");

const assessmentEmailVerificationSchema = z.object({
  email: invitationEmailField,
});

const assessmentVerificationConfirmSchema = z.object({
  email: invitationEmailField,
  token: z
    .string({ message: "Verification code must be a string" })
    .trim()
    .min(10, "Verification code is too short")
    .max(200, "Verification code is too long"),
});

// --- Candidate assessment attempt (Phase 3) ----------------------------------
//
// The candidate identity is ALWAYS the invited email (normalized at the
// boundary, resolved against the PERSISTED invitation server-side). The start
// and submit bodies deliberately contain NOTHING else: a client cannot supply
// a start time, deadline, duration or status — the zod object strips unknown
// keys and the attempt service never reads them. The answer envelope is loose
// here and validated per question type in the service, because the question's
// persisted type/options are the authority.
const assessmentAttemptActionSchema = z.object({
  email: invitationEmailField,
});

const assessmentAttemptAnswerSchema = z.object({
  email: invitationEmailField,
  questionId: z
    .string({ message: "Question id must be a string" })
    .trim()
    .min(1, "Question id is required")
    .max(64, "Question id is too long"),
  answer: z.unknown({ message: "An answer payload is required" }),
});

// --- Phase 5: assessment integrity signals -----------------------------------
//
// The ONLY integrity signal a browser may report is a visibility transition.
// The candidate identity is the SAME invited email every other attempt route
// uses, so the existing Phase 3 authorization is reused verbatim (resolved
// against the persisted EMAIL_VERIFIED invitation) rather than duplicated — and
// the attempt itself is re-resolved server-side from (assessment, email), then
// cross-checked against the attemptId in the path.
//
// Deliberately ABSENT from the body (and stripped by zod if a client sends
// them): status, cheatReason, cheated, score, deadline, startedAt, jobId,
// assessmentId. The server decides the outcome; the browser only reports a
// signal, so there is no way to ask for CHEATED from the client.
const ASSESSMENT_INTEGRITY_SIGNAL_TYPES = ["VISIBILITY_HIDDEN", "VISIBILITY_VISIBLE"];

const assessmentIntegrityEventSchema = z.object({
  email: invitationEmailField,
  type: z.enum(ASSESSMENT_INTEGRITY_SIGNAL_TYPES, {
    message: "Only visibility signals are accepted from the browser",
  }),
  // Optional bounded context. The service keeps only a small scalar whitelist,
  // so this can never be used to store arbitrary payloads.
  detail: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Phase 7 — recruiter-editable candidate reference fields
// (JobCandidateReference, Step 2).
//
// ONLY the recruiter-provided reference CONTENT is editable here. Identity and
// ownership are server-side facts and are deliberately NOT part of this schema:
// a request carrying jobId, id, candidateEmail, createdByUserId, resumeFileId
// or any other key is REJECTED (strict schema), so a reference can never be
// moved to another job or re-identified by the client. An ABSENT key leaves the
// stored value untouched; null (or an empty string) clears the field
// explicitly — a replacement spreadsheet that omits a column therefore never
// erases recruiter-edited data.
//
// The same limits bound the Excel seeding path (jobCandidateList.parser.js
// imports CANDIDATE_REFERENCE_FIELD_LIMITS), so both entry points produce
// identically-shaped values.
// ---------------------------------------------------------------------------
const MAX_CANDIDATE_REFERENCE_SKILLS = 50;

const CANDIDATE_REFERENCE_FIELD_LIMITS = {
  candidateName: 200,
  linkedinUrl: 500,
  linkedinText: 5000,
  githubUrl: 500,
  githubText: 5000,
  preferredRole: 200,
  skillNotes: 5000,
  skill: 100,
};

const candidateReferenceText = (label, max) =>
  z
    .string({ message: `${label} must be text` })
    .trim()
    .max(max, `${label} must be at most ${max} characters`);

// Manual candidate addition — the recruiter's backup path for a candidate the
// uploaded sheet missed. It carries the SAME candidate information an Excel row
// can, so both entry points converge on one JobCandidateReference row and one
// classification (see job.service.addManualJobCandidate).
//
// Every optional field reuses candidateReferenceUpdateSchema's exact limits, so
// a manually added candidate is byte-for-byte as validatable/editable as an
// imported one. Skills use the SAME representation (the reference's Json string
// list) — no second skill model.
//
// `.strict()` is the SAME identity boundary: any key that is not a whitelisted
// candidate field is REJECTED, so a client can never submit `status` /
// `systemStatus` / `candidateUserId` / `referenceId` as an authority. The
// backend derives IN_SYSTEM / NOT_IN_SYSTEM itself
// (jobCandidate.classification.js).
//
// The email rule is the platform's existing candidate-email shape — the very
// pattern jobCandidateList.parser.js applies to every Excel row — and the
// service applies the ONE normalization (trim + lowercase) afterwards, so
// "Candidate@Example.com" and " candidate@example.com " resolve to the same
// candidate exactly like their Excel equivalents.
//
// The resume is NOT a body field: it is attached through the EXISTING
// POST /:jobId/candidate-references/:referenceId/resume upload (PDF/TXT,
// private storage) using the referenceId this endpoint returns. One upload
// system, one storage path, one text extractor.
const CANDIDATE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CANDIDATE_EMAIL_LENGTH = 320;

const manualCandidateText = (label, max) =>
  z
    .string({ message: `${label} must be text` })
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .nullable()
    .optional();

const manualCandidateSkillSchema = z
  .string({ message: "Each skill must be text" })
  .trim()
  .min(1, "Each skill must be at least 1 character")
  .max(
    CANDIDATE_REFERENCE_FIELD_LIMITS.skill,
    `Each skill must be at most ${CANDIDATE_REFERENCE_FIELD_LIMITS.skill} characters`
  );

const manualCandidateCreateSchema = z
  .object({
    // `name` is the Excel column's own name, so both paths speak one vocabulary.
    name: manualCandidateText("Candidate name", CANDIDATE_REFERENCE_FIELD_LIMITS.candidateName),
    email: z
      .string({ message: "Candidate email is required" })
      .trim()
      .min(1, "Candidate email is required")
      .max(
        MAX_CANDIDATE_EMAIL_LENGTH,
        `Candidate email must be at most ${MAX_CANDIDATE_EMAIL_LENGTH} characters`
      )
      .regex(CANDIDATE_EMAIL_PATTERN, "Enter a valid email address"),
    linkedinUrl: manualCandidateText("LinkedIn URL", CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinUrl),
    linkedinText: manualCandidateText(
      "LinkedIn text",
      CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinText
    ),
    githubUrl: manualCandidateText("GitHub URL", CANDIDATE_REFERENCE_FIELD_LIMITS.githubUrl),
    githubText: manualCandidateText("GitHub text", CANDIDATE_REFERENCE_FIELD_LIMITS.githubText),
    preferredRole: manualCandidateText(
      "Preferred role",
      CANDIDATE_REFERENCE_FIELD_LIMITS.preferredRole
    ),
    skillNotes: manualCandidateText("Skill notes", CANDIDATE_REFERENCE_FIELD_LIMITS.skillNotes),
    skills: z
      .array(manualCandidateSkillSchema)
      .max(
        MAX_CANDIDATE_REFERENCE_SKILLS,
        `Skills must contain at most ${MAX_CANDIDATE_REFERENCE_SKILLS} entries`
      )
      .nullable()
      .optional(),
  })
  .strict();

const candidateReferenceUpdateSchema = z
  .object({
    candidateName: candidateReferenceText(
      "Candidate name",
      CANDIDATE_REFERENCE_FIELD_LIMITS.candidateName
    )
      .nullable()
      .optional(),
    linkedinUrl: candidateReferenceText("LinkedIn URL", CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinUrl)
      .nullable()
      .optional(),
    linkedinText: candidateReferenceText(
      "LinkedIn text",
      CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinText
    )
      .nullable()
      .optional(),
    githubUrl: candidateReferenceText("GitHub URL", CANDIDATE_REFERENCE_FIELD_LIMITS.githubUrl)
      .nullable()
      .optional(),
    githubText: candidateReferenceText(
      "GitHub text",
      CANDIDATE_REFERENCE_FIELD_LIMITS.githubText
    )
      .nullable()
      .optional(),
    preferredRole: candidateReferenceText(
      "Preferred role",
      CANDIDATE_REFERENCE_FIELD_LIMITS.preferredRole
    )
      .nullable()
      .optional(),
    skills: z
      .array(
        z
          .string({ message: "Each skill must be text" })
          .trim()
          .min(1, "Each skill must be at least 1 character")
          .max(
            CANDIDATE_REFERENCE_FIELD_LIMITS.skill,
            `Each skill must be at most ${CANDIDATE_REFERENCE_FIELD_LIMITS.skill} characters`
          )
      )
      .max(
        MAX_CANDIDATE_REFERENCE_SKILLS,
        `Skills must contain at most ${MAX_CANDIDATE_REFERENCE_SKILLS} entries`
      )
      .nullable()
      .optional(),
    skillNotes: candidateReferenceText("Skill notes", CANDIDATE_REFERENCE_FIELD_LIMITS.skillNotes)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one candidate reference field must be provided",
  });

module.exports = {
  createDraftSchema,
  updateDraftSchema,
  clarificationQuestionsSchema,
  assessmentUpdateSchema,
  // Candidate-facing email verification only. There is no recruiter-side
  // invitation body schema: invitations come from the candidate list.
  assessmentEmailVerificationSchema,
  assessmentVerificationConfirmSchema,
  assessmentAttemptActionSchema,
  assessmentAttemptAnswerSchema,
  // Phase 5 — deterministic integrity signal boundary.
  assessmentIntegrityEventSchema,
  MAX_ASSESSMENT_QUESTIONS,
  MIN_ASSESSMENT_DURATION_SECONDS,
  MAX_ASSESSMENT_DURATION_SECONDS,
  MAX_CHILD_ITEMS,
  MAX_DESCRIPTION_LENGTH,
  MAX_PREFERRED_CANDIDATES,
  // Phase 7 — candidate reference editing boundaries. There is no analysis
  // request schema: analysis is never recruiter-requested, only system-triggered.
  candidateReferenceUpdateSchema,
  // Manual candidate addition (recruiter-entered email; backend classifies).
  manualCandidateCreateSchema,
  CANDIDATE_EMAIL_PATTERN,
  MAX_CANDIDATE_EMAIL_LENGTH,
  CANDIDATE_REFERENCE_FIELD_LIMITS,
  MAX_CANDIDATE_REFERENCE_SKILLS,
};
