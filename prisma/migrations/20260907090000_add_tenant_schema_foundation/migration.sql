-- Additive tenant schema foundation only. Existing rows remain unassigned.
-- This migration performs no tenant inference, backfill, default assignment or cutover.

CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended');

CREATE TABLE "Tenant" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "TenantStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantMembership" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'active',
  "authorizationVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantMembership_authorizationVersion_check" CHECK ("authorizationVersion" >= 1)
);

ALTER TABLE "CompanyMembership"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "tenantMembershipId" UUID,
  ADD CONSTRAINT "CompanyMembership_tenant_bridge_presence_check" CHECK (
    ("tenantId" IS NULL AND "tenantMembershipId" IS NULL)
    OR ("tenantId" IS NOT NULL AND "tenantMembershipId" IS NOT NULL)
  );

ALTER TABLE "UserRefreshSession"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "tenantMembershipId" UUID,
  ADD COLUMN "companyMembershipId" UUID,
  ADD CONSTRAINT "UserRefreshSession_membership_bridge_presence_check" CHECK (
    ("tenantId" IS NULL AND "tenantMembershipId" IS NULL AND "companyMembershipId" IS NULL)
    OR ("tenantId" IS NOT NULL AND "tenantMembershipId" IS NOT NULL AND "companyMembershipId" IS NOT NULL)
  );

ALTER TABLE "Organization" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Warehouse" ADD COLUMN "tenantId" UUID;
ALTER TABLE "CustomerEntity" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Address" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Order" ADD COLUMN "tenantId" UUID;
ALTER TABLE "FinanceLegalEntity" ADD COLUMN "tenantId" UUID;
ALTER TABLE "Invoice" ADD COLUMN "tenantId" UUID;

CREATE UNIQUE INDEX "Tenant_code_key" ON "Tenant"("code");
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");

CREATE UNIQUE INDEX "TenantMembership_tenantId_userId_key" ON "TenantMembership"("tenantId", "userId");
CREATE UNIQUE INDEX "TenantMembership_identity_key" ON "TenantMembership"("id", "userId", "tenantId");
CREATE INDEX "TenantMembership_tenantId_status_idx" ON "TenantMembership"("tenantId", "status");
CREATE INDEX "TenantMembership_userId_status_idx" ON "TenantMembership"("userId", "status");

CREATE UNIQUE INDEX "CompanyMembership_session_bridge_key"
  ON "CompanyMembership"("id", "tenantMembershipId", "userId", "tenantId");
CREATE INDEX "CompanyMembership_tenantId_status_idx" ON "CompanyMembership"("tenantId", "status");
CREATE INDEX "CompanyMembership_tenantMembershipId_idx" ON "CompanyMembership"("tenantMembershipId");

CREATE INDEX "UserRefreshSession_tenantId_userId_revokedAt_idx"
  ON "UserRefreshSession"("tenantId", "userId", "revokedAt");
CREATE INDEX "UserRefreshSession_companyMembershipId_idx" ON "UserRefreshSession"("companyMembershipId");

CREATE UNIQUE INDEX "Organization_tenant_identity_key" ON "Organization"("tenantId", "id");
CREATE INDEX "Organization_tenantId_type_isActive_idx" ON "Organization"("tenantId", "type", "isActive");
CREATE UNIQUE INDEX "Warehouse_tenant_identity_key" ON "Warehouse"("tenantId", "id");
CREATE INDEX "Warehouse_tenantId_createdAt_idx" ON "Warehouse"("tenantId", "createdAt");
CREATE UNIQUE INDEX "CustomerEntity_tenant_identity_key" ON "CustomerEntity"("tenantId", "id");
CREATE INDEX "CustomerEntity_tenantId_type_idx" ON "CustomerEntity"("tenantId", "type");
CREATE UNIQUE INDEX "Address_tenant_identity_key" ON "Address"("tenantId", "id");
CREATE INDEX "Address_tenantId_customerEntityId_idx" ON "Address"("tenantId", "customerEntityId");
CREATE UNIQUE INDEX "Order_tenant_identity_key" ON "Order"("tenantId", "id");
CREATE INDEX "Order_tenantId_createdAt_idx" ON "Order"("tenantId", "createdAt");
CREATE UNIQUE INDEX "FinanceLegalEntity_tenant_identity_key" ON "FinanceLegalEntity"("tenantId", "id");
CREATE UNIQUE INDEX "FinanceLegalEntity_tenant_company_key" ON "FinanceLegalEntity"("tenantId", "companyId");
CREATE INDEX "FinanceLegalEntity_tenantId_isActive_idx" ON "FinanceLegalEntity"("tenantId", "isActive");
CREATE UNIQUE INDEX "Invoice_tenant_identity_key" ON "Invoice"("tenantId", "id");
CREATE UNIQUE INDEX "Invoice_tenant_order_company_key" ON "Invoice"("tenantId", "orderId", "companyId");
CREATE INDEX "Invoice_tenantId_status_createdAt_idx" ON "Invoice"("tenantId", "status", "createdAt");

ALTER TABLE "TenantMembership"
  ADD CONSTRAINT "TenantMembership_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TenantMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompanyMembership"
  ADD CONSTRAINT "CompanyMembership_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CompanyMembership_tenant_bridge_fkey"
  FOREIGN KEY ("tenantMembershipId", "userId", "tenantId")
  REFERENCES "TenantMembership"("id", "userId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UserRefreshSession"
  ADD CONSTRAINT "UserRefreshSession_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "UserRefreshSession_membership_bridge_fkey"
  FOREIGN KEY ("companyMembershipId", "tenantMembershipId", "userId", "tenantId")
  REFERENCES "CompanyMembership"("id", "tenantMembershipId", "userId", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerEntity" ADD CONSTRAINT "CustomerEntity_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Address" ADD CONSTRAINT "Address_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceLegalEntity" ADD CONSTRAINT "FinanceLegalEntity_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
