// ---------------------------------------------------------------------------
// Phase 4 — realtime recruiter candidate-status event model.
//
// Every event represents a PERSISTED state transition of the candidate's
// assessment lifecycle. The canonical status carried in the event is exactly
// the value stored in PostgreSQL (JobAssessmentInvitation.status /
// JobAssessmentAttempt.status), so the recruiter UI never invents a status.
//
// WIRE CONTRACT (the ONLY fields that may ever leave the backend):
//   eventType         one of REALTIME_EVENT_TYPES
//   jobId             the job the candidate row belongs to (authorization key)
//   assessmentId      the job's assessment
//   candidateId       the persisted Excel row identity when the producing flow
//                     knows it (invitation flows), otherwise null — never an
//                     array index
//   candidateEmail    normalized candidate email (already shown in the
//                     recruiter's own candidate list)
//   assessmentStatus  the persisted lifecycle status
//   occurredAt        ISO timestamp of publication
//
// DELIBERATELY ABSENT — never added without a security review:
//   answers, verification tokens/hashes, invitation challenge data, access
//   tokens, password hashes, AI payloads, old verification evidence, private
//   candidate profile data, Redis/queue internals. The sanitizer below is a
//   whitelist: anything not listed above is dropped before it can reach a
//   browser (this is also what makes a malformed/hostile Redis payload safe).
//
// Adding a future status (e.g. CHEATED / CANCELLED) means adding one entry to
// REALTIME_EVENT_TYPES plus its canonical status — the transport, gateway,
// authorization and frontend consumer need no redesign.
// ---------------------------------------------------------------------------

const REALTIME_EVENT_TYPES = {
  ASSESSMENT_INVITED: "ASSESSMENT_INVITED",
  ASSESSMENT_EMAIL_VERIFIED: "ASSESSMENT_EMAIL_VERIFIED",
  ASSESSMENT_STARTED: "ASSESSMENT_STARTED",
  ASSESSMENT_SUBMITTED: "ASSESSMENT_SUBMITTED",
  ASSESSMENT_TIMED_UP: "ASSESSMENT_TIMED_UP",
  // Phase 5 — deterministic integrity violation (CHEATED attempt).
  ASSESSMENT_CHEATED: "ASSESSMENT_CHEATED",
  // Phase 7 Step 6 — persisted candidate-analysis lifecycle notification.
  CANDIDATE_ANALYSIS_UPDATED: "CANDIDATE_ANALYSIS_UPDATED",
  // Job lifecycle — the job was closed AUTOMATICALLY because its persisted
  // availability deadline passed. Deliberately NOT a candidate-status event: it
  // carries no assessment, no candidate and no email.
  JOB_EXPIRED: "JOB_EXPIRED",
};


// The persisted status each event type announces. ASSESSMENT_STARTED covers the
// attempt lifecycle up to termination: "STARTED" (row created) and
// "IN_PROGRESS" (first answer persisted) are both reported with their real
// persisted value, so the recruiter row always mirrors PostgreSQL.
const PERSISTED_STATUS_BY_EVENT_TYPE = {
  ASSESSMENT_INVITED: "INVITED",
  ASSESSMENT_EMAIL_VERIFIED: "EMAIL_VERIFIED",
  ASSESSMENT_STARTED: "STARTED",
  ASSESSMENT_SUBMITTED: "SUBMITTED",
  ASSESSMENT_TIMED_UP: "TIMED_UP",
  // Phase 5 — the canonical persisted status for a CHEATED attempt.
  ASSESSMENT_CHEATED: "CHEATED",
};

const REALTIME_EVENT_TYPES_ALL = Object.values(REALTIME_EVENT_TYPES);

// A previous-version or future status must degrade to "ignore", never to a
// wrong status in the UI.
const PERSISTED_ASSESSMENT_STATUSES = [
  "INVITED",
  "EMAIL_VERIFIED",
  "STARTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "TIMED_UP",
  // Phase 5 — deterministic integrity violation.
  "CHEATED",
];

