/*
  Warnings:

  - You are about to drop the column `link` on the `EmployeeProfileProject` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `EmployeeProfileSkill` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "EmployeeProfileCertificate_name_idx";

-- AlterTable
ALTER TABLE "EmployeeProfile" ADD COLUMN     "department" TEXT;

-- AlterTable
ALTER TABLE "EmployeeProfileCertificate" ADD COLUMN     "fileId" TEXT;

-- AlterTable
ALTER TABLE "EmployeeProfileEducation" ADD COLUMN     "marksOrCgpa" TEXT;

-- AlterTable
ALTER TABLE "EmployeeProfileProject" DROP COLUMN "link",
ADD COLUMN     "liveUrl" TEXT;

-- AlterTable
ALTER TABLE "EmployeeProfileSkill" DROP COLUMN "category";

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoredFile_userId_idx" ON "StoredFile"("userId");

-- CreateIndex
CREATE INDEX "StoredFile_category_idx" ON "StoredFile"("category");

-- CreateIndex
CREATE INDEX "EmployeeProfileCertificate_fileId_idx" ON "EmployeeProfileCertificate"("fileId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeProfileCertificate" ADD CONSTRAINT "EmployeeProfileCertificate_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
