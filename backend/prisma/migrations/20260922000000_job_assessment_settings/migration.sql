-- Recruiter-selected assessment configuration, stored on the Job.
--
-- These are the recruiter's REQUESTED assessment settings, captured at job
-- setup time and frozen into the assessment-generation snapshot at Continue:
--   * assessmentQuestionCount  — how many questions the assessment should have
--   * assessmentDurationSeconds — the candidate test timer, in whole seconds
--
-- Neither value is an AI decision. assessmentQuestionCount is sent to the AI
-- service as a REQUIREMENT (the AI must produce exactly that many questions,
-- subject to the 45-question platform maximum); assessmentDurationSeconds is
-- never part of the AI contract at all and is applied by the backend when the
-- assessment is persisted.
--
-- Deliberately distinct from, and never interchangeable with:
--   * Job.analysisDays            — the recruitment/analysis window
--   * JobAssessmentInvitation.expiresAt — the candidate's invitation deadline
--   * JobAssessment.durationSeconds     — the materialized assessment timer
--     (copied from this value at generation time; separately editable on the
--     draft assessment, up to the same 5400s ceiling)
--
-- Both columns are nullable so every pre-existing Job is untouched and keeps the
-- legacy behaviour (no requested count = AI free-form subject to the 45 hard
-- cap; no configured duration = the 600s default).

ALTER TABLE "Job" ADD COLUMN "assessmentQuestionCount" INTEGER;
ALTER TABLE "Job" ADD COLUMN "assessmentDurationSeconds" INTEGER;
