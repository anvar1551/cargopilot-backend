-- Explicit new configuration only. No historical adoption or production defaults.
CREATE TABLE "BillingPolicyVersion" (
 id UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(), "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "legalEntityId" UUID NOT NULL,
 currency VARCHAR(3) NOT NULL, revision INTEGER NOT NULL, content JSONB NOT NULL, "contentHash" CHAR(64) NOT NULL,
 "actorUserId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL, "tenantMembershipId" UUID NOT NULL,
 "operationId" UUID NOT NULL, "intentHash" CHAR(64) NOT NULL, reason TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BillingPolicyVersion_tenantId_operationId_key" UNIQUE ("tenantId","operationId"),
 CONSTRAINT "BillingPolicyVersion_legalEntityId_currency_revision_key" UNIQUE ("legalEntityId",currency,revision),
 CONSTRAINT "BillingPolicyVersion_id_actorUserId_key" UNIQUE (id,"actorUserId"),
 CONSTRAINT "BillingPolicy_content_key" UNIQUE (id,"tenantId","companyId","legalEntityId",currency,"contentHash"),
 CONSTRAINT "BillingPolicy_owner_key" UNIQUE (id,"tenantId","companyId","legalEntityId",currency),
 CONSTRAINT "BillingPolicyVersion_legalEntityId_tenantId_companyId_fkey" FOREIGN KEY ("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BillingPolicy_actor_fkey" FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BillingPolicy_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BillingPolicy_limits_check" CHECK (revision>0 AND currency ~ '^[A-Z]{3}$' AND "contentHash" ~ '^[0-9a-f]{64}$' AND "intentHash" ~ '^[0-9a-f]{64}$' AND length(btrim(reason)) BETWEEN 1 AND 1000 AND octet_length(content::text)<=65536)
);
CREATE INDEX "BillingPolicy_owner_idx" ON "BillingPolicyVersion"("tenantId","companyId",currency,revision);
CREATE TABLE "BillingPolicyDecision" (
 "versionId" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "legalEntityId" UUID NOT NULL,
 currency VARCHAR(3) NOT NULL, "contentHash" CHAR(64) NOT NULL, "makerUserId" UUID NOT NULL,
 "actorUserId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL, "tenantMembershipId" UUID NOT NULL,
 "operationId" UUID NOT NULL, "intentHash" CHAR(64) NOT NULL, decision "TariffPublicationDecisionKind" NOT NULL,
 reason TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BillingPolicyDecision_tenantId_operationId_key" UNIQUE ("tenantId","operationId"),
 CONSTRAINT "BillingPolicy_source_fkey" FOREIGN KEY ("versionId","tenantId","companyId","legalEntityId",currency,"contentHash") REFERENCES "BillingPolicyVersion"(id,"tenantId","companyId","legalEntityId",currency,"contentHash") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BillingPolicy_maker_fkey" FOREIGN KEY ("versionId","makerUserId") REFERENCES "BillingPolicyVersion"(id,"actorUserId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BillingDecision_actor_fkey" FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BillingDecision_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BillingPolicy_independence_check" CHECK ("actorUserId"<>"makerUserId" AND "intentHash" ~ '^[0-9a-f]{64}$' AND length(btrim(reason)) BETWEEN 1 AND 1000)
);
CREATE INDEX "BillingDecision_owner_idx" ON "BillingPolicyDecision"("tenantId","companyId",currency,"createdAt");
CREATE FUNCTION cp_billing_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Billing authority is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER "BillingPolicy_immutable" BEFORE UPDATE OR DELETE ON "BillingPolicyVersion" FOR EACH ROW EXECUTE FUNCTION cp_billing_history_immutable();
CREATE TRIGGER "BillingPolicy_no_truncate" BEFORE TRUNCATE ON "BillingPolicyVersion" FOR EACH STATEMENT EXECUTE FUNCTION cp_billing_history_immutable();
CREATE TRIGGER "BillingDecision_immutable" BEFORE UPDATE OR DELETE ON "BillingPolicyDecision" FOR EACH ROW EXECUTE FUNCTION cp_billing_history_immutable();
CREATE TRIGGER "BillingDecision_no_truncate" BEFORE TRUNCATE ON "BillingPolicyDecision" FOR EACH STATEMENT EXECUTE FUNCTION cp_billing_history_immutable();
