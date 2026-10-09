-- CreateEnum
CREATE TYPE "AssessmentDefinitionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "AssessmentQuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'SCENARIO', 'PROBLEM_SOLVING', 'SHORT_ANSWER', 'CODING', 'LIVE_CODING', 'PRACTICAL');

-- CreateEnum
CREATE TYPE "AssessmentDifficulty" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT');

-- CreateEnum
CREATE TYPE "VerificationAttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED', 'CANCELLED', 'SCORED');

-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('PENDING', 'NOT_REQUIRED', 'EVALUATED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationProcessingStatus" AS ENUM ('NOT_STARTED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'INSUFFICIENT_EVIDENCE', 'PARTIALLY_VERIFIED', 'VERIFIED', 'HIGHLY_VERIFIED');

-- CreateEnum
CREATE TYPE "VerificationEvidenceType" AS ENUM ('EMPLOYEE_SKILL', 'PROJECT', 'PROJECT_SKILL', 'CERTIFICATE', 'SKILL_EVIDENCE_FILE', 'CERTIFICATE_FILE', 'PROJECT_FILE', 'RESUME', 'GITHUB', 'LINKEDIN');

-- CreateTable
CREATE TABLE "AssessmentDefinition" (
    "id" TEXT NOT NULL,
    "employeeProfileSkillId" TEXT NOT NULL,
    "skillNameSnapshot" TEXT NOT NULL,
    "skillCategorySnapshot" TEXT,
    "claimedProficiencySnapshot" "SkillProficiency",
    "yearsOfExperienceSnapshot" INTEGER,
    "department" TEXT,
    "domain" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "durationSeconds" INTEGER NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "passingScore" INTEGER NOT NULL,
    "difficultyConfiguration" JSONB,
    "generationModel" TEXT,
    "promptVersion" TEXT,
    "status" "AssessmentDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "AssessmentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentQuestion" (
    "id" TEXT NOT NULL,
    "assessmentDefinitionId" TEXT NOT NULL,
    "questionOrder" INTEGER NOT NULL,
    "questionType" "AssessmentQuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "difficulty" "AssessmentDifficulty",
    "questionConfiguration" JSONB,
    "options" JSONB,
    "evaluationConfiguration" JSONB,
    "rubric" JSONB,
    "correctAnswer" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeProfileId" TEXT NOT NULL,
    "employeeProfileSkillId" TEXT NOT NULL,
    "assessmentDefinitionId" TEXT NOT NULL,
    "assessmentVersion" INTEGER NOT NULL,
    "skillNameSnapshot" TEXT NOT NULL,
    "claimedProficiencySnapshot" "SkillProficiency",
    "yearsOfExperienceSnapshot" INTEGER,
    "status" "VerificationAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "testScorePoints" INTEGER,
    "testScoreMaxPoints" INTEGER,
    "testScorePercentage" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answerData" JSONB,
    "answeredAt" TIMESTAMP(3),
    "evaluationStatus" "EvaluationStatus" NOT NULL DEFAULT 'PENDING',
    "isCorrect" BOOLEAN,
    "pointsAwarded" INTEGER,
    "evaluationMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationReport" (
    "id" TEXT NOT NULL,
    "verificationAttemptId" TEXT NOT NULL,
    "employeeProfileSkillId" TEXT NOT NULL,
    "processingStatus" "VerificationProcessingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verificationScore" DECIMAL(65,30),
    "confidenceScore" DECIMAL(65,30),
    "aiSummary" TEXT,
    "strengths" JSONB,
    "areasToImprove" JSONB,
    "testPerformance" JSONB,
    "aiModel" TEXT,
    "promptVersion" TEXT,
    "reportVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationEvidence" (
    "id" TEXT NOT NULL,
    "verificationReportId" TEXT NOT NULL,
    "evidenceType" "VerificationEvidenceType" NOT NULL,
    "sourceId" TEXT,
    "sourceVersion" TEXT,
    "contentHash" TEXT,
    "snapshot" JSONB NOT NULL,
    "analysisSummary" TEXT,
    "relevance" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssessmentDefinition_employeeProfileSkillId_status_idx" ON "AssessmentDefinition"("employeeProfileSkillId", "status");

-- CreateIndex
CREATE INDEX "AssessmentDefinition_domain_department_idx" ON "AssessmentDefinition"("domain", "department");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentDefinition_employeeProfileSkillId_version_key" ON "AssessmentDefinition"("employeeProfileSkillId", "version");

-- CreateIndex
CREATE INDEX "AssessmentQuestion_assessmentDefinitionId_questionType_idx" ON "AssessmentQuestion"("assessmentDefinitionId", "questionType");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentQuestion_assessmentDefinitionId_questionOrder_key" ON "AssessmentQuestion"("assessmentDefinitionId", "questionOrder");

-- CreateIndex
CREATE INDEX "VerificationAttempt_userId_status_idx" ON "VerificationAttempt"("userId", "status");

-- CreateIndex
CREATE INDEX "VerificationAttempt_employeeProfileId_employeeProfileSkillI_idx" ON "VerificationAttempt"("employeeProfileId", "employeeProfileSkillId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationAttempt_assessmentDefinitionId_assessmentVersio_idx" ON "VerificationAttempt"("assessmentDefinitionId", "assessmentVersion");

-- CreateIndex
CREATE INDEX "AssessmentAnswer_questionId_idx" ON "AssessmentAnswer"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAnswer_attemptId_questionId_key" ON "AssessmentAnswer"("attemptId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationReport_verificationAttemptId_key" ON "VerificationReport"("verificationAttemptId");

-- CreateIndex
CREATE INDEX "VerificationReport_employeeProfileSkillId_createdAt_idx" ON "VerificationReport"("employeeProfileSkillId", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationReport_processingStatus_createdAt_idx" ON "VerificationReport"("processingStatus", "createdAt");

-- CreateIndex
CREATE INDEX "VerificationEvidence_verificationReportId_evidenceType_idx" ON "VerificationEvidence"("verificationReportId", "evidenceType");

-- CreateIndex
CREATE INDEX "VerificationEvidence_evidenceType_sourceId_idx" ON "VerificationEvidence"("evidenceType", "sourceId");

-- CreateIndex
CREATE INDEX "VerificationEvidence_contentHash_idx" ON "VerificationEvidence"("contentHash");

-- AddForeignKey
ALTER TABLE "AssessmentDefinition" ADD CONSTRAINT "AssessmentDefinition_employeeProfileSkillId_fkey" FOREIGN KEY ("employeeProfileSkillId") REFERENCES "EmployeeProfileSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentQuestion" ADD CONSTRAINT "AssessmentQuestion_assessmentDefinitionId_fkey" FOREIGN KEY ("assessmentDefinitionId") REFERENCES "AssessmentDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_employeeProfileId_fkey" FOREIGN KEY ("employeeProfileId") REFERENCES "EmployeeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_employeeProfileSkillId_fkey" FOREIGN KEY ("employeeProfileSkillId") REFERENCES "EmployeeProfileSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_assessmentDefinitionId_fkey" FOREIGN KEY ("assessmentDefinitionId") REFERENCES "AssessmentDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAnswer" ADD CONSTRAINT "AssessmentAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "VerificationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAnswer" ADD CONSTRAINT "AssessmentAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "AssessmentQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationReport" ADD CONSTRAINT "VerificationReport_verificationAttemptId_fkey" FOREIGN KEY ("verificationAttemptId") REFERENCES "VerificationAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationReport" ADD CONSTRAINT "VerificationReport_employeeProfileSkillId_fkey" FOREIGN KEY ("employeeProfileSkillId") REFERENCES "EmployeeProfileSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationEvidence" ADD CONSTRAINT "VerificationEvidence_verificationReportId_fkey" FOREIGN KEY ("verificationReportId") REFERENCES "VerificationReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
