CREATE TABLE "CashCapabilityGrantProposal" (
 "operationId" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL, "legalEntityId" uuid NOT NULL,
 "proposerMembershipId" uuid NOT NULL,"proposerUserId" uuid NOT NULL,"targetMembershipId" uuid NOT NULL,"recipientUserId" uuid NOT NULL,
 "profileRevisions" text[] NOT NULL CHECK(cardinality("profileRevisions") BETWEEN 1 AND 3 AND "profileRevisions" <@ ARRAY['local-driver-cash.v1','warehouse-cash.v1','cash-settlement-checker.v1']),
 "warehouseIds" uuid[] NOT NULL CHECK(cardinality("warehouseIds") BETWEEN 1 AND 20),kinds text[] NOT NULL CHECK(cardinality(kinds) BETWEEN 1 AND 2 AND kinds <@ ARRAY['cod','service_charge']),
 "expectedAcceptanceId" uuid, "expectedEnabled" boolean NOT NULL, "proposerAcceptanceId" uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK("proposerUserId"<>"recipientUserId"),
 FOREIGN KEY("proposerMembershipId","proposerUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("targetMembershipId","recipientUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 UNIQUE("operationId","targetMembershipId","tenantId","companyId","legalEntityId")
);
CREATE TABLE "CashCapabilityGrantAction" (
 "operationId" uuid PRIMARY KEY,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('operator-authorize','operator-revoke','propose','accept','revoke')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),"targetMembershipId" uuid NOT NULL,"actorMembershipId" uuid,"actorUserId" uuid,"operatorKeyFingerprint" text, "operatorId" text,
 "proposalId" uuid,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),result jsonb NOT NULL,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((action IN ('operator-authorize','operator-revoke') AND "operatorId" IS NOT NULL AND "operatorId"='cargopilot-bootstrap-owner' AND "operatorKeyFingerprint" IS NOT NULL AND "operatorKeyFingerprint" ~ '^[a-f0-9]{64}$' AND "actorMembershipId" IS NULL AND "actorUserId" IS NULL) OR
 (action IN ('propose','accept','revoke') AND "operatorId" IS NULL AND "operatorKeyFingerprint" IS NULL AND "actorMembershipId" IS NOT NULL AND "actorUserId" IS NOT NULL)),
 CHECK((action='accept')=("proposalId" IS NOT NULL)),
 FOREIGN KEY("targetMembershipId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("actorMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("proposalId","targetMembershipId","tenantId","companyId","legalEntityId") REFERENCES "CashCapabilityGrantProposal"("operationId","targetMembershipId","tenantId","companyId","legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 UNIQUE("operationId","targetMembershipId","tenantId","companyId","legalEntityId",action), UNIQUE("proposalId")
);
CREATE TABLE "CashCapabilityDelegationAuthority" (
 "membershipId" uuid NOT NULL,"userId" uuid NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('proposer','checker')),
 "profileRevisions" text[] NOT NULL CHECK(cardinality("profileRevisions") BETWEEN 1 AND 3 AND "profileRevisions" <@ ARRAY['local-driver-cash.v1','warehouse-cash.v1','cash-settlement-checker.v1']),
 "warehouseIds" uuid[] NOT NULL CHECK(cardinality("warehouseIds") BETWEEN 1 AND 20),kinds text[] NOT NULL CHECK(cardinality(kinds) BETWEEN 1 AND 2 AND kinds <@ ARRAY['cod','service_charge']),
 "acceptedOperationId" uuid NOT NULL,"acceptedAction" text NOT NULL DEFAULT 'operator-authorize' CHECK("acceptedAction"='operator-authorize'),enabled boolean NOT NULL DEFAULT true,PRIMARY KEY("membershipId",kind),
 FOREIGN KEY("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CashCapabilityDelegationAuthority_acceptance_fkey" FOREIGN KEY("acceptedOperationId","membershipId","tenantId","companyId","legalEntityId","acceptedAction") REFERENCES "CashCapabilityGrantAction"("operationId","targetMembershipId","tenantId","companyId","legalEntityId",action) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE "CashCapabilityMembershipGrant" (
 "membershipId" uuid NOT NULL,"userId" uuid NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,

 "profileRevisions" text[] NOT NULL CHECK(cardinality("profileRevisions") BETWEEN 1 AND 3 AND "profileRevisions" <@ ARRAY['local-driver-cash.v1','warehouse-cash.v1','cash-settlement-checker.v1']),
 "warehouseIds" uuid[] NOT NULL CHECK(cardinality("warehouseIds") BETWEEN 1 AND 20),kinds text[] NOT NULL CHECK(cardinality(kinds) BETWEEN 1 AND 2 AND kinds <@ ARRAY['cod','service_charge']),
 "acceptedOperationId" uuid NOT NULL,"acceptedAction" text NOT NULL DEFAULT 'accept' CHECK("acceptedAction"='accept'),enabled boolean NOT NULL DEFAULT true,PRIMARY KEY("membershipId"),
 FOREIGN KEY("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CashCapabilityMembershipGrant_acceptance_fkey" FOREIGN KEY("acceptedOperationId","membershipId","tenantId","companyId","legalEntityId","acceptedAction") REFERENCES "CashCapabilityGrantAction"("operationId","targetMembershipId","tenantId","companyId","legalEntityId",action) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION cp_cash_capability_independent_checker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "CashCapabilityGrantProposal"%ROWTYPE;
BEGIN
 IF NEW.action='accept' THEN
  SELECT * INTO p FROM "CashCapabilityGrantProposal" WHERE "operationId"=NEW."proposalId";
  IF NOT FOUND OR NEW."actorUserId" IN (p."proposerUserId",p."recipientUserId") THEN RAISE EXCEPTION 'Independent cash capability checker required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "CashCapabilityGrantAction_independent" BEFORE INSERT ON "CashCapabilityGrantAction" FOR EACH ROW EXECUTE FUNCTION cp_cash_capability_independent_checker();
CREATE INDEX "CashCapabilityGrantProposal_context_idx" ON "CashCapabilityGrantProposal"("tenantId","companyId","createdAt");
CREATE TRIGGER "CashCapabilityGrantProposal_immutable" BEFORE UPDATE OR DELETE ON "CashCapabilityGrantProposal" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "CashCapabilityGrantProposal_no_truncate" BEFORE TRUNCATE ON "CashCapabilityGrantProposal" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE INDEX "CashCapabilityGrantAction_context_idx" ON "CashCapabilityGrantAction"("tenantId","companyId","createdAt");
CREATE TRIGGER "CashCapabilityGrantAction_immutable" BEFORE UPDATE OR DELETE ON "CashCapabilityGrantAction" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "CashCapabilityGrantAction_no_truncate" BEFORE TRUNCATE ON "CashCapabilityGrantAction" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
INSERT INTO "Permission"(key,resource,action,description,"updatedAt") VALUES
 ('membership.proposeCashCapability','memberships','propose','Accepted company cash capability grant proposer',CURRENT_TIMESTAMP),
 ('membership.approveCashCapability','memberships','approve','Independent accepted company cash capability grant checker',CURRENT_TIMESTAMP)
 ON CONFLICT(key) DO NOTHING;

ALTER TABLE "CashCapabilityMembershipGrant" ADD CHECK(cardinality("profileRevisions")=1);
CREATE FUNCTION cp_cash_capability_owned_warehouses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(NEW."warehouseIds") AS wanted(id) LEFT JOIN "Warehouse" w ON w.id=wanted.id AND w."tenantId"=NEW."tenantId" WHERE w.id IS NULL) THEN
 RAISE EXCEPTION 'Owned cash warehouse required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "CashCapabilityDelegationAuthority_warehouses" BEFORE INSERT OR UPDATE ON "CashCapabilityDelegationAuthority" FOR EACH ROW EXECUTE FUNCTION cp_cash_capability_owned_warehouses();
CREATE TRIGGER "CashCapabilityGrantProposal_warehouses" BEFORE INSERT OR UPDATE ON "CashCapabilityGrantProposal" FOR EACH ROW EXECUTE FUNCTION cp_cash_capability_owned_warehouses();
CREATE TRIGGER "CashCapabilityMembershipGrant_warehouses" BEFORE INSERT OR UPDATE ON "CashCapabilityMembershipGrant" FOR EACH ROW EXECUTE FUNCTION cp_cash_capability_owned_warehouses();

ALTER TABLE "CashCapabilityGrantAction" ADD UNIQUE("operationId","tenantId","companyId");
CREATE TABLE "CashCapabilityActionWarehouse" (
 "operationId" uuid NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"warehouseId" uuid NOT NULL,
 PRIMARY KEY("operationId","warehouseId"),
 FOREIGN KEY("operationId","tenantId","companyId") REFERENCES "CashCapabilityGrantAction"("operationId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY("tenantId","warehouseId") REFERENCES "Warehouse"("tenantId",id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER "CashCapabilityActionWarehouse_immutable" BEFORE UPDATE OR DELETE ON "CashCapabilityActionWarehouse" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "CashCapabilityActionWarehouse_no_truncate" BEFORE TRUNCATE ON "CashCapabilityActionWarehouse" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
