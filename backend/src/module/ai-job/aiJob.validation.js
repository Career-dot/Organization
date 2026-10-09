const { z } = require("zod");
const name = z.string().min(1).max(200);
const text = z.string().min(1).max(4000);
const skill = z.object({ name, weight: z.number().int().min(0).max(100) }).strict();
const input = z.object({
  title: name, yearsExperience: z.number().int().min(0).max(100).nullable(),
  description: z.string().min(1).max(30000), skills: z.array(skill).max(100),
  tools: z.array(name).max(100), questions: z.array(text).max(100),
}).strict().refine((v) => new Set(v.skills.map((s) => s.name)).size === v.skills.length && new Set(v.tools).size === v.tools.length);

// The four analysis sections. Mirrors the FastAPI contract's Section Literal and
// the JobAnalysisSection enum — the three must stay in lockstep, and this is the
// only place the backend validates them on live AI output.
const section = z.enum(["JOB_OVERVIEW", "RESPONSIBILITIES", "REQUIRED_SKILLS", "TOOLS_SOFTWARE"]);
const clarification = z.object({ section, question: text }).strict();

const analysis = z.object({
  summary: text, responsibilities: z.array(text).max(50),
  skillAnalysis: z.array(skill.extend({ expectation: text, source: z.enum(["EXPLICIT", "INFERRED", "UNCLEAR"]) })).max(100),
  toolAnalysis: z.array(z.object({ name, expectation: text }).strict()).max(100),
  ambiguities: z.array(text).max(50), clarificationQuestions: z.array(clarification).max(50), warnings: z.array(text).max(50),
}).strict();
const responseSchema = z.object({ schemaVersion: z.literal("1"), aiJobId: name,
  operation: z.literal("JOB_ANALYSIS"), provider: z.literal("gemini"), model: name, analysis }).strict();
const buildAnalysisRequest = (row) => {
  const snapshot = z.object({ operation: z.literal("JOB_ANALYSIS"), input }).strict().parse(row.requestPayload);
  return { schemaVersion: "1", aiJobId: name.parse(row.id), operation: "JOB_ANALYSIS", request: snapshot.input };
};
const validateAnalysisResponse = (raw, request) => {
  const result = responseSchema.parse(raw);
  if (result.aiJobId !== request.aiJobId) throw new Error("Mismatched operation identifier");
  const expected = request.request.skills.map((s) => [s.name, s.weight]).sort();
  const actual = result.analysis.skillAnalysis.map((s) => [s.name, s.weight]).sort();
  const tools = result.analysis.toolAnalysis.map((t) => t.name).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual) || JSON.stringify([...request.request.tools].sort()) !== JSON.stringify(tools)) {
    throw new Error("Analysis does not preserve input");
  }
  return result;
};

// --- Assessment generation (the second operation) ---------------------------
// Recruiter's assessment settings frozen into the request snapshot: the
// requested question count (1..45) and the candidate timer in whole seconds
// (60..5400). Both are optional for legacy jobs. The response schema below is
// strict and carries NO duration, so a model that invents one is rejected
// before it can reach PostgreSQL.
const assessmentInput = z.object({
  job: input,
  clarifications: z.array(clarification).max(50),
  requestedQuestionCount: z.number().int().min(1).max(45).nullish(),
  requestedDurationSeconds: z.number().int().min(60).max(5400).nullish(),
}).strict();
const assessmentQuestion = z.object({
  section,
  prompt: text,
  questionType: z.enum(["SINGLE_CHOICE", "MULTIPLE_CHOICE", "SCENARIO", "PROBLEM_SOLVING", "SHORT_ANSWER"]),
  points: z.number().int().min(1).max(100),
  difficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"]),
  guidance: text.nullish(),
  options: z.array(text).max(20).optional(),
  // Phase 6 — the deterministic answer key the generator must supply for
  // choice questions: {choice} for SINGLE_CHOICE, {choices} for
  // MULTIPLE_CHOICE, null/absent for text-shaped questions. The cross-field
  // gate in validateAssessmentResponse proves the shape and that every value
  // is a member of this question's own options before persistence.
  correctAnswer: z.record(z.string(), z.unknown()).nullish(),
}).strict();
// Hard platform maximum: the AI can NEVER produce more than 45 questions. The
// .max(45) here and the identical cap in the FastAPI schema make a larger
// response a validation failure on both sides — nothing is silently truncated.
const assessment = z.object({
  title: name,
  description: text.nullish(),
  questions: z.array(assessmentQuestion).min(1).max(45),
}).strict();
const assessmentResponseSchema = z.object({ schemaVersion: z.literal("1"), aiJobId: name,
  operation: z.literal("ASSESSMENT_GENERATION"), provider: z.literal("gemini"), model: name, assessment }).strict();
