-- Empty append-only journal: no historical acceptance or ownership is inferred.
ALTER TABLE "IntegrationProvider" ADD COLUMN "configurationRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "currentConfigurationId" UUID;
CREATE TABLE "IntegrationProviderConfigurationVersion" (
  "id" UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "providerId" UUID NOT NULL,
  "domain" "IntegrationDomain" NOT NULL, "providerCode" TEXT NOT NULL,
  "environment" "IntegrationEnvironment" NOT NULL,
  "actorUserId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL, "tenantMembershipId" UUID NOT NULL,
  "operationId" UUID NOT NULL, "intentSha256" TEXT NOT NULL,
  "expectedRevision" INTEGER NOT NULL, "revision" INTEGER NOT NULL,
  "status" "IntegrationProviderStatus" NOT NULL, "capabilities" TEXT[] NOT NULL, "retryPolicyId" TEXT, "timeoutMs" INTEGER NOT NULL,
  "rateLimitRps" INTEGER, "secretId" UUID, "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("domain" <> 'payment' AND "expectedRevision" >= 0 AND "revision" = "expectedRevision" + 1),
  CHECK ("intentSha256" ~ '^[a-f0-9]{64}$' AND "timeoutMs" BETWEEN 100 AND 120000 AND ("rateLimitRps" IS NULL OR "rateLimitRps" > 0)),
  CONSTRAINT "ProviderConfiguration_company_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderConfiguration_provider_fkey" FOREIGN KEY ("providerId", "companyId", "domain", "providerCode", "environment") REFERENCES "IntegrationProvider"("id", "companyId", "domain", "providerCode", "environment") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderConfiguration_actor_fkey" FOREIGN KEY ("companyMembershipId", "actorUserId", "tenantId", "companyId") REFERENCES "CompanyMembership"("id", "userId", "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderConfiguration_bridge_fkey" FOREIGN KEY ("companyMembershipId", "tenantMembershipId", "actorUserId", "tenantId") REFERENCES "CompanyMembership"("id", "tenantMembershipId", "userId", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderConfiguration_secret_fkey" FOREIGN KEY ("secretId", "providerId") REFERENCES "IntegrationProviderSecret"("id", "providerId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ProviderConfiguration_operation_key" ON "IntegrationProviderConfigurationVersion"("tenantId", "operationId");
CREATE UNIQUE INDEX "ProviderConfiguration_revision_key" ON "IntegrationProviderConfigurationVersion"("providerId", "revision");
CREATE UNIQUE INDEX "IntegrationProviderConfiguration_pointer_key" ON "IntegrationProviderConfigurationVersion"("id", "providerId", "companyId", "revision");
CREATE INDEX "ProviderConfiguration_owner_idx" ON "IntegrationProviderConfigurationVersion"("tenantId", "companyId", "providerId", "acceptedAt");
ALTER TABLE "IntegrationProvider"
  ADD CONSTRAINT "IntegrationProvider_current_configuration_fkey" FOREIGN KEY ("currentConfigurationId", "id", "companyId", "configurationRevision") REFERENCES "IntegrationProviderConfigurationVersion"("id", "providerId", "companyId", "revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "IntegrationProvider_configuration_complete_check" CHECK (("currentConfigurationId" IS NULL AND "configurationRevision" = 0) OR ("currentConfigurationId" IS NOT NULL AND "configurationRevision" > 0));
CREATE FUNCTION cp_protect_provider_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Integration configuration versions are immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER "ProviderConfiguration_immutable" BEFORE UPDATE OR DELETE ON "IntegrationProviderConfigurationVersion" FOR EACH ROW EXECUTE FUNCTION cp_protect_provider_configuration();
CREATE TRIGGER "ProviderConfiguration_no_truncate" BEFORE TRUNCATE ON "IntegrationProviderConfigurationVersion" FOR EACH STATEMENT EXECUTE FUNCTION cp_protect_provider_configuration();
CREATE FUNCTION cp_check_provider_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v "IntegrationProviderConfigurationVersion"%ROWTYPE;
BEGIN
  IF OLD."currentConfigurationId" IS NOT NULL AND NEW."currentConfigurationId" IS NULL THEN
    RAISE EXCEPTION 'Integration configuration history cannot be cleared' USING ERRCODE='23514';
  END IF;
  IF NEW."currentConfigurationId" IS NOT NULL THEN
    SELECT * INTO v FROM "IntegrationProviderConfigurationVersion" WHERE "id"=NEW."currentConfigurationId";
    IF NOT FOUND OR v."providerId" <> NEW."id" OR v."companyId" <> NEW."companyId" OR
       v."revision" <> NEW."configurationRevision" OR v."domain" <> NEW."domain" OR
       v."providerCode" <> NEW."providerCode" OR v."environment" <> NEW."environment" OR
       v."status" <> NEW."status" OR v."timeoutMs" <> NEW."timeoutMs" OR
       v."capabilities" IS DISTINCT FROM NEW."capabilities" OR v."retryPolicyId" IS DISTINCT FROM NEW."retryPolicyId" OR
       v."rateLimitRps" IS DISTINCT FROM NEW."rateLimitRps" OR v."secretId" IS DISTINCT FROM NEW."activeSecretId" THEN
      RAISE EXCEPTION 'Integration configuration publication disagrees' USING ERRCODE='23514';
    END IF;
    IF NEW."currentConfigurationId" IS DISTINCT FROM OLD."currentConfigurationId" AND
       (NEW."configurationRevision" <> OLD."configurationRevision" + 1 OR v."expectedRevision" <> OLD."configurationRevision") THEN
      RAISE EXCEPTION 'Integration configuration revision is stale' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "ProviderConfiguration_publication" BEFORE UPDATE ON "IntegrationProvider" FOR EACH ROW EXECUTE FUNCTION cp_check_provider_publication();
-- A receipt cannot commit as "accepted" without the matching atomic publication.
CREATE FUNCTION cp_check_configuration_receipt_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "IntegrationProvider" p WHERE p."id"=NEW."providerId"
    AND p."companyId"=NEW."companyId" AND p."currentConfigurationId"=NEW."id"
    AND p."configurationRevision"=NEW."revision") THEN
    RAISE EXCEPTION 'Integration configuration receipt was not published' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "ProviderConfiguration_receipt_publication"
  AFTER INSERT ON "IntegrationProviderConfigurationVersion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cp_check_configuration_receipt_publication();
