-- AlterEnum
ALTER TYPE "FileCategory" ADD VALUE 'JOB_CANDIDATE_LIST';

-- CreateTable
CREATE TABLE "JobCandidateList" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCandidateList_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobCandidateList_jobId_key" ON "JobCandidateList"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCandidateList_fileId_key" ON "JobCandidateList"("fileId");

-- AddForeignKey
ALTER TABLE "JobCandidateList" ADD CONSTRAINT "JobCandidateList_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCandidateList" ADD CONSTRAINT "JobCandidateList_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