// Candidate-analysis status is deliberately a separate vocabulary. It is read
// from AiJob.status for the recruiter projection; it is never mixed into
// assessment invitation/attempt status validation.
const PERSISTED_CANDIDATE_ANALYSIS_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
];

const isRealtimeEventType = (value) => REALTIME_EVENT_TYPES_ALL.includes(value);
const isPersistedAssessmentStatus = (value) => PERSISTED_ASSESSMENT_STATUSES.includes(value);
const isPersistedCandidateAnalysisStatus = (value) =>
  PERSISTED_CANDIDATE_ANALYSIS_STATUSES.includes(value);

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

// A candidate email is only ever forwarded normalized (the same rule the
// recruiter candidate list applies) and only when it is a plausible address —
// an event carries no free-form text.
const normalizeEventEmail = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 320 && normalized.includes("@")
    ? normalized
    : null;
};

// The persisted Excel row identity (sheet row index) when the producing flow
// knows it. Integers only — never a string, never an array position.
const normalizeCandidateRowId = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * Build the immutable, whitelisted event payload for publication.
 * Throws only on a programming error (an emitter passing an unknown
 * eventType/status) — never on runtime data.
 */
const buildCandidateStatusEvent = ({
  eventType,
  jobId,
  assessmentId,
  candidateId = null,
  candidateEmail,
  assessmentStatus,
  occurredAt = new Date(),
}) => {
  if (
    !isRealtimeEventType(eventType) ||
    eventType === REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED ||
    eventType === REALTIME_EVENT_TYPES.JOB_EXPIRED
  ) {
    throw new Error(`Unknown assessment realtime event type: ${String(eventType)}`);
  }
  if (!isNonEmptyString(jobId) || !isNonEmptyString(assessmentId)) {
    throw new Error("A realtime candidate-status event requires a jobId and an assessmentId");
  }

  const status = assessmentStatus ?? PERSISTED_STATUS_BY_EVENT_TYPE[eventType];
  if (!isPersistedAssessmentStatus(status)) {
    throw new Error(`Unknown assessment status: ${String(status)}`);
  }

  return Object.freeze({
    eventType,
    jobId,
    assessmentId,
    candidateId: normalizeCandidateRowId(candidateId),
    candidateEmail: normalizeEventEmail(candidateEmail),
    assessmentStatus: status,
    occurredAt: new Date(occurredAt).toISOString(),
  });
};

/**
 * Phase 7 Step 6 candidate-analysis notification. This is deliberately not an
 * assessment event: it has no assessmentId, email, candidate row id, result, or
 * evidence. `status` is only a refetch signal; the browser must obtain the
 * authoritative latest/latestCompleted state from the authenticated API.
 */
const buildCandidateAnalysisStatusEvent = ({
  eventType = REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED,
  jobId,
  referenceId,
  analysisId,
  analysisVersion,
  status,
  updatedAt = new Date(),
}) => {
  if (eventType !== REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED) {
    throw new Error(`Unknown candidate-analysis realtime event type: ${String(eventType)}`);
  }
  if (!isNonEmptyString(jobId) || !isNonEmptyString(referenceId) || !isNonEmptyString(analysisId)) {
    throw new Error("A candidate-analysis event requires jobId, referenceId, and analysisId");
  }
  if (!Number.isInteger(analysisVersion) || analysisVersion < 1) {
    throw new Error("A candidate-analysis event requires a positive analysisVersion");
  }
  if (!isPersistedCandidateAnalysisStatus(status)) {
    throw new Error(`Unknown candidate-analysis status: ${String(status)}`);
  }
  const timestamp = new Date(updatedAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("A candidate-analysis event requires a valid updatedAt");
  }
  return Object.freeze({
    eventType,
    jobId,
    referenceId,
    analysisId,
    analysisVersion,
    status,
    updatedAt: timestamp.toISOString(),
  });
};

