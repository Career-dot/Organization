const prisma = require("../../config/prisma");

// ---------------------------------------------------------------------------
// Phase 5 — assessment integrity signal persistence.
//
// ALL integrity-event database access lives here. Rows are append-only: a
// signal is recorded once and is never edited or deleted by application code,
// which is what makes the integrity history auditable and restart-proof.
//
// The table is the authority for the deterministic threshold: the rule layer
// counts PERSISTED rows (never an in-memory counter), so the count is identical
// on every Express instance and survives a process restart.
// ---------------------------------------------------------------------------

// Mirrors the JobAssessmentAttemptIntegrityEventType enum. Kept as an explicit
// object so the service/verifier and the Zod boundary share ONE definition and
// a decision can only ever cite a rule that actually exists.
const INTEGRITY_EVENT_TYPES = {
  VISIBILITY_HIDDEN: "VISIBILITY_HIDDEN",
  VISIBILITY_VISIBLE: "VISIBILITY_VISIBLE",
  EXCESSIVE_VISIBILITY_CHANGES: "EXCESSIVE_VISIBILITY_CHANGES",
  DUPLICATE_ATTEMPT: "DUPLICATE_ATTEMPT",
  TIMER_INTEGRITY_VIOLATION: "TIMER_INTEGRITY_VIOLATION",
  PROHIBITED_CLIENT_ACTION: "PROHIBITED_CLIENT_ACTION",
  SERVER_INTEGRITY_VIOLATION: "SERVER_INTEGRITY_VIOLATION",
};

const INTEGRITY_EVENT_TYPE_VALUES = Object.values(INTEGRITY_EVENT_TYPES);

// The structured reason labels persisted alongside an event (and, for a
// terminal decision, as JobAssessmentAttempt.cheatReason). Enum-style values
// instead of prose: deterministic, translatable and safe to show a recruiter.
const INTEGRITY_REASONS = {
  ASSESSMENT_TAB_HIDDEN: "ASSESSMENT_TAB_HIDDEN",
  ASSESSMENT_TAB_VISIBLE: "ASSESSMENT_TAB_VISIBLE",
  EXCESSIVE_VISIBILITY_CHANGES: "EXCESSIVE_VISIBILITY_CHANGES",
  DUPLICATE_ATTEMPT: "DUPLICATE_ATTEMPT",
  TIMER_INTEGRITY_VIOLATION: "TIMER_INTEGRITY_VIOLATION",
  PROHIBITED_CLIENT_ACTION: "PROHIBITED_CLIENT_ACTION",
  SERVER_INTEGRITY_VIOLATION: "SERVER_INTEGRITY_VIOLATION",
};

// A single append. `metadata` is bounded non-sensitive context only.
const createIntegrityEvent = async ({ attemptId, type, reason, metadata = {}, occurredAt }) =>
  prisma.jobAssessmentAttemptIntegrityEvent.create({
    data: {
      attemptId,
      type,
      reason,
      metadata,
      ...(occurredAt ? { occurredAt } : {}),
    },
  });

// The deterministic threshold source: the PERSISTED count for one attempt.
const countIntegrityEventsByType = async (attemptId, type) =>
  prisma.jobAssessmentAttemptIntegrityEvent.count({ where: { attemptId, type } });

// Full persisted history for one attempt, oldest first — used by the recruiter
// side and the verifier (never exposed wholesale to a browser).
const listIntegrityEventsByAttempt = async (attemptId) =>
  prisma.jobAssessmentAttemptIntegrityEvent.findMany({
    where: { attemptId },
    orderBy: { occurredAt: "asc" },
    select: { id: true, attemptId: true, type: true, reason: true, metadata: true, occurredAt: true },
  });

const findLatestIntegrityEvent = async (attemptId, type) =>
  prisma.jobAssessmentAttemptIntegrityEvent.findFirst({
    where: { attemptId, ...(type ? { type } : {}) },
    orderBy: { occurredAt: "desc" },
  });

module.exports = {
  INTEGRITY_EVENT_TYPES,
  INTEGRITY_EVENT_TYPE_VALUES,
  INTEGRITY_REASONS,
  createIntegrityEvent,
  countIntegrityEventsByType,
  listIntegrityEventsByAttempt,
  findLatestIntegrityEvent,
};
