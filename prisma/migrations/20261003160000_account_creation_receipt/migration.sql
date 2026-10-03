-- New receipts only. Existing accounts are never adopted into request identities.
CREATE TABLE "FinanceAccountCreationReceipt" (
 "operationId" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "companyId" uuid NOT NULL,
 "legalEntityId" uuid NOT NULL, "actorUserId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
 "companyMembershipId" uuid NOT NULL, "requestHash" varchar(64) NOT NULL,
 "accountId" uuid NOT NULL, "resultJson" jsonb NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AccountReceipt_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
 CONSTRAINT "AccountReceipt_result_check" CHECK (jsonb_typeof("resultJson")='object'
 AND "resultJson"->>'id' IS NOT NULL AND "resultJson"->>'id'="accountId"::text
 AND "resultJson"->>'legalEntityId' IS NOT NULL AND "resultJson"->>'legalEntityId'="legalEntityId"::text),
 CONSTRAINT "AccountReceipt_owner_fkey" FOREIGN KEY ("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity" (id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "AccountReceipt_company_membership_fkey" FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership" (id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "AccountReceipt_tenant_membership_fkey" FOREIGN KEY ("tenantMembershipId","actorUserId","tenantId") REFERENCES "TenantMembership" (id,"userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "AccountReceipt_account_fkey" FOREIGN KEY ("legalEntityId","accountId") REFERENCES "FinanceAccount" ("legalEntityId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "FinanceAccountCreationReceipt_legalEntityId_accountId_key" ON "FinanceAccountCreationReceipt" ("legalEntityId","accountId");
CREATE INDEX "FinanceAccountCreationReceipt_tenantId_companyId_createdAt_idx" ON "FinanceAccountCreationReceipt" ("tenantId","companyId","createdAt");
CREATE FUNCTION cp_account_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Account creation receipts are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER "AccountReceipt_immutable" BEFORE UPDATE OR DELETE ON "FinanceAccountCreationReceipt" FOR EACH ROW EXECUTE FUNCTION cp_account_receipt_immutable();
CREATE TRIGGER "AccountReceipt_no_truncate" BEFORE TRUNCATE ON "FinanceAccountCreationReceipt" FOR EACH STATEMENT EXECUTE FUNCTION cp_account_receipt_immutable();
