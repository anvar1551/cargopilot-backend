
CREATE TABLE "WarehouseProvisioningAuthority" (
 "membershipId" uuid PRIMARY KEY, "userId" uuid NOT NULL, "tenantId" uuid NOT NULL,
 "companyId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
 "profileRevision" text NOT NULL CHECK ("profileRevision"='warehouse-provisioning.v1'),
 "acceptedOperationId" uuid NOT NULL, enabled boolean NOT NULL DEFAULT true,
 FOREIGN KEY ("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY ("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership" (id,"tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE "WarehouseProvisioningAction" (
 "operationId" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL,
 "membershipId" uuid NOT NULL, "userId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('operator-authorize','operator-revoke','create')),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 "operatorId" text, "operatorKeyFingerprint" text, "warehouseId" uuid,
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500), result jsonb NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY ("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership" (id,"tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY ("tenantId","warehouseId") REFERENCES "Warehouse" ("tenantId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CHECK ((action='create' AND "operatorId" IS NULL AND "operatorKeyFingerprint" IS NULL AND "warehouseId" IS NOT NULL) OR
   (action IN ('operator-authorize','operator-revoke') AND "operatorId"='cargopilot-bootstrap-owner' AND "operatorId" IS NOT NULL AND "operatorKeyFingerprint" IS NOT NULL AND "operatorKeyFingerprint" ~ '^[a-f0-9]{64}$' AND "warehouseId" IS NULL)),
 UNIQUE ("operationId","membershipId","tenantId","companyId")
);
ALTER TABLE "WarehouseProvisioningAuthority" ADD CONSTRAINT "WarehouseProvisioningAuthority_acceptance_fkey"
 FOREIGN KEY ("acceptedOperationId","membershipId","tenantId","companyId") REFERENCES "WarehouseProvisioningAction" ("operationId","membershipId","tenantId","companyId")
 ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "WarehouseProvisioningAction_context_idx" ON "WarehouseProvisioningAction" ("tenantId","companyId","createdAt");
CREATE TRIGGER "WarehouseProvisioningAction_immutable" BEFORE UPDATE OR DELETE ON "WarehouseProvisioningAction" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "WarehouseProvisioningAction_no_truncate" BEFORE TRUNCATE ON "WarehouseProvisioningAction" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();

CREATE UNIQUE INDEX "WarehouseProvisioningAuthority_member_key" ON "WarehouseProvisioningAuthority" ("membershipId","userId","tenantId","companyId");

-- Reserved capability metadata only. No automatic/system/onboarding role grant.
INSERT INTO "Permission" (key,resource,action,description,"updatedAt")
 VALUES ('warehouse.create','warehouses','create','Owner-authorized controlled tenant warehouse provisioning',CURRENT_TIMESTAMP)
 ON CONFLICT (key) DO NOTHING;