const buildAssessmentRequest = (row) => {
  const snapshot = z.object({ operation: z.literal("ASSESSMENT_GENERATION"), input: assessmentInput }).strict().parse(row.requestPayload);
  // Deterministic configuration gate (mirrors the FastAPI request validator):
  // a requested count below the mandatory recruiter-question count can never
  // be satisfied (recruiter questions are preserved verbatim) and must fail
  // fast, before any provider call.
  const requested = snapshot.input.requestedQuestionCount ?? null;
  const recruiterCount = snapshot.input.job?.questions?.length ?? 0;
  if (requested !== null && recruiterCount > requested) {
    throw new Error("AI_REQUEST_INVALID");
  }
  return { schemaVersion: "1", aiJobId: name.parse(row.id), operation: "ASSESSMENT_GENERATION", request: snapshot.input };
};
// Mirrors the service's own preservation gate, so a partial assessment cannot be
// persisted even if the service ever let one through.
const validateAssessmentResponse = (raw, request) => {
  const result = assessmentResponseSchema.parse(raw);
  if (result.aiJobId !== request.aiJobId) throw new Error("Mismatched operation identifier");
  const covered = new Set(result.assessment.questions.map((q) => q.section));
  for (const item of request.request.clarifications) {
    if (!covered.has(item.section)) throw new Error("Assessment does not address every clarified section");
  }
  // The requested count is an EXACT contract (recruiter questions + AI
  // additions): never more, never fewer. The hard 45 cap is already enforced
  // by the response schema above.
  const requestedCount = request.request.requestedQuestionCount ?? null;
  if (requestedCount !== null && result.assessment.questions.length !== requestedCount) {
    throw new Error("Assessment question count does not match the requested count");
  }
  // Recruiter-entered JobQuestion text is MANDATORY: every recruiter question
  // (frozen into AiJob.requestPayload.input.job.questions) must appear as an
  // assessment question prompt. Exact match first, then a harmless
  // whitespace/case-normalized match. No fuzzy/semantic matching.
  const prompts = result.assessment.questions.map((q) => q.prompt);
  // Identical normalization to the FastAPI gate: trim + collapse internal
  // whitespace + lowercase. Only harmless formatting variance is tolerated;
  // anything semantic is a different string and fails.
  const norm = (s) => (s || "").trim().split(/\s+/).join(" ").toLowerCase();
  for (const question of request.request.job?.questions ?? []) {
    const exact = prompts.some((p) => p === question);
    if (exact) continue;
    const normalized = norm(question);
    if (!prompts.some((p) => norm(p) === normalized)) {
      throw new Error("Assessment does not preserve every recruiter-entered question");
    }
  }
  // Phase 6 — deterministic answer-key gate (mirrors FastAPI's
  // AssessmentQuestion validator): a choice question MUST carry a key whose
  // values are exact, unique members of that question's own options, and a
  // text-shaped question must never carry one. A response that fails here is
  // rejected BEFORE persistence, so JobAssessmentQuestion.correctAnswer is
  // trusted by construction — nothing a candidate can influence ever lands
  // in this column.
  for (const question of result.assessment.questions) {
    const options = Array.isArray(question.options) ? question.options : [];
    const key = question.correctAnswer ?? null;
    if (question.questionType === "SINGLE_CHOICE" || question.questionType === "MULTIPLE_CHOICE") {
      if (key === null || typeof key !== "object" || Array.isArray(key)) {
        throw new Error("Assessment choice question is missing its correct answer key");
      }
      if (question.questionType === "SINGLE_CHOICE") {
        const shapeOk = Object.keys(key).length === 1 && typeof key.choice === "string";
        if (!shapeOk || !options.includes(key.choice)) {
          throw new Error("Assessment single-choice key must name one of the question's own options");
        }
      } else {
        const shapeOk = Object.keys(key).length === 1 && Array.isArray(key.choices);
        const choices = shapeOk ? key.choices : [];
        const membersOk =
          choices.length > 0 &&
          choices.every((choice) => typeof choice === "string" && options.includes(choice)) &&
          new Set(choices).size === choices.length;
        if (!shapeOk || !membersOk) {
          throw new Error(
            "Assessment multiple-choice key must name unique members of the question's own options"
          );
        }
      }
    } else if (key !== null) {
      throw new Error("Assessment text questions must not carry a correct answer key");
    }
  }
  return result;
};

