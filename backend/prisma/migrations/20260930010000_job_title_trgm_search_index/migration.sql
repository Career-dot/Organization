-- Recruiter read-only Jobs overview — search/filter support.
--
-- WHY THIS MIGRATION IS NEEDED (and why it is the ONLY new index):
--
-- The recruiter Jobs list is filtered SERVER-SIDE by a free-text term over the
-- job title. A plain btree index cannot serve a `ILIKE '%term%'` predicate, so
-- without this the query degrades to a sequential scan of the caller's job rows
-- on every keystroke-driven request. pg_trgm's GIN index makes the same
-- substring predicate index-backed.
--
-- Scope notes:
--   * The extension is additive and standard. The trigram operator class is only
--     used by this one new index, so nothing else in the schema changes.
--   * Job ownership scoping (recruiterId / organizationId) and the existing
--     status+createdAt btree indexes are UNCHANGED — this migration only makes
--     the title predicate indexable.
--   * This migration is purely additive: no existing column, table, constraint or
--     already-applied migration is modified.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Job_title_trgm_idx"
  ON "Job" USING GIN ("title" gin_trgm_ops);
