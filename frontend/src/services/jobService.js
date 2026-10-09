// Job module API service.
//
// Thin wrappers over the shared apiClient (no second axios instance), using
// the same convention as subscriptionService/organizationService: every
// function resolves with the backend response envelope
// ({ success, message, data?, ... }) and rejects with an axios error the
// caller can pass to extractApiErrorMessage.
//
// Ownership is NEVER sent from here: the backend derives recruiter vs
// organization ownership from the authenticated user and their ACTIVE
// organization membership. The only place an organization id appears is as
// the path parameter of the two organization endpoints, and it must come
// from the authenticated session's active account (see useJobContext in
// hooks/useJobContext.js) — never from user input.
import apiClient from "./apiClient";

export const createJobDraft = async (payload) => {
  const { data } = await apiClient.post("/job", payload);
  return data;
};

export const updateJobDraft = async (jobId, payload) => {
  const { data } = await apiClient.patch(`/job/${jobId}`, payload);
  return data;
};

export const getJob = async (jobId) => {
  const { data } = await apiClient.get(`/job/${jobId}`);
  return data;
};

export const listRecruiterJobs = async ({ page = 1, limit = 10 } = {}) => {
  const { data } = await apiClient.get("/job/recruiter/jobs", {
    params: { page, limit },
  });
  return data;
};

export const listOrganizationJobs = async (organizationId, { page = 1, limit = 10 } = {}) => {
  const { data } = await apiClient.get(`/job/organization/${organizationId}/jobs`, {
    params: { page, limit },
  });
  return data;
};

// ---------------------------------------------------------------------------
// Recruiter READ-ONLY Jobs overview (Phase 8).
//
// All three are GETs against the existing /api/job router; none of them can
// mutate anything. Search, status and date filtering happen SERVER-SIDE through
// query params, so the browser never receives or filters the full job set —
// that is what keeps a large organization from downloading thousands of jobs.
//
// Ownership is still never sent from here: the backend derives recruiter vs
// organization ownership from the authenticated session, so there is deliberately
// no organizationId parameter on any of these calls.
// ---------------------------------------------------------------------------

// Recruiter's own jobs, filtered + paginated server-side.
// `search` matches the job title OR the job id (case-insensitive substring).
// `status` accepts DRAFT/ACTIVE/CLOSED or the recruiter-facing groups
// ACTIVE/CURRENT and CLOSED/COMPLETED/EXPIRED.
// `within` is a rolling window (month | week | quarter | year); explicit
// `from`/`to` (YYYY-MM-DD) win when both are supplied.
export const listOverviewJobs = async ({
  page = 1,
  limit = 10,
  search = "",
  status = "",
  within = "",
  from = "",
  to = "",
} = {}) => {
  const params = { page, limit };
  if (search) params.search = search;
  if (status) params.status = status;
  if (within) params.within = within;
  if (from) params.from = from;
  if (to) params.to = to;
  const { data } = await apiClient.get("/job/overview/jobs", { params });
  return data;
};

// The read-only job-details card: description, persisted requirements, skills
// (with their persisted weights), tools, assessment summary, dates, status and
// counts. Reuses the existing Job data — nothing is copied into a new store.
export const getOverviewJob = async (jobId) => {
  const { data } = await apiClient.get(`/job/overview/${jobId}`);
  return data;
};

// One job's candidates, paginated and searchable server-side. The response is a
// LIGHTWEIGHT projection: it carries the three values SEPARATELY (existing
// verified skill score / assessment score / analysis status) and deliberately
// never carries the candidate-analysis `result` JSON. The full reports are
// fetched on demand through getCandidateAnalysis and
// getJobCandidateVerificationReport below.
export const listOverviewCandidates = async (jobId, { page = 1, limit = 25, search = "" } = {}) => {
  const params = { page, limit };
  if (search) params.search = search;
  const { data } = await apiClient.get(`/job/overview/${jobId}/candidates`, { params });
  return data;
};

