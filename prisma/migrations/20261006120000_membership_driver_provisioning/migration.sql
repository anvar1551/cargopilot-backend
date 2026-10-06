CREATE TABLE "CompanyDriverDelegationAuthority" (
  "membershipId" uuid PRIMARY KEY,
  "userId" uuid NOT NULL, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
  "ceilingRevision" text NOT NULL CHECK ("ceilingRevision" = 'driver-delegation.v1'),
  "profileRevisions" text[] NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("membershipId","tenantId","companyId"),
  FOREIGN KEY ("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership" ("id","userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY ("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership" ("id","tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
ALTER TABLE "CompanyDriverDelegationAuthority" ADD CHECK (cardinality("profileRevisions") BETWEEN 1 AND 2 AND "profileRevisions" <@ ARRAY['local-driver.v1','linehaul-driver.v1']::text[]);
CREATE TABLE "CompanyDriverInvitation" (
  "id" uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), "operationId" uuid NOT NULL UNIQUE,
  "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL,
  "inviterMembershipId" uuid NOT NULL REFERENCES "CompanyDriverDelegationAuthority" ("membershipId") ON DELETE RESTRICT,
  "email" text NOT NULL, "profileRevision" text NOT NULL,
  "fingerprint" text NOT NULL,
  "tokenHash" text NOT NULL UNIQUE, "expiresAt" timestamp(3) NOT NULL,
  "state" text NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','accepted','cancelled')),
  "acceptedMembershipId" uuid REFERENCES "CompanyMembership" (id) ON DELETE RESTRICT,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("tenantId","companyId") REFERENCES "Organization" ("tenantId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("inviterMembershipId","tenantId","companyId") REFERENCES "CompanyDriverDelegationAuthority" ("membershipId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("acceptedMembershipId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("profileRevision" IN ('local-driver.v1','linehaul-driver.v1')),
  CHECK (("state"='accepted') = ("acceptedMembershipId" IS NOT NULL))
);
CREATE INDEX "CompanyDriverInvitation_context_idx" ON "CompanyDriverInvitation" ("tenantId","companyId","inviterMembershipId","state");
CREATE TABLE "CompanyDriverEligibility" (
  "acceptedOperationId" uuid NOT NULL,
  "driverType" text NOT NULL CHECK ("driverType" IN ('local','linehaul')),
  "membershipId" uuid PRIMARY KEY,
  "userId" uuid NOT NULL, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
  "profileRevision" text NOT NULL CHECK ("profileRevision" IN ('local-driver.v1','linehaul-driver.v1')),
  "roleId" uuid NOT NULL, "enabled" boolean NOT NULL DEFAULT true,
  UNIQUE ("membershipId","userId","tenantId","companyId"),
  FOREIGN KEY ("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership" ("id","userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY ("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership" ("id","tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY ("roleId","companyId") REFERENCES "Role" ("id","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE "CompanyDriverAction" (
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
  CONSTRAINT "CompanyDriverAction_recipient_context_fkey" FOREIGN KEY ("targetMembershipId","recipientUserId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (("operatorId" IS NOT NULL AND "operatorId"='cargopilot-bootstrap-owner' AND "actorUserId" IS NULL AND "actorMembershipId" IS NULL)
    OR ("operatorId" IS NULL AND "actorUserId" IS NOT NULL AND "actorMembershipId" IS NOT NULL)),
  CHECK ((action='accept') = ("recipientUserId" IS NOT NULL)),
  CHECK (("operatorId" IS NULL AND "operatorKeyFingerprint" IS NULL) OR
    ("operatorId" IS NOT NULL AND "operatorKeyFingerprint" IS NOT NULL AND "operatorKeyFingerprint" ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX "CompanyDriverAction_context_idx" ON "CompanyDriverAction" ("tenantId","companyId","createdAt");
CREATE TRIGGER "CompanyDriverAction_immutable" BEFORE UPDATE OR DELETE ON "CompanyDriverAction" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "CompanyDriverAction_no_truncate" BEFORE TRUNCATE ON "CompanyDriverAction" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();

ALTER TABLE "CompanyDriverEligibility" ADD CHECK (("driverType"='local' AND "profileRevision"='local-driver.v1') OR ("driverType"='linehaul' AND "profileRevision"='linehaul-driver.v1'));
CREATE INDEX "CompanyDriverEligibility_context_idx" ON "CompanyDriverEligibility" ("tenantId","companyId",enabled,"driverType");
CREATE UNIQUE INDEX "CompanyDriverAction_acceptance_key" ON "CompanyDriverAction" ("operationId","targetMembershipId","tenantId","companyId");
-- Eligibility and its immutable acceptance fact commit together, in either write order.
ALTER TABLE "CompanyDriverEligibility" ADD CONSTRAINT "CompanyDriverEligibility_acceptance_fkey"
  FOREIGN KEY ("acceptedOperationId","membershipId","tenantId","companyId")
  REFERENCES "CompanyDriverAction" ("operationId","targetMembershipId","tenantId","companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
