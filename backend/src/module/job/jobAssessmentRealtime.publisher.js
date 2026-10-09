const { publishRealtimeEvent } = require("../../config/redis.pubsub");
const {
  REALTIME_EVENT_TYPES,
  buildCandidateStatusEvent,
  buildCandidateAnalysisStatusEvent,
  buildJobLifecycleEvent,
} = require("./jobAssessmentRealtime.events");

// ---------------------------------------------------------------------------
// Phase 4 — the ONE publication boundary for recruiter candidate-status events.
//
// CALL RULE (non-negotiable):
//   DB transaction → COMMIT → publish
// Every function below must be called only AFTER the PostgreSQL statement that
// produced the transition has committed. Nothing here opens, mutates or reads
// business state, and nothing here is ever awaited on a request's critical path:
// a Redis outage is logged and dropped, never propagated (see
// config/redis.pubsub.js — publishRealtimeEvent never rejects).
//
// The returned promise resolves with { published, reason? } so a caller (or the
// verification harness) may observe delivery, while production call sites use
// the fire-and-forget helpers below.
//
// SAFETY: the payload is built exclusively through the whitelisting event
// builder, so no answers, tokens, hashes, evidence, AI payloads or private
// profile data can reach the transport.
// ---------------------------------------------------------------------------

// Attaches a resolution/rejection sink so a fire-and-forget publish can never
// surface as an unhandled rejection. The business call is never delayed.
const withoutBlocking = (publishPromise) => {
  Promise.resolve(publishPromise).catch(() => {
    /* publishRealtimeEvent already reported the failure safely */
  });
  return publishPromise;
};

const publishEvent = (event) => withoutBlocking(publishRealtimeEvent(event));

/**
 * Phase 2 — an invitation row was created, re-sent or reactivated for one
 * persisted candidate row. `candidateId` is the Excel row identity when the
 * caller knows it (row-scoped Invite), otherwise null.
 */
const publishInvitationEvent = ({ jobId, assessmentId, candidateId = null, candidateEmail }) =>
  publishEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_INVITED,
      jobId,
      assessmentId,
      candidateId,
      candidateEmail,
    })
  );

/** Phase 2 — the invitation flipped to EMAIL_VERIFIED. */
const publishEmailVerifiedEvent = ({ jobId, assessmentId, candidateId = null, candidateEmail }) =>
  publishEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_EMAIL_VERIFIED,
      jobId,
      assessmentId,
      candidateId,
      candidateEmail,
    })
  );

/**
 * Phase 3 — the attempt row was created (STARTED) or the first answer moved it
 * to IN_PROGRESS. `assessmentStatus` is the PERSISTED status, so the recruiter
 * row always mirrors PostgreSQL.
 */
const publishAttemptStartedEvent = ({
  jobId,
  assessmentId,
  candidateId = null,
  candidateEmail,
  assessmentStatus,
}) =>
  publishEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_STARTED,
      jobId,
      assessmentId,
      candidateId,
      candidateEmail,
      assessmentStatus,
    })
  );

/** Phase 3 — the attempt committed as SUBMITTED. */
const publishAttemptSubmittedEvent = ({ jobId, assessmentId, candidateId = null, candidateEmail }) =>
  publishEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_SUBMITTED,
      jobId,
      assessmentId,
      candidateId,
      candidateEmail,
    })
  );

/** Phase 3 — the attempt committed as TIMED_UP (lazy expiry or job sweep). */
const publishAttemptTimedUpEvent = ({ jobId, assessmentId, candidateId = null, candidateEmail }) =>
  publishEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_TIMED_UP,
      jobId,
      assessmentId,
      candidateId,
      candidateEmail,
    })
  );

/** Phase 5 — the attempt committed as CHEATED (deterministic integrity violation). */
const publishAttemptCheatedEvent = ({ jobId, assessmentId, attemptId, candidateId = null, candidateEmail }) =>
  publishEvent(
    buildCandidateStatusEvent({
      eventType: REALTIME_EVENT_TYPES.ASSESSMENT_CHEATED,
      jobId,
      assessmentId,
      candidateId,
      candidateEmail,
      assessmentStatus: "CHEATED",
    })
  );

/**
 * Phase 7 Step 6 — a committed candidate-analysis status transition. The event
 * is a notification only. It carries opaque resource identifiers and no result,
 * evidence, email, token, hash, or path. Call only after the authoritative DB
 * transition has committed; Redis failure is safely logged/dropped upstream.
 */
const publishCandidateAnalysisUpdatedEvent = ({
  jobId,
  referenceId,
  analysisId,
  analysisVersion,
  status,
  updatedAt,
}) =>
  publishEvent(
    buildCandidateAnalysisStatusEvent({
      eventType: REALTIME_EVENT_TYPES.CANDIDATE_ANALYSIS_UPDATED,
      jobId,
      referenceId,
      analysisId,
      analysisVersion,
      status,
      updatedAt,
    })
  );

/**
 * Job lifecycle — the job row committed CLOSED automatically because its
 * persisted availability deadline passed. A refetch signal only: it carries no
 * candidate, no email and no assessment content, and it is published strictly
 * AFTER the commit.
 */
const publishJobExpiredEvent = ({ jobId, closedAt = new Date() }) =>
  publishEvent(
    buildJobLifecycleEvent({
      eventType: REALTIME_EVENT_TYPES.JOB_EXPIRED,
      jobId,
      jobStatus: "CLOSED",
      closedAt,
    })
  );

module.exports = {
  publishInvitationEvent,
  publishEmailVerifiedEvent,
  publishAttemptStartedEvent,
  publishAttemptSubmittedEvent,
  publishAttemptTimedUpEvent,
  // Phase 5 — deterministic integrity violation (CHEATED attempt).
  publishAttemptCheatedEvent,
  // Phase 7 Step 6 — after-commit candidate-analysis status notification.
  publishCandidateAnalysisUpdatedEvent,
  // After-commit job lifecycle: the job expired and closed itself.
  publishJobExpiredEvent,
};