export const getRecruiterLimits = async () => {
  const { data } = await apiClient.get("/job/recruiter/limits");
  return data;
};

export const getOrganizationLimits = async (organizationId) => {
  const { data } = await apiClient.get(`/job/organization/${organizationId}/limits`);
  return data;
};

export const startJob = async (jobId) => {
  const { data } = await apiClient.post(`/job/${jobId}/start`);
  return data;
};

export const closeJob = async (jobId) => {
  const { data } = await apiClient.post(`/job/${jobId}/close`);
  return data;
};

// Candidate Excel Sheet (draft attachment). Multipart upload: the browser
// sets the multipart boundary; the backend parses/validates the file BEFORE
// persisting anything, and Start re-validates it BEFORE consuming quota.
export const uploadCandidateList = async (jobId, file) => {
  const formData = new FormData();
  formData.append("file", file);
  const { data } = await apiClient.post(`/job/${jobId}/candidate-list`, formData);
  return data;
};

export const deleteCandidateList = async (jobId) => {
  const { data } = await apiClient.delete(`/job/${jobId}/candidate-list`);
  return data;
};

// Candidate-facing read of a FINALIZED job assessment through its opaque public
// link. Deliberately unauthenticated on the backend (the link is the capability
// in this stage); the response carries only candidate-safe fields.
export const getPublicJobAssessment = async (publicId) => {
  const { data } = await apiClient.get(`/assessment/${publicId}`);
  return data;
};

// ---------------------------------------------------------------------------
// Public candidate attempt lifecycle (Phase 3) + integrity signals (Phase 5).
// The candidate session is authorized server-side by the persisted invitation
// verification context — the browser never sends an authority (no job id, no
// assessment id, no status, no timer values). The responses are STATUS ONLY.
// ---------------------------------------------------------------------------
export const startJobAssessmentAttempt = async (publicId, email) => {
  const { data } = await apiClient.post(`/assessment/${publicId}/attempt/start`, { email });
  return data;
};

export const saveJobAssessmentAttemptAnswer = async (
  publicId,
  attemptId,
  email,
  questionId,
  answer
) => {
  const { data } = await apiClient.post(`/assessment/${publicId}/attempt/answer`, {
    email,
    attemptId,
    questionId,
    answer,
  });
  return data;
};

export const submitJobAssessmentAttempt = async (publicId, attemptId, email) => {
  const { data } = await apiClient.post(`/assessment/${publicId}/attempt/submit`, {
    email,
    attemptId,
  });
  return data;
};

// Phase 5 — report ONE visibility transition during an ACTIVE attempt. The
// payload is deliberately minimal: only the signal type. The server decides
// everything (authorization, count, threshold, CHEATED). Network failures here
// are swallowed by the caller: a lost signal must never break the assessment.
export const reportJobAssessmentIntegrityEvent = async (publicId, attemptId, email, eventType) => {
  const { data } = await apiClient.post(
    `/assessment/${publicId}/attempt/${attemptId}/integrity-event`,
    { email, type: eventType }
  );
  return data;
};

// Recruiter activation — the explicit confirmation that a FINALIZED
// assessment is open for invitations. Idempotent on the backend.
export const activateAssessment = async (jobId) => {
  const { data } = await apiClient.post(`/job/${jobId}/assessment/activate`);
  return data;
};

// Candidate email-verification step 1 — the invited email is checked against
// THIS assessment's invitations and a code is emailed. Every failure is a
// generic 403 (the backend never reveals which emails are invited).
export const requestAssessmentEmailVerification = async (publicId, email) => {
  const { data } = await apiClient.post(`/assessment/${publicId}/verify-email`, { email });
  return data;
};

// Candidate email-verification step 2 — the emailed code authorizes the
// candidate server-side (invitation → EMAIL_VERIFIED).
export const confirmAssessmentEmailVerification = async (publicId, email, token) => {
  const { data } = await apiClient.post(`/assessment/${publicId}/confirm-verification`, {
    email,
    token,
  });
  return data;
};

