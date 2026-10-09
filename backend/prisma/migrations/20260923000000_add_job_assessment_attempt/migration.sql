-- Phase 3 — the candidate's PERSISTENT assessment attempt.
--
-- PostgreSQL becomes the single authority for attempt existence, lifecycle
-- state and the server-side timer. Nothing here resets or rewrites any
-- existing table: this migration only ADDS one enum, two tables and their
-- constraints/indexes.
--
-- JobAssessmentAttempt — ONE invitation + ONE assessment = ONE attempt:
--   * (assessmentId, email) unique   → one attempt per candidate + assessment
--   * invitationId unique            → one attempt per invitation row
--   * startedAt/deadlineAt           → written ONCE by the backend at Start;
--     deadlineAt = startedAt + JobAssessment.durationSeconds (server time).
--     The browser never supplies start time, deadline or duration.
--   * expiry is enforced lazily against the persisted deadline (no in-memory
--     timer), so a backend restart can neither lose nor reset it.
--   * SUBMITTED / TIMED_UP are terminal. CANCELLED / CHEATED are deliberately
--     not modelled yet (later phases).
--
-- JobAssessmentAttemptAnswer — one row per (attempt, question); repeated saves
-- UPDATE the same row. `answer` is JSONB because the existing question types
-- carry different shapes (choice / choices / text); the shape is validated per
-- question type in the service before anything is written, and every write
-- re-verifies that the question belongs to the attempt's assessment.
--
-- All FKs cascade (Job → assessment → attempt → answers), matching the
-- existing job-assessment delete chain, so no orphan rows can ever remain.

CREATE TYPE "JobAssessmentAttemptStatus" AS ENUM ('STARTED', 'IN_PROGRESS', 'SUBMITTED', 'TIMED_UP');

CREATE TABLE "JobAssessmentAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "JobAssessmentAttemptStatus" NOT NULL DEFAULT 'STARTED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "timedOutAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAssessmentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobAssessmentAttemptAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answer" JSONB,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAssessmentAttemptAnswer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobAssessmentAttempt_invitationId_key" ON "JobAssessmentAttempt"("invitationId");
CREATE UNIQUE INDEX "JobAssessmentAttempt_assessmentId_email_key" ON "JobAssessmentAttempt"("assessmentId", "email");
CREATE INDEX "JobAssessmentAttempt_assessmentId_status_idx" ON "JobAssessmentAttempt"("assessmentId", "status");
CREATE INDEX "JobAssessmentAttempt_jobId_status_idx" ON "JobAssessmentAttempt"("jobId", "status");
CREATE UNIQUE INDEX "JobAssessmentAttemptAnswer_attemptId_questionId_key" ON "JobAssessmentAttemptAnswer"("attemptId", "questionId");
CREATE INDEX "JobAssessmentAttemptAnswer_questionId_idx" ON "JobAssessmentAttemptAnswer"("questionId");

ALTER TABLE "JobAssessmentAttempt" ADD CONSTRAINT "JobAssessmentAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "JobAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAssessmentAttempt" ADD CONSTRAINT "JobAssessmentAttempt_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "JobAssessmentInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAssessmentAttempt" ADD CONSTRAINT "JobAssessmentAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAssessmentAttemptAnswer" ADD CONSTRAINT "JobAssessmentAttemptAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "JobAssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAssessmentAttemptAnswer" ADD CONSTRAINT "JobAssessmentAttemptAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "JobAssessmentQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
