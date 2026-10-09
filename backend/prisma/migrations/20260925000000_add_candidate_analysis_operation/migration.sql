-- Phase 7 (Step 1) — additive enum widening only. Both labels are written by
-- later steps; no existing row changes meaning and no constraint is touched.
--
-- `ALTER TYPE ... ADD VALUE` is transaction-safe on PostgreSQL 12+ as long as
-- the new label is not *used* inside the same transaction — this migration only
-- declares the labels, so it is safe under Prisma's per-migration transaction.
-- Target verified: PostgreSQL 16.6.
ALTER TYPE "AiJobOperation" ADD VALUE 'CANDIDATE_ANALYSIS';
ALTER TYPE "FileCategory" ADD VALUE 'JOB_CANDIDATE_RESUME';
