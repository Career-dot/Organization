/*
  Warnings:

  - You are about to drop the column `department` on the `EmployeeProfile` table. All the data in the column will be lost.
  - You are about to drop the column `fileId` on the `EmployeeProfileCertificate` table. All the data in the column will be lost.
  - You are about to drop the column `liveUrl` on the `EmployeeProfileProject` table. All the data in the column will be lost.
  - You are about to drop the `StoredFile` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "EmployeeProfileCertificate" DROP CONSTRAINT "EmployeeProfileCertificate_fileId_fkey";

-- DropForeignKey
ALTER TABLE "StoredFile" DROP CONSTRAINT "StoredFile_userId_fkey";

-- DropIndex
DROP INDEX "EmployeeProfileCertificate_fileId_idx";

-- AlterTable
ALTER TABLE "EmployeeProfile" DROP COLUMN "department";

-- AlterTable
ALTER TABLE "EmployeeProfileCertificate" DROP COLUMN "fileId";

-- AlterTable
ALTER TABLE "EmployeeProfileProject" DROP COLUMN "liveUrl",
ADD COLUMN     "link" TEXT;

-- AlterTable
ALTER TABLE "EmployeeProfileSkill" ADD COLUMN     "category" TEXT;

-- DropTable
DROP TABLE "StoredFile";

-- CreateIndex
CREATE INDEX "EmployeeProfileCertificate_name_idx" ON "EmployeeProfileCertificate"("name");
