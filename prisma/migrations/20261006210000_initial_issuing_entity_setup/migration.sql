-- DOM-04 expansion only. No existing entity adoption, defaults or backfill.
CREATE TABLE "IssuingEntitySetupAction" (
 "operationId" uuid PRIMARY KEY,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,
 "membershipId" uuid NOT NULL,"userId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('proposer','checker')),action text NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),reason text NOT NULL,
 result jsonb NOT NULL,"operatorId" text,"operatorKeyFingerprint" text,
 "proposalId" uuid UNIQUE,"legalEntityId" uuid UNIQUE,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("operationId","membershipId",kind,"tenantId","companyId"),
 FOREIGN KEY("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CHECK ((action IN ('operator-authorize','operator-revoke') AND "proposalId" IS NULL AND "legalEntityId" IS NULL
   AND "operatorId" IS NOT NULL AND "operatorId"='cargopilot-bootstrap-owner' AND "operatorKeyFingerprint" IS NOT NULL)
  OR (action IN ('approved','rejected') AND kind='checker' AND "proposalId" IS NOT NULL
   AND "operatorId" IS NULL AND "operatorKeyFingerprint" IS NULL
   AND ((action='approved' AND "legalEntityId" IS NOT NULL) OR (action='rejected' AND "legalEntityId" IS NULL))))
);
CREATE INDEX "IssuingEntitySetupAction_tenantId_companyId_createdAt_idx" ON "IssuingEntitySetupAction"("tenantId","companyId","createdAt");
CREATE TABLE "IssuingEntitySetupAuthority" (
 "membershipId" uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('proposer','checker')),
 "userId" uuid NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,
 "profileRevision" text NOT NULL,"acceptedOperationId" uuid NOT NULL,enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY("membershipId",kind),
 FOREIGN KEY("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY("acceptedOperationId","membershipId",kind,"tenantId","companyId") REFERENCES "IssuingEntitySetupAction"("operationId","membershipId",kind,"tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE "IssuingEntitySetupProposal" (
 "operationId" uuid PRIMARY KEY,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,
 "membershipId" uuid NOT NULL,"userId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,
 kind text NOT NULL DEFAULT 'proposer' CHECK(kind='proposer'),"authorityAcceptanceId" uuid NOT NULL,
 content jsonb NOT NULL,"contentHash" text NOT NULL CHECK("contentHash" ~ '^[a-f0-9]{64}$'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),reason text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("operationId","tenantId","companyId"),
 FOREIGN KEY("membershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY("membershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY("authorityAcceptanceId","membershipId",kind,"tenantId","companyId") REFERENCES "IssuingEntitySetupAction"("operationId","membershipId",kind,"tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CHECK(jsonb_typeof(content)='object' AND content ?& ARRAY['baseCurrency','reportingCurrency','fiscalYearStartMonth','timezone'] AND content->'reportingCurrency'='null'::jsonb
   AND jsonb_typeof(content->'baseCurrency')='string' AND (content->>'baseCurrency') ~ '^[A-Z]{3}$'
   AND jsonb_typeof(content->'fiscalYearStartMonth')='number' AND (content->>'fiscalYearStartMonth')::numeric BETWEEN 1 AND 12
   AND (content->>'fiscalYearStartMonth')::numeric=trunc((content->>'fiscalYearStartMonth')::numeric)
   AND jsonb_typeof(content->'timezone')='string' AND length(content->>'timezone') BETWEEN 1 AND 100)
);
CREATE INDEX "IssuingEntitySetupProposal_tenantId_companyId_createdAt_idx" ON "IssuingEntitySetupProposal"("tenantId","companyId","createdAt");
ALTER TABLE "IssuingEntitySetupAction" ADD FOREIGN KEY("proposalId","tenantId","companyId") REFERENCES "IssuingEntitySetupProposal"("operationId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE FUNCTION cp_initial_entity_decision_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "IssuingEntitySetupProposal"; e "FinanceLegalEntity";
BEGIN
 IF NEW."proposalId" IS NOT NULL THEN
  SELECT * INTO STRICT p FROM "IssuingEntitySetupProposal" WHERE "operationId"=NEW."proposalId" AND "tenantId"=NEW."tenantId" AND "companyId"=NEW."companyId";
  IF p."userId"=NEW."userId" THEN RAISE EXCEPTION 'Independent entity setup checker required'; END IF;
  IF NEW.action='approved' THEN
   SELECT * INTO STRICT e FROM "FinanceLegalEntity" WHERE id=NEW."legalEntityId" AND "tenantId"=NEW."tenantId" AND "companyId"=NEW."companyId";
   IF e."baseCurrency" IS DISTINCT FROM p.content->>'baseCurrency' OR e."reportingCurrency" IS NOT NULL
     OR e."fiscalYearStartMonth" IS DISTINCT FROM (p.content->>'fiscalYearStartMonth')::integer
     OR e.timezone IS DISTINCT FROM p.content->>'timezone' OR NOT e."isActive"
     OR e."createdByUserId"<>p."userId" OR e."updatedByUserId"<>NEW."userId" THEN
     RAISE EXCEPTION 'Entity setup publication conflict';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "IssuingEntitySetupAction_decision_check" BEFORE INSERT ON "IssuingEntitySetupAction" FOR EACH ROW EXECUTE FUNCTION cp_initial_entity_decision_check();
CREATE FUNCTION cp_initial_entity_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Initial entity setup evidence is append-only'; END $$;
CREATE TRIGGER "IssuingEntitySetupProposal_immutable" BEFORE UPDATE OR DELETE ON "IssuingEntitySetupProposal" FOR EACH ROW EXECUTE FUNCTION cp_initial_entity_append_only();
CREATE TRIGGER "IssuingEntitySetupProposal_no_truncate" BEFORE TRUNCATE ON "IssuingEntitySetupProposal" FOR EACH STATEMENT EXECUTE FUNCTION cp_initial_entity_append_only();
CREATE TRIGGER "IssuingEntitySetupAction_immutable" BEFORE UPDATE OR DELETE ON "IssuingEntitySetupAction" FOR EACH ROW EXECUTE FUNCTION cp_initial_entity_append_only();
CREATE TRIGGER "IssuingEntitySetupAction_no_truncate" BEFORE TRUNCATE ON "IssuingEntitySetupAction" FOR EACH STATEMENT EXECUTE FUNCTION cp_initial_entity_append_only();

-- Accepted new configuration cannot be silently rewritten. Existing entities
-- are neither adopted nor certified by this expansion.
CREATE FUNCTION cp_initial_entity_configuration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "IssuingEntitySetupAction" WHERE "legalEntityId"=OLD.id AND action='approved') AND
   (NEW.id,NEW."tenantId",NEW."companyId",NEW."baseCurrency",NEW."reportingCurrency",NEW."fiscalYearStartMonth",NEW.timezone,NEW."isActive",NEW."createdByUserId",NEW."updatedByUserId")
    IS DISTINCT FROM
   (OLD.id,OLD."tenantId",OLD."companyId",OLD."baseCurrency",OLD."reportingCurrency",OLD."fiscalYearStartMonth",OLD.timezone,OLD."isActive",OLD."createdByUserId",OLD."updatedByUserId") THEN
   RAISE EXCEPTION 'Accepted initial entity configuration requires a separate correction contract';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "FinanceLegalEntity_initial_configuration_guard" BEFORE UPDATE ON "FinanceLegalEntity" FOR EACH ROW EXECUTE FUNCTION cp_initial_entity_configuration_guard();
