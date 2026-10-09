-- CreateEnum
CREATE TYPE "FileOwnerType" AS ENUM ('EMPLOYEE', 'RECRUITER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('PROFILE_IMAGE', 'SKILL_EVIDENCE', 'OTHER_CERTIFICATE', 'PROJECT_FILE', 'RECRUITER_VERIFICATION', 'RECRUITER_DOCUMENT', 'ORGANIZATION_VERIFICATION', 'ORGANIZATION_DOCUMENT', 'OTHER');

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "ownerType" "FileOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "category" "FileCategory" NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "employeeProfileId" TEXT,
    "skillId" TEXT,
    "certificateId" TEXT,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoredFile_ownerType_ownerId_idx" ON "StoredFile"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "StoredFile_employeeProfileId_idx" ON "StoredFile"("employeeProfileId");

-- CreateIndex
CREATE INDEX "StoredFile_skillId_idx" ON "StoredFile"("skillId");

-- CreateIndex
CREATE INDEX "StoredFile_certificateId_idx" ON "StoredFile"("certificateId");

-- CreateIndex
CREATE INDEX "StoredFile_projectId_idx" ON "StoredFile"("projectId");

-- CreateIndex
CREATE INDEX "StoredFile_category_idx" ON "StoredFile"("category");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "EmployeeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "EmployeeProfileSkill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "EmployeeProfileCertificate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EmployeeProfileProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