export const getCandidateListPreview = async (jobId, limit) => {
  const { data } = await apiClient.get(`/job/${jobId}/candidate-list`, {
    params: limit != null ? { limit } : undefined,
  });
  return data;
};

// Recruiter candidate workflow (Phase 1) — the job's PERSISTED candidate list
// with the backend-authoritative IN SYSTEM / NOT IN SYSTEM classification and
// each candidate's EXISTING verified skill score. The classification is NEVER
// computed here: the response is rendered as-is, and the existing platform
// score is informational only (it is not an assessment score and not an AI
// analysis). Read-only: no invitations are created by this call.
export const getJobCandidates = async (jobId, limit) => {
  const { data } = await apiClient.get(`/job/${jobId}/candidates`, {
    params: limit != null ? { limit } : undefined,
  });
  return data;
};

// Manual candidate addition - a candidate the uploaded sheet is missing. Manual
// addition is a PEER of the Excel import, not a lesser path: the form submits the
// SAME candidate evidence an imported row carries (name, LinkedIn, GitHub,
// preferred role, skills, skill notes) and the backend persists it through the
// SAME seed-if-absent transaction the sheet uses, so the two entry points are
// indistinguishable downstream and a re-add never overwrites an imported row.
//
// The request carries ONLY candidate evidence. The backend owns normalization,
// duplicate detection and the IN SYSTEM / NOT IN SYSTEM classification, so the
// status this resolves with is server-derived, never decided here. The response
// reuses the exact same safe candidate DTO the list endpoint returns (no raw
// User record, no tokens, no private account fields), plus `created` so the caller
// knows whether the reference is new (and a resume may be attached).
export const addManualJobCandidate = async (jobId, candidate) => {
  const { data } = await apiClient.post(`/job/${jobId}/candidates`, {
    name: candidate.name,
    email: candidate.email,
    linkedinUrl: candidate.linkedinUrl,
    linkedinText: candidate.linkedinText,
    githubUrl: candidate.githubUrl,
    githubText: candidate.githubText,
    preferredRole: candidate.preferredRole,
    skills: candidate.skills,
    skillNotes: candidate.skillNotes,
  });
  return data;
};

// Resume attachment for a manually added candidate, through the EXISTING private
// PDF/TXT resume endpoint - there is no second storage or extraction system. The
// caller attaches it ONLY when `addManualJobCandidate` reported `created: true`,
// so an already-existing reference (and any resume or recruiter edit it already
// holds) is never silently replaced. Content rules and limits are enforced
// server-side before anything is persisted.
export const uploadCandidateResume = async (jobId, referenceId, file) => {
  const form = new FormData();
  form.append("file", file);
  const { data } = await apiClient.post(
    `/job/${jobId}/candidate-references/${referenceId}/resume`,
    form
  );
  return data;
};

// THE invitation action — invite ONE row of the recruiter's own candidate list.
// This is the only way an invitation is ever sent; there is no email-list
// variant and no email-only form.
//
// The request carries ONLY the row identity + job context — never an address —
// so the frontend can never submit an arbitrary email as the authoritative
// identity. The backend re-resolves it from persisted candidate data inside the
// authorized job. `candidateId` is the row's own identity from the list DTO:
// `candidate.id` (the stable Excel sheet rowId) for an imported row, or
// `candidate.referenceId` (the job-scoped candidate reference id) for one added
// manually — a manual candidate has no spreadsheet row, so its reference id is
// what addresses it.
//
// The response's invitation status is authoritative (no local status invention)
// and never contains verification tokens or hashes.
export const inviteJobCandidate = async (jobId, candidateId) => {
  const { data } = await apiClient.post(
    `/job/${jobId}/candidates/${encodeURIComponent(candidateId)}/invite`
  );
  return data;
};

