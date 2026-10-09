-- Phase 5 — deterministic assessment integrity / cheating detection.
--
-- 1. JobAssessmentAttemptStatus gains CHEATED as a terminal state. It is reached
--    ONLY by the server-side rule layer after a persisted, documented threshold
--    is met — never by a client claiming it. CANCELLED remains unmodelled.
--
-- 2. JobAssessmentAttemptIntegrityEventType — the enumerated integrity signals.
--    Enumerated, not free-form, so a decision can only cite a rule the server
--    actually implements.
--
-- 3. JobAssessmentAttemptIntegrityEvent — one row per PERSISTED integrity
--    signal. Survives browser refresh / Express restart / multiple instances;
--    nothing critical lives in Node memory.
--
-- 4. JobAssessmentAttempt.cheatedAt + cheatReason — the terminal transition
--    timestamp and the concise deterministic reason label the recruiter UI
--    shows. No score, no percentage, no AI output.
--
-- Existing rows are untouched: every new column is nullable and the new table is
-- purely additive.

ALTER TYPE "JobAssessmentAttemptStatus" ADD VALUE IF NOT EXISTS 'CHEATED';

CREATE TYPE "JobAssessmentAttemptIntegrityEventType" AS ENUM (
  'VISIBILITY_HIDDEN',
  'VISIBILITY_VISIBLE',
  'EXCESSIVE_VISIBILITY_CHANGES',
  'DUPLICATE_ATTEMPT',
  'TIMER_INTEGRITY_VIOLATION',
  'PROHIBITED_CLIENT_ACTION',
  'SERVER_INTEGRITY_VIOLATION'
);

CREATE TABLE "JobAssessmentAttemptIntegrityEvent" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "type" "JobAssessmentAttemptIntegrityEventType" NOT NULL,
  "reason" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobAssessmentAttemptIntegrityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobAssessmentAttemptIntegrityEvent_attemptId_idx"
  ON "JobAssessmentAttemptIntegrityEvent"("attemptId");
CREATE INDEX "JobAssessmentAttemptIntegrityEvent_attemptId_occurredAt_idx"
  ON "JobAssessmentAttemptIntegrityEvent"("attemptId", "occurredAt");
CREATE INDEX "JobAssessmentAttemptIntegrityEvent_attemptId_type_idx"
  ON "JobAssessmentAttemptIntegrityEvent"("attemptId", "type");
CREATE INDEX "JobAssessmentAttemptIntegrityEvent_type_idx"
  ON "JobAssessmentAttemptIntegrityEvent"("type");

ALTER TABLE "JobAssessmentAttemptIntegrityEvent"
  ADD CONSTRAINT "JobAssessmentAttemptIntegrityEvent_attemptId_fkey"
  FOREIGN KEY ("attemptId")
  REFERENCES "JobAssessmentAttempt"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "JobAssessmentAttempt" ADD COLUMN "cheatedAt" TIMESTAMP(3);
ALTER TABLE "JobAssessmentAttempt" ADD COLUMN "cheatReason" TEXT;
