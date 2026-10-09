-- AlterTable
ALTER TABLE "OrganizationMembership" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
