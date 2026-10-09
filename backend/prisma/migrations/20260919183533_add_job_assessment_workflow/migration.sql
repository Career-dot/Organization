-- CreateEnum
CREATE TYPE "JobAnalysisSection" AS ENUM ('JOB_OVERVIEW', 'RESPONSIBILITIES', 'REQUIRED_SKILLS', 'TOOLS_SOFTWARE');

-- CreateEnum
CREATE TYPE "JobAssessmentStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- AlterEnum
ALTER TYPE "AiJobOperation" ADD VALUE 'ASSESSMENT_GENERATION';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "clarificationsApprovedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "JobClarificationQuestion" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "aiJobId" TEXT NOT NULL,
    "section" "JobAnalysisSection" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobClarificationQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAssessment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "aiJobId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "JobAssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "publicId" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAssessmentQuestion" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "section" "JobAnalysisSection" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "questionType" "AssessmentQuestionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "difficulty" "AssessmentDifficulty",
    "guidance" TEXT,
    "options" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAssessmentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobClarificationQuestion_jobId_section_sortOrder_idx" ON "JobClarificationQuestion"("jobId", "section", "sortOrder");

-- CreateIndex
CREATE INDEX "JobClarificationQuestion_jobId_sortOrder_idx" ON "JobClarificationQuestion"("jobId", "sortOrder");

-- CreateIndex
CREATE INDEX "JobClarificationQuestion_aiJobId_idx" ON "JobClarificationQuestion"("aiJobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAssessment_jobId_key" ON "JobAssessment"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAssessment_aiJobId_key" ON "JobAssessment"("aiJobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAssessment_publicId_key" ON "JobAssessment"("publicId");

-- CreateIndex
CREATE INDEX "JobAssessment_status_idx" ON "JobAssessment"("status");

-- CreateIndex
CREATE INDEX "JobAssessmentQuestion_assessmentId_section_idx" ON "JobAssessmentQuestion"("assessmentId", "section");

-- CreateIndex
CREATE UNIQUE INDEX "JobAssessmentQuestion_assessmentId_sortOrder_key" ON "JobAssessmentQuestion"("assessmentId", "sortOrder");

-- AddForeignKey
ALTER TABLE "JobClarificationQuestion" ADD CONSTRAINT "JobClarificationQuestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobClarificationQuestion" ADD CONSTRAINT "JobClarificationQuestion_aiJobId_fkey" FOREIGN KEY ("aiJobId") REFERENCES "AiJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssessment" ADD CONSTRAINT "JobAssessment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssessment" ADD CONSTRAINT "JobAssessment_aiJobId_fkey" FOREIGN KEY ("aiJobId") REFERENCES "AiJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssessmentQuestion" ADD CONSTRAINT "JobAssessmentQuestion_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "JobAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
