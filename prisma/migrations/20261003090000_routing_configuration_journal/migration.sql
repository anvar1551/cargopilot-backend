-- Empty immutable nonfinancial routing history, no inferred legacy acceptance.
ALTER TABLE "CarrierRoutingRule" ADD COLUMN "configurationRevision" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "currentConfigurationId" UUID;
CREATE UNIQUE INDEX "CarrierRoutingRule_identity_owner_key" ON "CarrierRoutingRule"("id","companyId");
CREATE TABLE "CarrierRoutingConfigurationVersion" (
 "id" UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(), "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "ruleId" UUID NOT NULL,
 "actorUserId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL, "tenantMembershipId" UUID NOT NULL,
 "operationId" UUID NOT NULL, "intentSha256" TEXT NOT NULL, "expectedRevision" INTEGER NOT NULL, "revision" INTEGER NOT NULL,
 "providerId" UUID NOT NULL, "providerVersionId" UUID NOT NULL, "providerRevision" INTEGER NOT NULL,
 "fallbackProviderId" UUID, "fallbackVersionId" UUID, "fallbackRevision" INTEGER,
 "routeTemplateId" UUID, "templateVersionId" UUID, "templateRevision" INTEGER, "routeTemplateLegId" UUID,
 "name" TEXT NOT NULL, "code" TEXT, "isActive" BOOLEAN NOT NULL, "priority" INTEGER NOT NULL, "autoBook" BOOLEAN NOT NULL,
 "serviceType" "ServiceType", "transportMode" "TransportMode", "originCountryCode" TEXT, "destinationCountryCode" TEXT,
 "minWeightKg" DECIMAL(10,2), "maxWeightKg" DECIMAL(10,2), "legSequence" INTEGER,
 "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("expectedRevision">=0 AND "revision"="expectedRevision"+1 AND "providerRevision">0 AND "intentSha256" ~ '^[a-f0-9]{64}$'),
 CHECK (("fallbackProviderId" IS NULL AND "fallbackVersionId" IS NULL AND "fallbackRevision" IS NULL) OR ("fallbackProviderId" IS NOT NULL AND "fallbackVersionId" IS NOT NULL AND "fallbackRevision" IS NOT NULL AND "fallbackRevision">0)),
 CHECK (("routeTemplateId" IS NULL AND "templateVersionId" IS NULL AND "templateRevision" IS NULL AND "routeTemplateLegId" IS NULL) OR ("routeTemplateId" IS NOT NULL AND "templateVersionId" IS NOT NULL AND "templateRevision" IS NOT NULL AND "templateRevision">0)),
 CHECK (("minWeightKg" IS NULL OR "minWeightKg">=0) AND ("maxWeightKg" IS NULL OR "maxWeightKg">=0) AND ("minWeightKg" IS NULL OR "maxWeightKg" IS NULL OR "minWeightKg"<="maxWeightKg")),
 CHECK (octet_length("name")<=2048 AND octet_length(COALESCE("code",''))<=2048 AND octet_length(COALESCE("originCountryCode",''))<=2048 AND octet_length(COALESCE("destinationCountryCode",''))<=2048),
 CONSTRAINT "RoutingConfiguration_company_fkey" FOREIGN KEY ("tenantId","companyId") REFERENCES "Organization"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RoutingConfiguration_rule_fkey" FOREIGN KEY ("ruleId","companyId") REFERENCES "CarrierRoutingRule"("id","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RoutingConfiguration_actor_fkey" FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"("id","userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RoutingConfiguration_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"("id","tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RoutingConfiguration_provider_fkey" FOREIGN KEY ("providerVersionId","providerId","companyId","providerRevision") REFERENCES "IntegrationProviderConfigurationVersion"("id","providerId","companyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RoutingConfiguration_fallback_fkey" FOREIGN KEY ("fallbackVersionId","fallbackProviderId","companyId","fallbackRevision") REFERENCES "IntegrationProviderConfigurationVersion"("id","providerId","companyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RoutingConfiguration_template_fkey" FOREIGN KEY ("templateVersionId","routeTemplateId","companyId","templateRevision") REFERENCES "RouteTemplateConfigurationVersion"("id","templateId","companyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RoutingConfiguration_leg_fkey" FOREIGN KEY ("templateVersionId","routeTemplateLegId") REFERENCES "RouteTemplateConfigurationLeg"("versionId","sourceLegId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "RoutingConfiguration_operation_key" ON "CarrierRoutingConfigurationVersion"("tenantId","operationId");
CREATE UNIQUE INDEX "RoutingConfiguration_revision_key" ON "CarrierRoutingConfigurationVersion"("ruleId","revision");
CREATE UNIQUE INDEX "RoutingConfiguration_pointer_key" ON "CarrierRoutingConfigurationVersion"("id","ruleId","companyId","revision");
CREATE INDEX "RoutingConfiguration_owner_idx" ON "CarrierRoutingConfigurationVersion"("tenantId","companyId","ruleId","acceptedAt");
ALTER TABLE "CarrierRoutingRule" ADD CONSTRAINT "Routing_current_configuration_fkey" FOREIGN KEY ("currentConfigurationId","id","companyId","configurationRevision") REFERENCES "CarrierRoutingConfigurationVersion"("id","ruleId","companyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT "Routing_configuration_complete_check" CHECK (("currentConfigurationId" IS NULL AND "configurationRevision"=0) OR ("currentConfigurationId" IS NOT NULL AND "configurationRevision">0));
CREATE TRIGGER "RoutingConfiguration_immutable" BEFORE UPDATE OR DELETE ON "CarrierRoutingConfigurationVersion" FOR EACH ROW EXECUTE FUNCTION cp_protect_provider_configuration();
CREATE TRIGGER "RoutingConfiguration_no_truncate" BEFORE TRUNCATE ON "CarrierRoutingConfigurationVersion" FOR EACH STATEMENT EXECUTE FUNCTION cp_protect_provider_configuration();
CREATE FUNCTION cp_routing_snapshot_agrees(p_id UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r "CarrierRoutingRule"%ROWTYPE; v "CarrierRoutingConfigurationVersion"%ROWTYPE;
BEGIN
 SELECT * INTO r FROM "CarrierRoutingRule" WHERE "id"=p_id;
 IF NOT FOUND OR r."currentConfigurationId" IS NULL THEN RETURN; END IF;
 SELECT * INTO v FROM "CarrierRoutingConfigurationVersion" WHERE "id"=r."currentConfigurationId";
 IF NOT FOUND OR r."conditionsJson" IS NOT NULL OR ROW(v."ruleId",v."companyId",v."revision",v."providerId",v."fallbackProviderId",v."routeTemplateId",v."routeTemplateLegId",v."name",v."code",v."isActive",v."priority",v."autoBook",v."serviceType",v."transportMode",v."originCountryCode",v."destinationCountryCode",v."minWeightKg",v."maxWeightKg",v."legSequence")
 IS DISTINCT FROM ROW(r."id",r."companyId",r."configurationRevision",r."providerId",r."fallbackProviderId",r."routeTemplateId",r."routeTemplateLegId",r."name",r."code",r."isActive",r."priority",r."autoBook",r."serviceType",r."transportMode",r."originCountryCode",r."destinationCountryCode",r."minWeightKg",r."maxWeightKg",r."legSequence")
 OR NOT EXISTS (SELECT 1 FROM "IntegrationProviderConfigurationVersion" WHERE "id"=v."providerVersionId" AND "domain"='carrier' AND "status"='active')
 OR (v."fallbackVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "IntegrationProviderConfigurationVersion" WHERE "id"=v."fallbackVersionId" AND "domain"='carrier' AND "status"='active'))
 OR (v."templateVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "RouteTemplateConfigurationVersion" WHERE "id"=v."templateVersionId" AND "isActive"))
 THEN RAISE EXCEPTION 'Routing configuration snapshot disagrees' USING ERRCODE='23514'; END IF;
END; $$;
CREATE FUNCTION cp_check_routing_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v "CarrierRoutingConfigurationVersion"%ROWTYPE;
BEGIN
 IF OLD."currentConfigurationId" IS NOT NULL AND NEW."currentConfigurationId" IS NULL THEN RAISE EXCEPTION 'Routing history cannot be cleared' USING ERRCODE='23514'; END IF;
 IF NEW."currentConfigurationId" IS DISTINCT FROM OLD."currentConfigurationId" THEN
 SELECT * INTO v FROM "CarrierRoutingConfigurationVersion" WHERE "id"=NEW."currentConfigurationId";
 IF NOT FOUND OR NEW."configurationRevision"<>OLD."configurationRevision"+1 OR v."expectedRevision"<>OLD."configurationRevision" THEN RAISE EXCEPTION 'Routing configuration revision is stale' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER "RoutingConfiguration_publication" BEFORE UPDATE ON "CarrierRoutingRule" FOR EACH ROW EXECUTE FUNCTION cp_check_routing_publication();
CREATE FUNCTION cp_check_routing_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM cp_routing_snapshot_agrees(NEW."id"); RETURN NULL; END; $$;
CREATE CONSTRAINT TRIGGER "RoutingConfiguration_current_snapshot" AFTER UPDATE ON "CarrierRoutingRule" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cp_check_routing_current();
CREATE FUNCTION cp_check_routing_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "CarrierRoutingRule" WHERE "id"=NEW."ruleId" AND "currentConfigurationId"=NEW."id" AND "configurationRevision"=NEW."revision") THEN RAISE EXCEPTION 'Routing receipt was not published' USING ERRCODE='23514'; END IF;
 PERFORM cp_routing_snapshot_agrees(NEW."ruleId"); RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "RoutingConfiguration_receipt_publication" AFTER INSERT ON "CarrierRoutingConfigurationVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cp_check_routing_receipt();
