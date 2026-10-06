CREATE TABLE "FinancialGrantProposal" (
 "operationId" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL, "legalEntityId" uuid NOT NULL,
 "proposerMembershipId" uuid NOT NULL,"proposerUserId" uuid NOT NULL,"targetMembershipId" uuid NOT NULL,"recipientUserId" uuid NOT NULL,
 "profileRevisions" text[] NOT NULL CHECK(cardinality("profileRevisions") BETWEEN 1 AND 6 AND "profileRevisions" <@ ARRAY['pricing-maker.v1','pricing-checker.v1','billing-operator.v1','price-exception-checker.v1','manual-invoice-issuer.v1','entity-configuration-reader.v1']),
 "expectedAcceptanceId" uuid, "expectedEnabled" boolean NOT NULL, "proposerAcceptanceId" uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK("proposerUserId"<>"recipientUserId"),
 FOREIGN KEY("proposerMembershipId","proposerUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("targetMembershipId","recipientUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 UNIQUE("operationId","targetMembershipId","tenantId","companyId","legalEntityId")
);
CREATE TABLE "FinancialGrantAction" (
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
 FOREIGN KEY("proposalId","targetMembershipId","tenantId","companyId","legalEntityId") REFERENCES "FinancialGrantProposal"("operationId","targetMembershipId","tenantId","companyId","legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 UNIQUE("operationId","targetMembershipId","tenantId","companyId","legalEntityId",action), UNIQUE("proposalId")
);
CREATE TABLE "FinancialDelegationAuthority" (
 "membershipId" uuid NOT NULL,"userId" uuid NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('proposer','checker')),
 "profileRevisions" text[] NOT NULL CHECK(cardinality("profileRevisions") BETWEEN 1 AND 6 AND "profileRevisions" <@ ARRAY['pricing-maker.v1','pricing-checker.v1','billing-operator.v1','price-exception-checker.v1','manual-invoice-issuer.v1','entity-configuration-reader.v1']),
 "acceptedOperationId" uuid NOT NULL,"acceptedAction" text NOT NULL DEFAULT 'operator-authorize' CHECK("acceptedAction"='operator-authorize'),enabled boolean NOT NULL DEFAULT true,PRIMARY KEY("membershipId",kind),
 FOREIGN KEY("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "FinancialDelegationAuthority_acceptance_fkey" FOREIGN KEY("acceptedOperationId","membershipId","tenantId","companyId","legalEntityId","acceptedAction") REFERENCES "FinancialGrantAction"("operationId","targetMembershipId","tenantId","companyId","legalEntityId",action) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE "FinancialMembershipGrant" (
 "membershipId" uuid NOT NULL,"userId" uuid NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,
 "roleIds" uuid[] NOT NULL,
 "profileRevisions" text[] NOT NULL CHECK(cardinality("profileRevisions") BETWEEN 1 AND 6 AND "profileRevisions" <@ ARRAY['pricing-maker.v1','pricing-checker.v1','billing-operator.v1','price-exception-checker.v1','manual-invoice-issuer.v1','entity-configuration-reader.v1']),
 "acceptedOperationId" uuid NOT NULL,"acceptedAction" text NOT NULL DEFAULT 'accept' CHECK("acceptedAction"='accept'),enabled boolean NOT NULL DEFAULT true,PRIMARY KEY("membershipId"),
 FOREIGN KEY("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "FinancialMembershipGrant_acceptance_fkey" FOREIGN KEY("acceptedOperationId","membershipId","tenantId","companyId","legalEntityId","acceptedAction") REFERENCES "FinancialGrantAction"("operationId","targetMembershipId","tenantId","companyId","legalEntityId",action) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION cp_financial_independent_checker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "FinancialGrantProposal"%ROWTYPE;
BEGIN
 IF NEW.action='accept' THEN
  SELECT * INTO p FROM "FinancialGrantProposal" WHERE "operationId"=NEW."proposalId";
  IF NOT FOUND OR NEW."actorUserId" IN (p."proposerUserId",p."recipientUserId") THEN RAISE EXCEPTION 'Independent financial checker required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "FinancialGrantAction_independent" BEFORE INSERT ON "FinancialGrantAction" FOR EACH ROW EXECUTE FUNCTION cp_financial_independent_checker();
CREATE INDEX "FinancialGrantProposal_context_idx" ON "FinancialGrantProposal"("tenantId","companyId","createdAt");
CREATE TRIGGER "FinancialGrantProposal_immutable" BEFORE UPDATE OR DELETE ON "FinancialGrantProposal" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "FinancialGrantProposal_no_truncate" BEFORE TRUNCATE ON "FinancialGrantProposal" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE INDEX "FinancialGrantAction_context_idx" ON "FinancialGrantAction"("tenantId","companyId","createdAt");
CREATE TRIGGER "FinancialGrantAction_immutable" BEFORE UPDATE OR DELETE ON "FinancialGrantAction" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "FinancialGrantAction_no_truncate" BEFORE TRUNCATE ON "FinancialGrantAction" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
INSERT INTO "Permission"(key,resource,action,description,"updatedAt") VALUES
 ('membership.proposeFinancial','memberships','propose','Accepted company financial grant proposer',CURRENT_TIMESTAMP),
 ('membership.approveFinancial','memberships','approve','Independent accepted company financial grant checker',CURRENT_TIMESTAMP)
 ON CONFLICT(key) DO NOTHING;
