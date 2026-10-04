-- Additive, empty accepted-operator journal. No historical mapping or grants.
CREATE UNIQUE INDEX "Role_onboarding_company_key" ON "Role" ("id", "companyId");
CREATE TABLE "TenantOnboardingReceipt" (
  "operationId" uuid PRIMARY KEY,
  "operatorId" text NOT NULL CHECK ("operatorId" = 'cargopilot-bootstrap-owner'),
  "keyFingerprint" text NOT NULL CHECK ("keyFingerprint" ~ '^[a-f0-9]{64}$'),
  "profileRevision" text NOT NULL CHECK ("profileRevision" = 'initial-operational-admin.v1'),
  "intentFingerprint" text NOT NULL CHECK ("intentFingerprint" ~ '^[a-f0-9]{64}$'),
  "reason" text NOT NULL CHECK (length("reason") BETWEEN 1 AND 500),
  "tenantId" uuid NOT NULL,
  "companyId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "tenantMembershipId" uuid NOT NULL,
  "companyMembershipId" uuid NOT NULL,
  "roleId" uuid NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OnboardingReceipt_tenant_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OnboardingReceipt_company_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Organization" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OnboardingReceipt_user_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OnboardingReceipt_tm_fkey" FOREIGN KEY ("tenantMembershipId", "userId", "tenantId") REFERENCES "TenantMembership" ("id", "userId", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OnboardingReceipt_bridge_fkey" FOREIGN KEY ("companyMembershipId", "tenantMembershipId", "userId", "tenantId") REFERENCES "CompanyMembership" ("id", "tenantMembershipId", "userId", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OnboardingReceipt_owner_fkey" FOREIGN KEY ("companyMembershipId", "userId", "tenantId", "companyId") REFERENCES "CompanyMembership" ("id", "userId", "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OnboardingReceipt_role_fkey" FOREIGN KEY ("roleId", "companyId") REFERENCES "Role" ("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "TenantOnboardingReceipt_tenantId_key" ON "TenantOnboardingReceipt" ("tenantId");
CREATE UNIQUE INDEX "TenantOnboardingReceipt_companyId_key" ON "TenantOnboardingReceipt" ("companyId");
CREATE UNIQUE INDEX "TenantOnboardingReceipt_userId_key" ON "TenantOnboardingReceipt" ("userId");
CREATE UNIQUE INDEX "TenantOnboardingReceipt_tenantMembershipId_key" ON "TenantOnboardingReceipt" ("tenantMembershipId");
CREATE UNIQUE INDEX "TenantOnboardingReceipt_companyMembershipId_key" ON "TenantOnboardingReceipt" ("companyMembershipId");
CREATE UNIQUE INDEX "TenantOnboardingReceipt_roleId_key" ON "TenantOnboardingReceipt" ("roleId");
CREATE FUNCTION cp_onboarding_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Accepted onboarding audit is immutable'; END;
$$;
CREATE TRIGGER "TenantOnboardingReceipt_immutable" BEFORE UPDATE OR DELETE ON "TenantOnboardingReceipt"
  FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
