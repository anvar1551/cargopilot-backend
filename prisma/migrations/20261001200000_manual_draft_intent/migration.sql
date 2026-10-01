
-- Dedicated server-bound receipt fields, not request metadata. No historical mapping.
ALTER TABLE "FinanceDocument" ADD COLUMN "draftIntentHash" VARCHAR(64), ADD COLUMN "draftTenantId" UUID, ADD COLUMN "draftCompanyId" UUID, ADD COLUMN "draftTenantMembershipId" UUID, ADD COLUMN "draftCompanyMembershipId" UUID;
CREATE UNIQUE INDEX "FinanceLegalEntity_draft_owner_key" ON "FinanceLegalEntity"("id","tenantId","companyId");
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_draft_complete_check" CHECK (num_nonnulls("draftIntentHash","draftTenantId","draftCompanyId","draftTenantMembershipId","draftCompanyMembershipId")=0 OR (num_nonnulls("draftIntentHash","draftTenantId","draftCompanyId","draftTenantMembershipId","draftCompanyMembershipId")=5 AND "draftIntentHash" ~ '^[a-f0-9]{64}$' AND type='manual_journal')) NOT VALID;
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_draft_entity_fkey" FOREIGN KEY ("legalEntityId","draftTenantId","draftCompanyId") REFERENCES "FinanceLegalEntity"("id","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_draft_company_fkey" FOREIGN KEY ("draftCompanyMembershipId","createdByUserId","draftTenantId","draftCompanyId") REFERENCES "CompanyMembership"("id","userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_draft_bridge_fkey" FOREIGN KEY ("draftCompanyMembershipId","draftTenantMembershipId","createdByUserId","draftTenantId") REFERENCES "CompanyMembership"("id","tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_draft_tenant_fkey" FOREIGN KEY ("draftTenantMembershipId","createdByUserId","draftTenantId") REFERENCES "TenantMembership"("id","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
CREATE FUNCTION cp_protect_draft_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."draftIntentHash" IS NULL AND NEW."draftIntentHash" IS NOT NULL) OR
     (OLD."draftIntentHash" IS NOT NULL AND ROW(OLD."draftIntentHash",OLD."draftTenantId",OLD."draftCompanyId",OLD."draftTenantMembershipId",OLD."draftCompanyMembershipId",OLD."legalEntityId",OLD."createdByUserId",OLD."idempotencyKey",OLD."documentNumber",OLD.type,OLD."documentDate",OLD."postingDate",OLD.currency,OLD."totalAmount",OLD."baseAmount",OLD."fxRate",OLD."fxRateAsOf",OLD.description,OLD."sourceType",OLD."sourceId",OLD."sourceEventId",OLD."metadataJson") IS DISTINCT FROM ROW(NEW."draftIntentHash",NEW."draftTenantId",NEW."draftCompanyId",NEW."draftTenantMembershipId",NEW."draftCompanyMembershipId",NEW."legalEntityId",NEW."createdByUserId",NEW."idempotencyKey",NEW."documentNumber",NEW.type,NEW."documentDate",NEW."postingDate",NEW.currency,NEW."totalAmount",NEW."baseAmount",NEW."fxRate",NEW."fxRateAsOf",NEW.description,NEW."sourceType",NEW."sourceId",NEW."sourceEventId",NEW."metadataJson")) THEN
    RAISE EXCEPTION 'Immutable draft intent rejected' USING ERRCODE='23514',CONSTRAINT='FinanceDocument_draft_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cp_protect_draft_intent BEFORE UPDATE ON "FinanceDocument" FOR EACH ROW EXECUTE FUNCTION cp_protect_draft_intent();
