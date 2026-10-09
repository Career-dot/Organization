-- Added for recruiter-controlled candidate assessment duration.
--
-- durationSeconds is the candidate-facing test timer (whole seconds). It is
-- recruiter-set/editable on the draft assessment and is NOT decided by the AI —
-- the AI generation input never carries a duration, so the column is backfilled
-- with a fixed default at generation time. It is a separate concept from
-- Job.analysisDays (which bounds the recruitment/analysis window), not the
-- candidate test timer.
--
-- The column is nullable-safe for existing rows: every pre-existing
-- JobAssessment row gets the default (600s = 10 minutes).

ALTER TABLE "JobAssessment" ADD COLUMN "durationSeconds" INTEGER NOT NULL DEFAULT 600;