/**
 * Whitelist copy of a received (untrusted) Redis payload.
 *
 * Returns null for anything that is not a well-formed candidate-status event:
 * malformed shapes, unknown event types, unknown statuses, missing job scoping
 * or extra fields (extra fields are dropped, never forwarded). This is the
 * single gate between "a Redis message exists" and "a browser may see it".
 */
const sanitizeCandidateStatusEvent = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!isRealtimeEventType(value.eventType)) {
    return null;
  }
  if (value.eventType === REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED) {
    try {
      return buildCandidateAnalysisStatusEvent(value);
    } catch {
      return null;
    }
  }
  if (!isNonEmptyString(value.jobId) || !isNonEmptyString(value.assessmentId)) {
    return null;
  }
  if (!isPersistedAssessmentStatus(value.assessmentStatus)) {
    return null;
  }

  const occurredAt = new Date(value.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    return null;
  }

  return {
    eventType: value.eventType,
    jobId: value.jobId,
    assessmentId: value.assessmentId,
    candidateId: normalizeCandidateRowId(value.candidateId),
    candidateEmail: normalizeEventEmail(value.candidateEmail),
    assessmentStatus: value.assessmentStatus,
    occurredAt: occurredAt.toISOString(),
  };
};

/**
 * Job-lifecycle notification. This is deliberately NOT a candidate-status event:
 * it carries no assessmentId, no candidate identity and no email, because a job
 * expiring says nothing about any individual candidate.
 *
 * `closedAt` is the instant the row committed CLOSED. The browser must obtain the
 * authoritative job/assessment state by re-reading the authenticated API — this
 * event is only a refetch signal, exactly like the candidate-analysis event.
 */
const buildJobLifecycleEvent = ({
  eventType = REALTIME_EVENT_TYPES.JOB_EXPIRED,
  jobId,
  jobStatus = "CLOSED",
  closedAt = new Date(),
}) => {
  if (eventType !== REALTIME_EVENT_TYPES.JOB_EXPIRED) {
    throw new Error(`Unknown job-lifecycle realtime event type: ${String(eventType)}`);
  }
  if (!isNonEmptyString(jobId)) {
    throw new Error("A job-lifecycle event requires a jobId");
  }
  const timestamp = new Date(closedAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("A job-lifecycle event requires a valid closedAt");
  }
  return Object.freeze({
    eventType,
    jobId,
    jobStatus,
    closedAt: timestamp.toISOString(),
    occurredAt: timestamp.toISOString(),
  });
};

const sanitizeJobLifecycleEvent = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.eventType !== REALTIME_EVENT_TYPES.JOB_EXPIRED) return null;
  try {
    return buildJobLifecycleEvent(value);
  } catch {
    return null;
  }
};

// THE single gate between "a Redis message exists" and "a browser may see it",
// across BOTH event families. Each family keeps its own strict sanitizer; this
// only routes. An unrecognised shape is still rejected.
const sanitizeRealtimeEvent = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.eventType === REALTIME_EVENT_TYPES.JOB_EXPIRED) {
    return sanitizeJobLifecycleEvent(value);
  }
  return sanitizeCandidateStatusEvent(value);
};

module.exports = {
  REALTIME_EVENT_TYPES,
  PERSISTED_STATUS_BY_EVENT_TYPE,
  PERSISTED_ASSESSMENT_STATUSES,
  PERSISTED_CANDIDATE_ANALYSIS_STATUSES,
  isRealtimeEventType,
  isPersistedAssessmentStatus,
  isPersistedCandidateAnalysisStatus,
  normalizeEventEmail,
  normalizeCandidateRowId,
  buildCandidateStatusEvent,
  buildCandidateAnalysisStatusEvent,
  buildJobLifecycleEvent,
  sanitizeCandidateStatusEvent,
  sanitizeJobLifecycleEvent,
  sanitizeRealtimeEvent,
};
