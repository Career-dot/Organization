const attemptRepository = require("./jobAssessmentAttempt.repository");
const integrityRepository = require("./jobAssessmentIntegrity.repository");
const realtimePublisher = require("./jobAssessmentRealtime.publisher");
const {
  INTEGRITY_EVENT_TYPES,
  INTEGRITY_REASONS,
} = require("./jobAssessmentIntegrity.repository");

// ---------------------------------------------------------------------------
// Phase 5 — deterministic assessment integrity rule layer.
//
// DESIGN RULES (non-negotiable):
//   * NO AI. NO statistical-chance models. NO score. Every decision is a pure function of
//     persisted data plus the documented threshold below.
//   * PostgreSQL is the only authority. The hidden-event count is read from the
//     integrity-event table on every decision — never from an in-memory counter —
//     so the outcome is identical on every Express instance and survives a
//     restart.
//   * The browser is a SIGNAL SOURCE, never the judge: it may only report a
//     visibility transition, and only the server can reach CHEATED.
//   * A terminal attempt is never reopened. SUBMITTED / TIMED_UP / CHEATED stay
//     terminal under any number of concurrent requests.
//
// HONEST LIMITATION: this detects the configured technical signals only. It
// does not — and cannot — prove that no other form of cheating ever occurred.
// ---------------------------------------------------------------------------

// ===========================================================================
// THE DETERMINISTIC THRESHOLD (single named constant, enforced server-side)
//
//   MAX_VISIBILITY_HIDDEN_EVENTS = 10
//
// 10 PERSISTED VISIBILITY_HIDDEN events within one active attempt transition
// the attempt to CHEATED. This is the ONLY place the number is defined; the
// rule layer, the service and the verification harness all read it from here.
// ===========================================================================
const MAX_VISIBILITY_HIDDEN_EVENTS = 10;

const ACTIVE_ATTEMPT_STATUSES = ["STARTED", "IN_PROGRESS"];
const TERMINAL_ATTEMPT_STATUSES = ["SUBMITTED", "TIMED_UP", "CHEATED"];

const isActiveAttemptStatus = (status) => ACTIVE_ATTEMPT_STATUSES.includes(status);
const isTerminalAttemptStatus = (status) => TERMINAL_ATTEMPT_STATUSES.includes(status);

// The concise deterministic reasons a terminal CHEATED decision may cite.
const CHEAT_REASONS = {
  EXCESSIVE_VISIBILITY_CHANGES: INTEGRITY_REASONS.EXCESSIVE_VISIBILITY_CHANGES,
  TIMER_INTEGRITY_VIOLATION: INTEGRITY_REASONS.TIMER_INTEGRITY_VIOLATION,
  DUPLICATE_ATTEMPT: INTEGRITY_REASONS.DUPLICATE_ATTEMPT,
  PROHIBITED_CLIENT_ACTION: INTEGRITY_REASONS.PROHIBITED_CLIENT_ACTION,
  SERVER_INTEGRITY_VIOLATION: INTEGRITY_REASONS.SERVER_INTEGRITY_VIOLATION,
};

// Short recruiter-facing labels for the persisted reason values above. The
// recruiter sees a deterministic statement of fact — never an AI accusation.
const CHEAT_REASON_LABELS = {
  [CHEAT_REASONS.EXCESSIVE_VISIBILITY_CHANGES]: "Excessive visibility changes",
  [CHEAT_REASONS.TIMER_INTEGRITY_VIOLATION]: "Timer integrity violation",
  [CHEAT_REASONS.DUPLICATE_ATTEMPT]: "Duplicate attempt",
  [CHEAT_REASONS.PROHIBITED_CLIENT_ACTION]: "Prohibited client action",
  [CHEAT_REASONS.SERVER_INTEGRITY_VIOLATION]: "Server integrity violation",
};

const httpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// ---------------------------------------------------------------------------
// THE PURE RULE
// ---------------------------------------------------------------------------
// A side-effect-free decision function: given the reported signal and the
// PERSISTED hidden count BEFORE this signal, decide what to persist and whether
// the attempt must be terminated. No I/O, no clock, no randomness — which is
// exactly why it is directly testable.
const evaluateIntegritySignal = ({ type, priorHiddenCount = 0 }) => {
  switch (type) {
    case INTEGRITY_EVENT_TYPES.VISIBILITY_HIDDEN: {
      const hiddenCount = priorHiddenCount + 1;
      const reached = hiddenCount >= MAX_VISIBILITY_HIDDEN_EVENTS;
      return {
        eventType: INTEGRITY_EVENT_TYPES.VISIBILITY_HIDDEN,
        reason: INTEGRITY_REASONS.ASSESSMENT_TAB_HIDDEN,
        shouldPersist: true,
        shouldCheat: reached,
        // The decision event is written only when the threshold is actually met.
        terminalEventType: reached
          ? INTEGRITY_EVENT_TYPES.EXCESSIVE_VISIBILITY_CHANGES
          : null,
        terminalReason: reached ? CHEAT_REASONS.EXCESSIVE_VISIBILITY_CHANGES : null,
        hiddenCount,
      };
    }
    case INTEGRITY_EVENT_TYPES.VISIBILITY_VISIBLE:
      // Returning to the assessment is recorded for the audit trail but is
      // never, by itself, a violation.
      return {
        eventType: INTEGRITY_EVENT_TYPES.VISIBILITY_VISIBLE,
        reason: INTEGRITY_REASONS.ASSESSMENT_TAB_VISIBLE,
        shouldPersist: true,
        shouldCheat: false,
        terminalEventType: null,
        terminalReason: null,
        hiddenCount: priorHiddenCount,
      };
    default:
      // An unknown signal is never persisted and never a decision. The HTTP
      // boundary already restricts the accepted types; this is defence in depth.
      return {
        eventType: null,
        reason: null,
        shouldPersist: false,
        shouldCheat: false,
        terminalEventType: null,
        terminalReason: null,
        hiddenCount: priorHiddenCount,
      };
  }
};

// ---------------------------------------------------------------------------
// THE ONE AUTHORITATIVE TERMINAL TRANSITION
// ---------------------------------------------------------------------------
// Atomic + idempotent + terminal:
//   * the UPDATE is conditional on the attempt still being ACTIVE, so exactly
//     one concurrent request can win the transition (the losers update 0 rows
//     and publish nothing);
//   * an attempt already SUBMITTED / TIMED_UP / CHEATED matches no row and is
//     therefore never reopened;
//   * called twice with the same reason it changes nothing the second time.
// Returns { transitioned, attempt } where `transitioned` is TRUE only for the
// caller that actually performed the transition.
const markAttemptCheated = async ({ attemptId, reason, now = new Date() }) => {
  const changed = await attemptRepository.markAttemptCheated(attemptId, {
    reason,
    now,
    fromStatuses: ACTIVE_ATTEMPT_STATUSES,
  });

  const attempt = await attemptRepository.findAttemptById(attemptId);
  return { transitioned: changed > 0, attempt };
};

