-- PHASE 1 — make recruiter deletion genuinely permanent WITHOUT destroying the
-- organization's historical job data.
--
-- Before this migration:
--   Job.createdByUserId  TEXT NOT NULL  REFERENCES "User"(id) ON DELETE RESTRICT
--   Job.recruiterId      TEXT          REFERENCES "User"(id) ON DELETE RESTRICT
--
-- RESTRICT on a required column meant that once a recruiter had posted a single
-- job, PostgreSQL refused to delete their User row — the account could only ever
-- be "REMOVED", never actually deleted. The only way to satisfy RESTRICT would
-- have been to delete the jobs, which would have cascade-deleted every candidate,
-- assessment attempt, score and AI candidate analysis attached to them. Those
-- rows are the ORGANIZATION's historical record, not the recruiter's, so that is
-- not an acceptable trade.
--
-- After this migration both ownership links DETACH (SetNull) and
-- createdByUserId becomes nullable, so deleting a recruiter nulls the link and
-- leaves the job and all of its historical rows exactly as they were.
--
-- No other User relation needs changing: every other FK pointing at "User"
-- already cascades (AuditLog, EmailVerificationToken, EmployeeProfile,
-- LoginSession, Notification, OrganizationMembership, PasswordHistory,
-- PasswordResetToken, RecruiterProfile, RefreshToken, Subscription, UserRole,
-- VerificationAttempt), so account-scoped rows are removed with the account.
--
-- Note: JobCandidateReference.createdByUserId is NOT NULL but has NO foreign key
-- to "User" (verified against pg_constraint) — it is a denormalized audit column,
-- so it needs no migration and creates no orphan/FK violation.

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_recruiterId_fkey";

-- AlterColumn
ALTER TABLE "Job" ALTER COLUMN "createdByUserId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;