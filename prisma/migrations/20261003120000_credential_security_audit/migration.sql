CREATE TYPE "CredentialSecurityAction" AS ENUM ('PASSWORD_CHANGED');
CREATE TABLE "CredentialSecurityEvent" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "actorUserId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "tenantMembershipId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "companyMembershipId" UUID NOT NULL,
  "action" "CredentialSecurityAction" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CredentialSecurityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CredentialSecurityEvent_company_fkey" FOREIGN KEY
    ("companyMembershipId", "actorUserId", "tenantId", "companyId")
    REFERENCES "CompanyMembership" ("id", "userId", "tenantId", "companyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CredentialSecurityEvent_bridge_fkey" FOREIGN KEY
    ("companyMembershipId", "tenantMembershipId", "actorUserId", "tenantId")
    REFERENCES "CompanyMembership" ("id", "tenantMembershipId", "userId", "tenantId")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "CredentialSecurityEvent_owner_time_idx" ON "CredentialSecurityEvent"
  ("tenantId", "companyId", "actorUserId", "createdAt");
CREATE FUNCTION cp_credential_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Credential security events are append-only'; END $$;
CREATE TRIGGER "CredentialSecurityEvent_append_only" BEFORE UPDATE OR DELETE ON "CredentialSecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION cp_credential_audit_append_only();
CREATE TRIGGER "CredentialSecurityEvent_no_truncate" BEFORE TRUNCATE ON "CredentialSecurityEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION cp_credential_audit_append_only();
