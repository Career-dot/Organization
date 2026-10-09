-- CreateEnum
CREATE TYPE "JobEmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "JobWorkMode" AS ENUM ('REMOTE', 'HYBRID', 'ON_SITE');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "employmentType" "JobEmploymentType",
ADD COLUMN     "location" TEXT,
ADD COLUMN     "workMode" "JobWorkMode";

-- AlterTable
ALTER TABLE "JobAssessmentQuestion" ADD COLUMN     "requirementKey" TEXT;

-- CreateTable
CREATE TABLE "JobResponsibility" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobResponsibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEducationRequirement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobEducationRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobResponsibility_jobId_sortOrder_idx" ON "JobResponsibility"("jobId", "sortOrder");

-- CreateIndex
CREATE INDEX "JobEducationRequirement_jobId_sortOrder_idx" ON "JobEducationRequirement"("jobId", "sortOrder");

-- AddForeignKey
ALTER TABLE "JobResponsibility" ADD CONSTRAINT "JobResponsibility_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEducationRequirement" ADD CONSTRAINT "JobEducationRequirement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
