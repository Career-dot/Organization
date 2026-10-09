// Recruiter-facing constants for the AI workflow (analysis → clarifications →
// assessment → link).
//
// These mirror the backend contract exactly (AiJobOperation / AiJobStatus /
// JobAnalysisSection / JobAssessmentStatus): the AiJob rows returned by
// GET /job/:jobId are the single source of truth for every state shown here —
// no fake progress states are ever invented client-side.
export const AI_JOB_OPERATION = {
  JOB_ANALYSIS: "JOB_ANALYSIS",
  ASSESSMENT_GENERATION: "ASSESSMENT_GENERATION",
};

export const AI_JOB_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

export const ASSESSMENT_STATUS = {
  DRAFT: "DRAFT",
  FINALIZED: "FINALIZED",
};

// The four analysis sections, in display order. Derived from the AI analysis
// contract (Section Literal) — never invented client-side. Every section box
// shows only the NUMBER of clarification questions generated for it; the
// questions themselves are revealed with View / Edit.
export const ANALYSIS_SECTIONS = [
  { key: "JOB_OVERVIEW", label: "Job Overview" },
  { key: "RESPONSIBILITIES", label: "Responsibilities" },
  { key: "REQUIRED_SKILLS", label: "Required Skills" },
  { key: "TOOLS_SOFTWARE", label: "Tools & Software" },
];

// Friendly, recruiter-facing copy for the normalized internal error codes the
// backend stores on a FAILED AiJob. The code itself is never jargon-dumped at
// the recruiter; unknown codes fall back to a safe generic message.
export const AI_FAILURE_MESSAGES = {
  AI_PROVIDER_RATE_LIMITED:
    "The AI provider is currently rate limiting requests. The analysis will retry automatically — this page updates itself.",
  AI_PROVIDER_UNAVAILABLE:
    "The AI provider is temporarily unavailable. The analysis will retry automatically.",
  AI_PROVIDER_TIMEOUT:
    "The AI provider took too long to respond. The analysis will retry automatically.",
  AI_PROVIDER_NETWORK_ERROR:
    "The AI service could not be reached. The analysis will retry automatically.",
  AI_PROVIDER_SAFETY_BLOCKED:
    "The AI provider declined to analyze this job content. Review the job details and contact support if this keeps happening.",
  AI_RESPONSE_VALIDATION_FAILED:
    "The AI returned an unusable result. The analysis will retry automatically.",
  AI_REQUEST_INVALID:
    "The analysis request was rejected as invalid. Please contact support — the job data itself is safe.",
  AI_SERVICE_UNAUTHORIZED:
    "The AI service rejected the platform's credentials. Please contact support.",
  AI_PROVIDER_NOT_CONFIGURED:
    "The AI provider is not configured yet. The analysis stays pending until it is.",
  default:
    "The AI analysis did not complete. The job and its candidate list are safe — no quota was lost.",
};
