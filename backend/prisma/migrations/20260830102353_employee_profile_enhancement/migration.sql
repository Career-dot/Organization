/*
  Warnings:

  - The `proficiency` column on the `EmployeeProfileProjectSkill` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `proficiency` column on the `EmployeeProfileSkill` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "SkillProficiency" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT');

-- AlterTable
ALTER TABLE "EmployeeProfileCertificate" ADD COLUMN     "skillId" TEXT;

-- AlterTable
ALTER TABLE "EmployeeProfileProjectSkill" DROP COLUMN "proficiency",
ADD COLUMN     "proficiency" "SkillProficiency";

-- AlterTable
ALTER TABLE "EmployeeProfileSkill" DROP COLUMN "proficiency",
ADD COLUMN     "proficiency" "SkillProficiency";

-- CreateIndex
CREATE INDEX "EmployeeProfileCertificate_skillId_idx" ON "EmployeeProfileCertificate"("skillId");

-- AddForeignKey
ALTER TABLE "EmployeeProfileCertificate" ADD CONSTRAINT "EmployeeProfileCertificate_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "EmployeeProfileSkill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