// Verification report for ONE IN_SYSTEM candidate of this job — fetched ONLY
// when the recruiter clicks "View Report" in the candidate table, so the
// report opens in a secondary modal instead of living inside the list. The
// identity is the job-scoped reference id (never an email); the backend
// enforces job ownership, (jobId, referenceId) scoping and the IN_SYSTEM
// requirement, and answers with the safe stored verification projection
// (headline score, verified-skill count, per-skill stored values). Read-only:
// nothing is recalculated, and the assessment score is a separate value that
// lives only on the persisted attempt.
export const getJobCandidateVerificationReport = async (jobId, referenceId) => {
  const { data } = await apiClient.get(
    `/job/${jobId}/candidates/${encodeURIComponent(referenceId)}/verification-report`
  );
  return data;
};

// Phase 3 assessment status per candidate email for ONE owned job — the
// persisted attempt lifecycle (STARTED / IN_PROGRESS / SUBMITTED / TIMED_UP /
// CHEATED) plus, from Phase 6, the SERVER-calculated assessment score
// (assessmentScore / assessmentMaxScore / assessmentPercentage), which is null
// until the attempt is submitted. No answers, no question content and no
// answer keys exist in this projection, and the backend corrects expired
// active attempts to TIMED_UP before answering. This is the authoritative
// read the realtime stream reconciles against.
export const getJobCandidateAttempts = async (jobId) => {
  const { data } = await apiClient.get(`/job/${jobId}/assessment/attempts`);
  return data;
};

// Step 5 — explicit reference backfill/read before the active candidate workflow
// asks the classification projection for its server-resolved referenceId. This
// uses the accepted Step 2 endpoint; the browser never derives reference identity
// from candidate email.
export const getJobCandidateReferences = async (jobId) => {
  const { data } = await apiClient.get(`/job/${jobId}/candidate-references`, {
    params: { projection: "analysis" },
  });
  return data;
};

export const getCandidateAnalysis = async (jobId, referenceId, version) => {
  const { data } = await apiClient.get(
    `/job/${jobId}/candidate-references/${referenceId}/analysis`,
    { params: version != null ? { version } : undefined }
  );
  return data;
};

// Authenticated blob retrieval for the existing private resume stream. The browser
// receives bytes only after apiClient attaches the normal access token; no public
// storage URL or browser-storage copy is used.
export const getCandidateResumeBlob = async (jobId, referenceId) => {
  const { data } = await apiClient.get(
    `/job/${jobId}/candidate-references/${referenceId}/resume`,
    { responseType: "blob" }
  );
  return data;
};


// ---------------------------------------------------------------------------
// AI workflow (free actions — only Job Start consumes quota).
// Every call resolves with the backend envelope; durable state lives in
// PostgreSQL, so a refresh at any point simply re-reads it.
// ---------------------------------------------------------------------------

// Full-list edit of the recruiter-editable AI clarification questions. Every
// existing question id must be present exactly once (the backend rejects
// partial lists, so nothing can be silently discarded).
export const updateClarificationQuestions = async (jobId, questions) => {
  const { data } = await apiClient.patch(`/job/${jobId}/clarification-questions`, {
    questions,
  });
  return data;
};

// Edit & Continue: approves the current questions and queues AI assessment
// generation (202 Accepted — the work continues in the background pipeline).
export const continueClarifications = async (jobId) => {
  const { data } = await apiClient.post(`/job/${jobId}/clarifications/continue`);
  return data;
};

// Assessment CRUD. Update sends optional title/description plus an optional
// full-list questions patch (ids set-equal). Delete only works on a DRAFT.
export const updateAssessment = async (jobId, payload) => {
  const { data } = await apiClient.patch(`/job/${jobId}/assessment`, payload);
  return data;
};

export const deleteAssessment = async (jobId) => {
  const { data } = await apiClient.delete(`/job/${jobId}/assessment`);
  return data;
};

// Continue finalization: DRAFT → FINALIZED and the persisted link segment
// (publicId) is issued. Idempotent-friendly: re-calling returns the finalized
// assessment instead of erroring.
export const finalizeAssessment = async (jobId) => {
  const { data } = await apiClient.post(`/job/${jobId}/assessment/finalize`);
  return data;
};
