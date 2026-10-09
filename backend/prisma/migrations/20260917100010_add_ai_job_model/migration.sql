-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiJobOperation" AS ENUM ('JOB_ANALYSIS');

-- CreateTable
CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "operation" "AiJobOperation" NOT NULL,
    "status" "AiJobStatus" NOT NULL DEFAULT 'PENDING',
    "requestPayload" JSONB NOT NULL,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "provider" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "workerId" TEXT,
    "lastEnqueuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiJob_status_updatedAt_idx" ON "AiJob"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AiJob_jobId_idx" ON "AiJob"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "AiJob_jobId_operation_key" ON "AiJob"("jobId", "operation");

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
