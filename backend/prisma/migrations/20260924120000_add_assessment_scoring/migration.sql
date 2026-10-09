-- Phase 6 — REAL deterministic server-side assessment scoring.
--
-- JobAssessmentQuestion.correctAnswer — the trusted server-side answer key.
-- Shape by questionType: SINGLE_CHOICE {"choice": "..."} / MULTIPLE_CHOICE
-- {"choices": [...]}; NULL for text-shaped questions (never auto-graded) and
-- for every pre-existing row (backfill is deliberately out of scope: a legacy
-- question without a key is ungraded, never guessed). Nullable so this
-- migration is purely additive — no existing row is touched.
ALTER TABLE "JobAssessmentQuestion" ADD COLUMN "correctAnswer" JSONB;

-- JobAssessmentAttempt score triple — written atomically with the
-- ACTIVE → SUBMITTED transition; NULL until then (and always NULL for
-- TIMED_UP/CHEATED). DECIMAL(65,30) mirrors VerificationAttempt.testScorePercentage.
ALTER TABLE "JobAssessmentAttempt" ADD COLUMN "score" INTEGER;
ALTER TABLE "JobAssessmentAttempt" ADD COLUMN "maxScore" INTEGER;
ALTER TABLE "JobAssessmentAttempt" ADD COLUMN "scorePercentage" DECIMAL(65,30);