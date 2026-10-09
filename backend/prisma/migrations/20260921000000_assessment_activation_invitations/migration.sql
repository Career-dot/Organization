-- Assessment activation + candidate invitations.
--
-- activatedAt on JobAssessment: the recruiter's confirmation that a FINALIZED
-- assessment is open for invitations. Null until the authenticated activate
-- action succeeds; candidates cannot be invited or authorized before it.
-- Additive: no status value changes, so every existing FINALIZED/DRAFT query
-- keeps its meaning.
--
-- JobAssessmentInvitation: one candidate's authorization for ONE job's
-- assessment. The (assessmentId, email) unique index is the storage-level
-- duplicate-invitation guard; email is stored normalized (trimmed, lowercase)
-- so matching is case-insensitive by construction. expiresAt is the exact
-- authoritative completion deadline (derived from the job's analysis-days
-- setting via a fixed backend mapping — never a bare day-count). The
-- verification challenge is stored only as a SHA-256 hash.

ALTER TABLE "JobAssessment" ADD COLUMN "activatedAt" TIMESTAMP(3);

CREATE TYPE "JobAssessmentInvitationStatus" AS ENUM ('INVITED', 'EMAIL_VERIFIED');

CREATE TABLE "JobAssessmentInvitation" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "JobAssessmentInvitationStatus" NOT NULL DEFAULT 'INVITED',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "verificationTokenHash" TEXT,
    "verificationExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAssessmentInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobAssessmentInvitation_assessmentId_email_key"
  ON "JobAssessmentInvitation"("assessmentId", "email");

CREATE INDEX "JobAssessmentInvitation_jobId_idx"
  ON "JobAssessmentInvitation"("jobId");

CREATE INDEX "JobAssessmentInvitation_status_expiresAt_idx"
  ON "JobAssessmentInvitation"("status", "expiresAt");

ALTER TABLE "JobAssessmentInvitation"
  ADD CONSTRAINT "JobAssessmentInvitation_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobAssessmentInvitation"
  ADD CONSTRAINT "JobAssessmentInvitation_assessmentId_fkey"
  FOREIGN KEY ("assessmentId") REFERENCES "JobAssessment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
