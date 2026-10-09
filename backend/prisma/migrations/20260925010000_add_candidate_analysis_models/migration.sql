-- Phase 7 (Step 1) — AiJob.scopeKey + the widened AiJob unique, plus the two
-- candidate-analysis tables. Purely additive:
--
-- * Existing AiJob rows take scopeKey = '' (column default), so the widened
--   unique still admits exactly one row per (jobId, operation) for
--   JOB_ANALYSIS / ASSESSMENT_GENERATION. The DRAFT → ACTIVE compare-and-swap
--   invariant (duplicate AiJob → P2002 → 409) is preserved unchanged.
-- * JobCandidateAnalysis.aiJobId is 1:1 and ON DELETE RESTRICT, mirroring the
--   existing JobAssessment.aiJob pattern: the analysis row is deleted before
--   its AiJob, never silently orphaned.
-- * Candidate data is job-scoped by construction: both new tables cascade with
--   the Job, and JobCandidateReference is unique per (jobId, candidateEmail),
--   so one job's references can never be read through another job.

-- AlterTable
ALTER TABLE "AiJob" ADD COLUMN "scopeKey" TEXT NOT NULL DEFAULT '';

-- DropIndex
DROP INDEX "AiJob_jobId_operation_key";

-- CreateIndex
CREATE UNIQUE INDEX "AiJob_jobId_operation_scopeKey_key" ON "AiJob"("jobId", "operation", "scopeKey");

-- CreateTable
CREATE TABLE "JobCandidateReference" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "candidateEmail" TEXT NOT NULL,
    "candidateName" TEXT,
    "linkedinUrl" TEXT,
    "linkedinText" TEXT,
    "githubUrl" TEXT,
    "githubText" TEXT,
    "preferredRole" TEXT,
    "skills" JSONB,
    "skillNotes" TEXT,
    "resumeFileId" TEXT,
    "resumeText" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCandidateReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCandidateAnalysis" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "aiJobId" TEXT NOT NULL,
    "candidateEmail" TEXT NOT NULL,
    "candidateName" TEXT,
    "analysisVersion" INTEGER NOT NULL DEFAULT 1,
    "candidateKey" TEXT,
    "referenceId" TEXT,
    "attemptId" TEXT,
    "snapshotHash" TEXT,
    "schemaVersion" TEXT,
    "result" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCandidateAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobCandidateReference_resumeFileId_key" ON "JobCandidateReference"("resumeFileId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCandidateReference_jobId_candidateEmail_key" ON "JobCandidateReference"("jobId", "candidateEmail");

-- CreateIndex
CREATE INDEX "JobCandidateReference_jobId_idx" ON "JobCandidateReference"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCandidateAnalysis_aiJobId_key" ON "JobCandidateAnalysis"("aiJobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCandidateAnalysis_jobId_candidateEmail_analysisVersion_key" ON "JobCandidateAnalysis"("jobId", "candidateEmail", "analysisVersion");

-- CreateIndex
CREATE INDEX "JobCandidateAnalysis_attemptId_idx" ON "JobCandidateAnalysis"("attemptId");

-- CreateIndex
CREATE INDEX "JobCandidateAnalysis_referenceId_idx" ON "JobCandidateAnalysis"("referenceId");

-- AddForeignKey
ALTER TABLE "JobCandidateReference" ADD CONSTRAINT "JobCandidateReference_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCandidateReference" ADD CONSTRAINT "JobCandidateReference_resumeFileId_fkey" FOREIGN KEY ("resumeFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCandidateAnalysis" ADD CONSTRAINT "JobCandidateAnalysis_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCandidateAnalysis" ADD CONSTRAINT "JobCandidateAnalysis_aiJobId_fkey" FOREIGN KEY ("aiJobId") REFERENCES "AiJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCandidateAnalysis" ADD CONSTRAINT "JobCandidateAnalysis_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "JobCandidateReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCandidateAnalysis" ADD CONSTRAINT "JobCandidateAnalysis_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "JobAssessmentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
