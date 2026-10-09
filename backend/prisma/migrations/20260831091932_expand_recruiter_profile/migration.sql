/*
  Warnings:

  - A unique constraint covering the columns `[storagePath]` on the table `StoredFile` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "RecruiterProfile" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "businessPhone" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "specialties" TEXT,
ADD COLUMN     "yearsExperience" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_storagePath_key" ON "StoredFile"("storagePath");