// Only a small whitelist of client-supplied detail is ever stored: everything
// else is dropped so a hostile body cannot inflate or poison the event log.
const MAX_METADATA_KEYS = 6;
const sanitizeMetadata = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  let taken = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (taken >= MAX_METADATA_KEYS) break;
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(key)) continue;
    if (raw === null || typeof raw === "boolean" || typeof raw === "number") {
      out[key] = raw;
      taken += 1;
    } else if (typeof raw === "string" && raw.length <= 120) {
      out[key] = raw;
      taken += 1;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// VISIBILITY SIGNAL PIPELINE
// ---------------------------------------------------------------------------
// Signal → persist → (deterministic threshold against the PERSISTED count) →
// atomic terminal CAS → publish (only after the CAS committed).
//
// Every step is server-side. A Redis outage after commit cannot roll back the
// decision, and nothing is published unless the transition really committed.
const processVisibilitySignal = async ({ attempt, type, metadata = {} }) => {
  if (!attempt) {
    throw httpError(404, "No active attempt found for this assessment");
  }
  if (!isActiveAttemptStatus(attempt.status)) {
    // Terminal attempts accept no further signals: the failure is explicit and
    // carries the persisted status (no attempt is ever silently mutated).
    throw httpError(
      409,
      attempt.status === "CHEATED"
        ? "This attempt was already terminated for an integrity violation"
        : `This attempt is already ${attempt.status}`
    );
  }

  // The threshold counts PERSISTED rows only. Duplicate or concurrent
  // deliveries each add one row here, so the count can never drift from
  // PostgreSQL and is identical on every Express instance.
  const priorHiddenCount = await integrityRepository.countIntegrityEventsByType(
    attempt.id,
    INTEGRITY_EVENT_TYPES.VISIBILITY_HIDDEN
  );

  const decision = evaluateIntegritySignal({ type, priorHiddenCount });
  if (!decision.shouldPersist) {
    throw httpError(400, "Only visibility signals are accepted from the browser");
  }

  // 1. Persist the reported signal (append-only audit trail).
  const event = await integrityRepository.createIntegrityEvent({
    attemptId: attempt.id,
    type: decision.eventType,
    reason: decision.reason,
    metadata: {
      // Bounded, non-sensitive context only.
      visibilityState:
        decision.eventType === INTEGRITY_EVENT_TYPES.VISIBILITY_HIDDEN ? "hidden" : "visible",
      hiddenCount: decision.hiddenCount,
      ...sanitizeMetadata(metadata),
    },
  });

  if (!decision.shouldCheat) {
    return { event, applied: { transitioned: false, newStatus: attempt.status, reason: null } };
  }

  // 2. Threshold reached — record the decision event, then transition.
  const decisionEvent = await integrityRepository.createIntegrityEvent({
    attemptId: attempt.id,
    type: decision.terminalEventType,
    reason: decision.terminalReason,
    metadata: {
      hiddenCount: decision.hiddenCount,
      threshold: MAX_VISIBILITY_HIDDEN_EVENTS,
      triggeringEventId: event.id,
    },
  });

  const { transitioned, attempt: after } = await markAttemptCheated({
    attemptId: attempt.id,
    reason: decision.terminalReason,
  });

  // 3. Publish ONLY when THIS caller committed the transition (DB commit →
  //    publish, never the other way round). A lost race publishes nothing, so
  //    the recruiter sees exactly one CHEATED event per real transition.
  if (transitioned && after) {
    realtimePublisher.publishAttemptCheatedEvent({
      jobId: after.jobId,
      assessmentId: after.assessmentId,
      attemptId: after.id,
      candidateId: null,
      candidateEmail: after.email,
    });
  }

  return {
    event,
    decisionEvent,
    applied: {
      transitioned,
      newStatus: transitioned ? "CHEATED" : after?.status ?? attempt.status,
      reason: decision.terminalReason,
    },
  };
};

// The persisted integrity view for one attempt. Exposes the deterministic facts
// (type + reason + when) and deliberately no answer/token data.
const listAttemptIntegrityEvents = async (attemptId) =>
  integrityRepository.listIntegrityEventsByAttempt(attemptId);

module.exports = {
  MAX_VISIBILITY_HIDDEN_EVENTS,
  ACTIVE_ATTEMPT_STATUSES,
  TERMINAL_ATTEMPT_STATUSES,
  CHEAT_REASONS,
  CHEAT_REASON_LABELS,
  isActiveAttemptStatus,
  isTerminalAttemptStatus,
  evaluateIntegritySignal,
  markAttemptCheated,
  processVisibilitySignal,
  listAttemptIntegrityEvents,
};
