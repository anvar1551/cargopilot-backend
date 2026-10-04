-- Approved bounded operational authority; no legacy grants or identity adoption.
ALTER TABLE "CompanyMembership" ADD COLUMN "authorizationVersion" integer NOT NULL DEFAULT 1 CHECK ("authorizationVersion" > 0);
CREATE UNIQUE INDEX "CompanyMembership_delegation_context_key" ON "CompanyMembership" (id,"tenantId","companyId");
CREATE TABLE "CompanyDelegationAuthority" (
  "membershipId" uuid PRIMARY KEY,
  "userId" uuid NOT NULL, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
  "ceilingRevision" text NOT NULL CHECK ("ceilingRevision" = 'operational-delegation.v1'),
  "warehouseIds" uuid[] NOT NULL DEFAULT '{}',
  "enabled" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (cardinality("warehouseIds") <= 20),
  UNIQUE ("membershipId","tenantId","companyId"),
  FOREIGN KEY ("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership" ("id","userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY ("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership" ("id","tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE "CompanyInvitation" (
  "id" uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), "operationId" uuid NOT NULL UNIQUE,
  "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL,
  "inviterMembershipId" uuid NOT NULL REFERENCES "CompanyDelegationAuthority" ("membershipId") ON DELETE RESTRICT,
  "email" text NOT NULL, "profileRevision" text NOT NULL,
  "warehouseIds" uuid[] NOT NULL, "fingerprint" text NOT NULL,
  "tokenHash" text NOT NULL UNIQUE, "expiresAt" timestamp(3) NOT NULL,
  "state" text NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','accepted','cancelled')),
  "acceptedMembershipId" uuid REFERENCES "CompanyMembership" (id) ON DELETE RESTRICT,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("tenantId","companyId") REFERENCES "Organization" ("tenantId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("inviterMembershipId","tenantId","companyId") REFERENCES "CompanyDelegationAuthority" ("membershipId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("acceptedMembershipId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("profileRevision" IN ('operational-clerk.v1','operational-dispatcher.v1','operational-warehouse.v1')),
  CHECK (cardinality("warehouseIds") <= 20),
  CHECK (("state"='accepted') = ("acceptedMembershipId" IS NOT NULL))
);
CREATE INDEX "CompanyInvitation_context_idx" ON "CompanyInvitation" ("tenantId","companyId","inviterMembershipId","state");
CREATE TABLE "CompanyOperationalGrant" (
  "membershipId" uuid PRIMARY KEY,
  "userId" uuid NOT NULL, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
  "profileRevision" text NOT NULL CHECK ("profileRevision" IN ('operational-clerk.v1','operational-dispatcher.v1','operational-warehouse.v1')),
  "warehouseIds" uuid[] NOT NULL, "roleId" uuid NOT NULL, "enabled" boolean NOT NULL DEFAULT true,
  FOREIGN KEY ("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership" ("id","userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY ("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership" ("id","tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY ("roleId","companyId") REFERENCES "Role" ("id","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (cardinality("warehouseIds") <= 20)
);
CREATE TABLE "CompanyDelegationAction" (
  "operationId" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('operator-authorize','operator-revoke','invite','cancel','accept','grant','revoke')),
  "fingerprint" text NOT NULL CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
  "actorUserId" uuid, "actorMembershipId" uuid, "operatorId" text,
  "operatorKeyFingerprint" text,
  "targetMembershipId" uuid REFERENCES "CompanyMembership" (id) ON DELETE RESTRICT,
  "recipientUserId" uuid REFERENCES "User" (id) ON DELETE RESTRICT,
  "reason" text NOT NULL CHECK (length("reason") BETWEEN 1 AND 500),
  "result" jsonb NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("tenantId","companyId") REFERENCES "Organization" ("tenantId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("actorMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("targetMembershipId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CompanyDelegationAction_recipient_context_fkey" FOREIGN KEY ("targetMembershipId","recipientUserId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (("operatorId" IS NOT NULL AND "operatorId"='cargopilot-bootstrap-owner' AND "actorUserId" IS NULL AND "actorMembershipId" IS NULL)
    OR ("operatorId" IS NULL AND "actorUserId" IS NOT NULL AND "actorMembershipId" IS NOT NULL)),
  CHECK ((action='accept') = ("recipientUserId" IS NOT NULL)),
  CHECK (("operatorId" IS NULL AND "operatorKeyFingerprint" IS NULL) OR
    ("operatorId" IS NOT NULL AND "operatorKeyFingerprint" IS NOT NULL AND "operatorKeyFingerprint" ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX "CompanyDelegationAction_context_idx" ON "CompanyDelegationAction" ("tenantId","companyId","createdAt");
CREATE TRIGGER "CompanyDelegationAction_immutable" BEFORE UPDATE OR DELETE ON "CompanyDelegationAction" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "CompanyDelegationAction_no_truncate" BEFORE TRUNCATE ON "CompanyDelegationAction" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
ALTER TABLE "TenantOnboardingReceipt" DROP CONSTRAINT "TenantOnboardingReceipt_profileRevision_check";
ALTER TABLE "TenantOnboardingReceipt" ADD CONSTRAINT "TenantOnboardingReceipt_profileRevision_check" CHECK ("profileRevision" IN ('initial-operational-admin.v1','initial-operational-admin.v2'));