// --- Candidate analysis (the Node-side mirror of the GREEN FastAPI contract) --
// The worker adds only aiJobId from its claimed PostgreSQL row. Everything else
// is parsed from the frozen requestPayload using strict objects, so raw email,
// answer keys, integrity metadata, and arbitrary extra fields cannot reach HTTP.
const candidateEvidenceStatus = z.enum([
  "AVAILABLE",
  "NOT_PROVIDED",
  "UNAVAILABLE",
  "INSUFFICIENT",
]);
const candidateAssessmentStatus = z.enum([
  "NOT_STARTED",
  "STARTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "TIMED_UP",
  "CHEATED",
]);
const candidateQuestion = z.object({
  question: text,
  questionType: z.enum([
    "SINGLE_CHOICE",
    "MULTIPLE_CHOICE",
    "SCENARIO",
    "PROBLEM_SOLVING",
    "SHORT_ANSWER",
  ]),
  points: z.number().int().min(0).max(100),
  candidateAnswer: z
    .object({
      answer: z.string().max(4000),
      truncated: z.boolean(),
    })
    .strict()
    .nullable(),
  earnedPoints: z.number().int().min(0).max(100).nullable(),
  unanswered: z.boolean(),
}).strict().superRefine((question, context) => {
  if (question.unanswered && question.candidateAnswer !== null) {
    context.addIssue({ code: "custom", message: "Unanswered question cannot carry an answer" });
  }
  if (!question.unanswered && question.candidateAnswer === null) {
    context.addIssue({ code: "custom", message: "Answered question requires an answer" });
  }
});
const candidateAssessment = z.object({
  title: name,
  description: text.nullable(),
  status: candidateAssessmentStatus,
  score: z.number().int().min(0).max(100000).nullable(),
  maxScore: z.number().int().min(0).max(100000).nullable(),
  scorePercentage: z.number().min(0).max(100).nullable(),
  unanswered: z.boolean(),
  questions: z.array(candidateQuestion).max(45),
}).strict();
const candidateJob = z.object({
  title: name,
  yearsExperience: z.number().int().min(0).max(100).nullable(),
  description: z.string().min(1).max(30000),
  skills: z.array(skill).max(100),
  tools: z.array(name).max(100),
  recruiterQuestions: z.array(text).max(100),
  responsibilities: z.array(text).max(50),
}).strict();
const candidateModel = z.object({
  candidateName: name.nullable(),
  preferredRole: text.nullable(),
  skills: z.array(name).max(100),
  skillNotes: text.nullable(),
  linkedinUrl: z.string().max(2000).nullable(),
  linkedinText: z.string().max(10000).nullable(),
  linkedinEvidenceStatus: candidateEvidenceStatus,
  githubUrl: z.string().max(2000).nullable(),
  githubText: z.string().max(10000).nullable(),
  githubEvidenceStatus: candidateEvidenceStatus,
  resumeText: z.string().max(20000).nullable(),
  resumeEvidenceStatus: candidateEvidenceStatus,
}).strict().superRefine((candidate, context) => {
  for (const [statusField, textField] of [
    ["linkedinEvidenceStatus", "linkedinText"],
    ["githubEvidenceStatus", "githubText"],
    ["resumeEvidenceStatus", "resumeText"],
  ]) {
    if (candidate[statusField] === "AVAILABLE" && candidate[textField] === null) {
      context.addIssue({ code: "custom", message: `${statusField} requires text` });
    }
    if (candidate[statusField] !== "AVAILABLE" && candidate[textField] !== null) {
      context.addIssue({ code: "custom", message: `${statusField} cannot carry text` });
    }
  }
});
const candidateSnapshot = z.object({
  schemaVersion: z.literal("1"),
  candidateKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  analysisVersion: z.number().int().min(1).max(100000),
  job: candidateJob,
  assessment: candidateAssessment.nullable(),
  candidate: candidateModel,
  metadata: z.object({ source: z.literal("NODE_WORKER") }).strict(),
}).strict();
const candidateRequestEnvelope = z.object({
  operation: z.literal("CANDIDATE_ANALYSIS"),
  input: candidateSnapshot,
}).strict();
const buildCandidateAnalysisRequest = (row) => {
  const snapshot = candidateRequestEnvelope.parse(row.requestPayload);
  return {
    schemaVersion: snapshot.input.schemaVersion,
    aiJobId: name.parse(row.id),
    operation: "CANDIDATE_ANALYSIS",
    candidateKey: snapshot.input.candidateKey,
    analysisVersion: snapshot.input.analysisVersion,
    job: snapshot.input.job,
    assessment: snapshot.input.assessment,
    candidate: snapshot.input.candidate,
    metadata: snapshot.input.metadata,
  };
};

