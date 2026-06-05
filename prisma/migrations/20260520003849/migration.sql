/*
  Warnings:

  - You are about to drop the column `homeOrgId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `role` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `AccessPermission` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AccessRole` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DataScopePolicy` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRoleBinding` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('active', 'invited', 'suspended');

-- CreateEnum
CREATE TYPE "MembershipScopeType" AS ENUM ('company', 'branch', 'warehouse', 'agent', 'pickup_point', 'carrier', 'client');

-- DropForeignKey
ALTER TABLE "AccessRole" DROP CONSTRAINT "AccessRole_orgId_fkey";

-- DropForeignKey
ALTER TABLE "DataScopePolicy" DROP CONSTRAINT "DataScopePolicy_roleId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_permissionId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_roleId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_homeOrgId_fkey";

-- DropForeignKey
ALTER TABLE "UserRoleBinding" DROP CONSTRAINT "UserRoleBinding_orgId_fkey";

-- DropForeignKey
ALTER TABLE "UserRoleBinding" DROP CONSTRAINT "UserRoleBinding_roleId_fkey";

-- DropForeignKey
ALTER TABLE "UserRoleBinding" DROP CONSTRAINT "UserRoleBinding_userId_fkey";

-- DropIndex
DROP INDEX "User_homeOrgId_idx";

-- DropIndex
DROP INDEX "User_role_createdAt_idx";

-- DropIndex
DROP INDEX "User_role_warehouseId_createdAt_idx";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "homeOrgId",
DROP COLUMN "role";

-- DropTable
DROP TABLE "AccessPermission";

-- DropTable
DROP TABLE "AccessRole";

-- DropTable
DROP TABLE "DataScopePolicy";

-- DropTable
DROP TABLE "UserRoleBinding";

-- DropEnum
DROP TYPE "ScopeResource";

-- DropEnum
DROP TYPE "ScopeType";

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" UUID,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isOwnerRole" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMembership" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "status" "MembershipStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipRole" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipScope" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "scopeType" "MembershipScopeType" NOT NULL,
    "scopeRefId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Role_code_idx" ON "Role"("code");

-- CreateIndex
CREATE INDEX "Role_companyId_isSystem_idx" ON "Role"("companyId", "isSystem");

-- CreateIndex
CREATE UNIQUE INDEX "Role_companyId_code_key" ON "Role"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Permission_resource_action_idx" ON "Permission"("resource", "action");

-- CreateIndex
CREATE INDEX "CompanyMembership_companyId_status_idx" ON "CompanyMembership"("companyId", "status");

-- CreateIndex
CREATE INDEX "CompanyMembership_branchId_idx" ON "CompanyMembership"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMembership_userId_companyId_key" ON "CompanyMembership"("userId", "companyId");

-- CreateIndex
CREATE INDEX "MembershipRole_roleId_idx" ON "MembershipRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipRole_membershipId_roleId_key" ON "MembershipRole"("membershipId", "roleId");

-- CreateIndex
CREATE INDEX "MembershipScope_scopeType_scopeRefId_idx" ON "MembershipScope"("scopeType", "scopeRefId");

-- CreateIndex
CREATE INDEX "MembershipScope_membershipId_idx" ON "MembershipScope"("membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipScope_membershipId_scopeType_scopeRefId_key" ON "MembershipScope"("membershipId", "scopeType", "scopeRefId");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "User_warehouseId_createdAt_idx" ON "User"("warehouseId", "createdAt");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMembership" ADD CONSTRAINT "CompanyMembership_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "CompanyMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipScope" ADD CONSTRAINT "MembershipScope_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "CompanyMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
