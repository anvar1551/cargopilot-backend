-- ERP access foundation: organizations + RBAC + data scopes

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('company', 'branch', 'agent', 'pickup_point', 'carrier', 'client');

-- CreateEnum
CREATE TYPE "ScopeResource" AS ENUM ('orders', 'finance', 'support', 'drivers', 'warehouses', 'customers');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('own', 'branch', 'organization', 'subtree', 'assigned', 'global');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "code" TEXT,
    "parentOrgId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRole" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgId" UUID,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccessRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessPermission" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccessPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRoleBinding" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserRoleBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataScopePolicy" (
    "id" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "resource" "ScopeResource" NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "constraintsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DataScopePolicy_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "User" ADD COLUMN "homeOrgId" UUID;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "ownerOrgId" UUID;
ALTER TABLE "Order" ADD COLUMN "assignedOrgId" UUID;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "ownerOrgId" UUID;
ALTER TABLE "SupportTicket" ADD COLUMN "assignedOrgId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_code_key" ON "Organization"("code");

-- CreateIndex
CREATE INDEX "Organization_type_isActive_idx" ON "Organization"("type", "isActive");
CREATE INDEX "Organization_parentOrgId_idx" ON "Organization"("parentOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRole_orgId_code_key" ON "AccessRole"("orgId", "code");
CREATE INDEX "AccessRole_code_idx" ON "AccessRole"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AccessPermission_code_key" ON "AccessPermission"("code");
CREATE INDEX "AccessPermission_resource_action_idx" ON "AccessPermission"("resource", "action");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRoleBinding_userId_roleId_orgId_key" ON "UserRoleBinding"("userId", "roleId", "orgId");
CREATE INDEX "UserRoleBinding_roleId_idx" ON "UserRoleBinding"("roleId");
CREATE INDEX "UserRoleBinding_orgId_idx" ON "UserRoleBinding"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "DataScopePolicy_roleId_resource_key" ON "DataScopePolicy"("roleId", "resource");
CREATE INDEX "DataScopePolicy_resource_scopeType_idx" ON "DataScopePolicy"("resource", "scopeType");

-- CreateIndex
CREATE INDEX "User_homeOrgId_idx" ON "User"("homeOrgId");

-- CreateIndex
CREATE INDEX "Order_ownerOrgId_status_createdAt_idx" ON "Order"("ownerOrgId", "status", "createdAt");
CREATE INDEX "Order_assignedOrgId_status_createdAt_idx" ON "Order"("assignedOrgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_ownerOrgId_status_lastActivityAt_idx" ON "SupportTicket"("ownerOrgId", "status", "lastActivityAt");
CREATE INDEX "SupportTicket_assignedOrgId_status_lastActivityAt_idx" ON "SupportTicket"("assignedOrgId", "status", "lastActivityAt");

-- AddForeignKey
ALTER TABLE "Organization"
ADD CONSTRAINT "Organization_parentOrgId_fkey"
FOREIGN KEY ("parentOrgId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRole"
ADD CONSTRAINT "AccessRole_orgId_fkey"
FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission"
ADD CONSTRAINT "RolePermission_roleId_fkey"
FOREIGN KEY ("roleId") REFERENCES "AccessRole"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission"
ADD CONSTRAINT "RolePermission_permissionId_fkey"
FOREIGN KEY ("permissionId") REFERENCES "AccessPermission"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleBinding"
ADD CONSTRAINT "UserRoleBinding_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleBinding"
ADD CONSTRAINT "UserRoleBinding_roleId_fkey"
FOREIGN KEY ("roleId") REFERENCES "AccessRole"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleBinding"
ADD CONSTRAINT "UserRoleBinding_orgId_fkey"
FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataScopePolicy"
ADD CONSTRAINT "DataScopePolicy_roleId_fkey"
FOREIGN KEY ("roleId") REFERENCES "AccessRole"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User"
ADD CONSTRAINT "User_homeOrgId_fkey"
FOREIGN KEY ("homeOrgId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order"
ADD CONSTRAINT "Order_ownerOrgId_fkey"
FOREIGN KEY ("ownerOrgId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order"
ADD CONSTRAINT "Order_assignedOrgId_fkey"
FOREIGN KEY ("assignedOrgId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket"
ADD CONSTRAINT "SupportTicket_ownerOrgId_fkey"
FOREIGN KEY ("ownerOrgId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket"
ADD CONSTRAINT "SupportTicket_assignedOrgId_fkey"
FOREIGN KEY ("assignedOrgId") REFERENCES "Organization"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
