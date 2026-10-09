/*
  Warnings:

  - You are about to drop the column `currency` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `expiresAt` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `jobType` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `location` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `salaryMax` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `salaryMin` on the `Job` table. All the data in the column will be lost.
  - The `status` column on the `Job` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "JobClosedReason" AS ENUM ('SYSTEM_EXPIRED', 'RECRUITER_CLOSED');

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_recruiterId_fkey";

-- DropIndex
DROP INDEX "Job_createdAt_idx";

-- DropIndex
DROP INDEX "Job_organizationId_createdAt_idx";

-- DropIndex
DROP INDEX "Job_recruiterId_createdAt_idx";

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "currency",
DROP COLUMN "expiresAt",
DROP COLUMN "jobType",
DROP COLUMN "location",
DROP COLUMN "salaryMax",
DROP COLUMN "salaryMin",
ADD COLUMN     "analysisDays" INTEGER,
ADD COLUMN     "analysisEndsAt" TIMESTAMP(3),
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedReason" "JobClosedReason",
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "yearsExperience" INTEGER,
ALTER COLUMN "description" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "JobStatus" NOT NULL DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "JobSkill" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTool" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobQuestion" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobQuotaConsumption" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobQuotaConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobSkill_jobId_sortOrder_idx" ON "JobSkill"("jobId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "JobSkill_jobId_name_key" ON "JobSkill"("jobId", "name");

-- CreateIndex
CREATE INDEX "JobTool_jobId_sortOrder_idx" ON "JobTool"("jobId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "JobTool_jobId_name_key" ON "JobTool"("jobId", "name");

-- CreateIndex
CREATE INDEX "JobQuestion_jobId_sortOrder_idx" ON "JobQuestion"("jobId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "JobQuotaConsumption_jobId_key" ON "JobQuotaConsumption"("jobId");

-- CreateIndex
CREATE INDEX "JobQuotaConsumption_subscriptionId_consumedAt_idx" ON "JobQuotaConsumption"("subscriptionId", "consumedAt");

-- CreateIndex
CREATE INDEX "Job_recruiterId_status_createdAt_idx" ON "Job"("recruiterId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_organizationId_status_createdAt_idx" ON "Job"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_createdByUserId_status_createdAt_idx" ON "Job"("createdByUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSkill" ADD CONSTRAINT "JobSkill_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTool" ADD CONSTRAINT "JobTool_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQuestion" ADD CONSTRAINT "JobQuestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQuotaConsumption" ADD CONSTRAINT "JobQuotaConsumption_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQuotaConsumption" ADD CONSTRAINT "JobQuotaConsumption_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