const candidateEvidenceSummary = z.object({
  status: candidateEvidenceStatus,
  summary: text,
  details: z.array(text).max(20),
}).strict();
const candidateAlignment = z.object({
  status: z.enum(["SUPPORTED", "NOT_EVIDENCED", "UNAVAILABLE", "CONFLICTING"]),
  rationale: text,
}).strict();
const candidateAnalysis = z.object({
  jobFitSummary: text,
  assessmentPerformance: z.object({
    status: candidateAssessmentStatus,
    score: z.number().int().min(0).max(100000).nullable(),
    maxScore: z.number().int().min(0).max(100000).nullable(),
    scorePercentage: z.number().min(0).max(100).nullable(),
    summary: text,
    strengths: z.array(text).max(20),
    gaps: z.array(text).max(20),
    unanswered: z.number().int().min(0).max(45),
  }).strict(),
  skillAlignment: z.array(z.object({
    skill: name,
    status: z.enum(["SUPPORTED", "NOT_EVIDENCED", "UNAVAILABLE", "CONFLICTING"]),
    rationale: text,
    evidence: z.array(text).max(20),
  }).strict()).max(100),
  resumeEvidence: candidateEvidenceSummary,
  linkedinEvidence: candidateEvidenceSummary,
  githubEvidence: candidateEvidenceSummary,
  preferredRoleAlignment: z.object({
    status: z.enum(["SUPPORTED", "NOT_EVIDENCED", "UNAVAILABLE", "CONFLICTING"]),
    summary: text,
    rationale: text,
  }).strict(),
  strengths: z.array(text).max(50),
  skillGaps: z.array(text).max(50),
  missingRequirements: z.array(text).max(50),
  conflicts: z.array(text).max(50),
  concerns: z.array(text).max(50),
  finalRecruiterReview: text,
}).strict();
const candidateResponse = z.object({
  schemaVersion: z.literal("1"),
  aiJobId: name,
  operation: z.literal("CANDIDATE_ANALYSIS"),
  provider: z.literal("gemini"),
  model: name,
  analysis: candidateAnalysis,
}).strict();
const validateCandidateAnalysisResponse = (raw, request) => {
  const result = candidateResponse.parse(raw);
  if (result.aiJobId !== request.aiJobId) {
    throw new Error("Mismatched candidate-analysis operation identifier");
  }
  // The strict schema has no overall/combined/ranking/hiring-decision field.
  // Preserve the job skill set as a second deterministic provider-output gate.
  const expectedSkills = request.job.skills.map(({ name: skillName }) => skillName).sort();
  const actualSkills = result.analysis.skillAlignment.map(({ skill }) => skill).sort();
  if (JSON.stringify(expectedSkills) !== JSON.stringify(actualSkills)) {
    throw new Error("Candidate analysis does not preserve supplied skills");
  }
  return result;
};

// Dispatch by the authoritative AiJob.operation. Unknown operations fail closed.
const buildRequest = (row) => {
  if (row?.operation === "ASSESSMENT_GENERATION") return buildAssessmentRequest(row);
  if (row?.operation === "JOB_ANALYSIS") return buildAnalysisRequest(row);
  if (row?.operation === "CANDIDATE_ANALYSIS") return buildCandidateAnalysisRequest(row);
  throw new Error("AI_OPERATION_UNSUPPORTED");
};

const validateResponse = (raw, request) => {
  if (request.operation === "ASSESSMENT_GENERATION") return validateAssessmentResponse(raw, request);
  if (request.operation === "CANDIDATE_ANALYSIS") return validateCandidateAnalysisResponse(raw, request);
  return validateAnalysisResponse(raw, request);
};

module.exports = { buildRequest, validateResponse };

