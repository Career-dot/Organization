-- CreateEnum
CREATE TYPE "CareerMappingStatus" AS ENUM ('MATCHED', 'UNMAPPED', 'NEEDS_REVIEW');

-- AlterEnum
ALTER TYPE "VerificationAttemptStatus" ADD VALUE 'VIOLATION_TERMINATED';

-- AlterTable
ALTER TABLE "EmployeeProfileSkill" ADD COLUMN     "canonicalSkillId" TEXT;

-- AlterTable
ALTER TABLE "VerificationAttempt" ADD COLUMN     "violationCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SkillCatalog" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillAlias" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasNormalized" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerRoleAlias" (
    "id" TEXT NOT NULL,
    "careerRoleId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasNormalized" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerRoleAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerRoleSkill" (
    "id" TEXT NOT NULL,
    "careerRoleId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CareerRoleSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeePreferredCareerRole" (
    "id" TEXT NOT NULL,
    "employeeProfileId" TEXT NOT NULL,
    "careerRoleId" TEXT,
    "sourceText" TEXT NOT NULL,
    "sourceTextNormalized" TEXT NOT NULL,
    "mappingStatus" "CareerMappingStatus" NOT NULL DEFAULT 'UNMAPPED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePreferredCareerRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkillCatalog_nameNormalized_key" ON "SkillCatalog"("nameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "SkillCatalog_slug_key" ON "SkillCatalog"("slug");

-- CreateIndex
CREATE INDEX "SkillCatalog_isActive_idx" ON "SkillCatalog"("isActive");

-- CreateIndex
CREATE INDEX "SkillCatalog_category_idx" ON "SkillCatalog"("category");

-- CreateIndex
CREATE UNIQUE INDEX "SkillAlias_aliasNormalized_key" ON "SkillAlias"("aliasNormalized");

-- CreateIndex
CREATE INDEX "SkillAlias_skillId_idx" ON "SkillAlias"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerRole_nameNormalized_key" ON "CareerRole"("nameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "CareerRole_slug_key" ON "CareerRole"("slug");

-- CreateIndex
CREATE INDEX "CareerRole_isActive_idx" ON "CareerRole"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "CareerRoleAlias_aliasNormalized_key" ON "CareerRoleAlias"("aliasNormalized");

-- CreateIndex
CREATE INDEX "CareerRoleAlias_careerRoleId_idx" ON "CareerRoleAlias"("careerRoleId");

-- CreateIndex
CREATE INDEX "CareerRoleSkill_skillId_idx" ON "CareerRoleSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "CareerRoleSkill_careerRoleId_skillId_key" ON "CareerRoleSkill"("careerRoleId", "skillId");

-- CreateIndex
CREATE INDEX "EmployeePreferredCareerRole_employeeProfileId_mappingStatus_idx" ON "EmployeePreferredCareerRole"("employeeProfileId", "mappingStatus");

-- CreateIndex
CREATE INDEX "EmployeePreferredCareerRole_careerRoleId_idx" ON "EmployeePreferredCareerRole"("careerRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeePreferredCareerRole_employeeProfileId_sourceTextNor_key" ON "EmployeePreferredCareerRole"("employeeProfileId", "sourceTextNormalized");

-- CreateIndex
CREATE INDEX "EmployeeProfileSkill_canonicalSkillId_idx" ON "EmployeeProfileSkill"("canonicalSkillId");

-- AddForeignKey
ALTER TABLE "EmployeeProfileSkill" ADD CONSTRAINT "EmployeeProfileSkill_canonicalSkillId_fkey" FOREIGN KEY ("canonicalSkillId") REFERENCES "SkillCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAlias" ADD CONSTRAINT "SkillAlias_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "SkillCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerRoleAlias" ADD CONSTRAINT "CareerRoleAlias_careerRoleId_fkey" FOREIGN KEY ("careerRoleId") REFERENCES "CareerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerRoleSkill" ADD CONSTRAINT "CareerRoleSkill_careerRoleId_fkey" FOREIGN KEY ("careerRoleId") REFERENCES "CareerRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareerRoleSkill" ADD CONSTRAINT "CareerRoleSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "SkillCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeePreferredCareerRole" ADD CONSTRAINT "EmployeePreferredCareerRole_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "EmployeeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeePreferredCareerRole" ADD CONSTRAINT "EmployeePreferredCareerRole_careerRoleId_fkey" FOREIGN KEY ("careerRoleId") REFERENCES "CareerRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
