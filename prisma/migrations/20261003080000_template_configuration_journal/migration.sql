-- Empty typed history; no legacy configuration is approved or backfilled.
ALTER TABLE "RouteTemplate" ADD COLUMN "configurationRevision" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "currentConfigurationId" UUID;
CREATE TABLE "RouteTemplateConfigurationVersion" (
 "id" UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "templateId" UUID NOT NULL,
 "actorUserId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL, "tenantMembershipId" UUID NOT NULL,
 "operationId" UUID NOT NULL, "intentSha256" TEXT NOT NULL,
 "expectedRevision" INTEGER NOT NULL, "revision" INTEGER NOT NULL,
 "name" TEXT NOT NULL, "code" TEXT, "isActive" BOOLEAN NOT NULL, "priority" INTEGER NOT NULL,
 "serviceType" "ServiceType", "transportMode" "TransportMode",
 "originCountryCode" TEXT, "destinationCountryCode" TEXT, "legCount" INTEGER NOT NULL,
 "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdTransaction" BIGINT NOT NULL DEFAULT txid_current(),
 CHECK ("expectedRevision">=0 AND "revision"="expectedRevision"+1 AND "legCount" BETWEEN 0 AND 100),
 CHECK ("intentSha256" ~ '^[a-f0-9]{64}$'),
 CHECK (octet_length("name")<=2048 AND octet_length(COALESCE("code",''))<=2048 AND octet_length(COALESCE("originCountryCode",''))<=2048 AND octet_length(COALESCE("destinationCountryCode",''))<=2048),
 CONSTRAINT "TemplateConfiguration_company_fkey" FOREIGN KEY ("tenantId","companyId") REFERENCES "Organization"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "TemplateConfiguration_template_fkey" FOREIGN KEY ("companyId","templateId") REFERENCES "RouteTemplate"("companyId","id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "TemplateConfiguration_actor_fkey" FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"("id","userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "TemplateConfiguration_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"("id","tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "TemplateConfiguration_operation_key" ON "RouteTemplateConfigurationVersion"("tenantId","operationId");
CREATE UNIQUE INDEX "TemplateConfiguration_revision_key" ON "RouteTemplateConfigurationVersion"("templateId","revision");
CREATE UNIQUE INDEX "TemplateConfiguration_pointer_key" ON "RouteTemplateConfigurationVersion"("id","templateId","companyId","revision");
CREATE UNIQUE INDEX "TemplateConfiguration_leg_owner_key" ON "RouteTemplateConfigurationVersion"("id","templateId");
CREATE INDEX "TemplateConfiguration_owner_idx" ON "RouteTemplateConfigurationVersion"("tenantId","companyId","templateId","acceptedAt");
CREATE TABLE "RouteTemplateConfigurationLeg" (
 "versionId" UUID NOT NULL, "templateId" UUID NOT NULL, "sourceLegId" UUID NOT NULL,
 "sequence" INTEGER NOT NULL, "legCode" TEXT NOT NULL, "label" TEXT, "mode" "TransportMode" NOT NULL,
 "originCountryCode" TEXT, "destinationCountryCode" TEXT,
 CHECK (octet_length("legCode")<=2048 AND octet_length(COALESCE("label",''))<=2048 AND octet_length(COALESCE("originCountryCode",''))<=2048 AND octet_length(COALESCE("destinationCountryCode",''))<=2048),
 PRIMARY KEY ("versionId","sourceLegId"),
 CONSTRAINT "TemplateConfigurationLeg_version_fkey" FOREIGN KEY ("versionId","templateId") REFERENCES "RouteTemplateConfigurationVersion"("id","templateId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "TemplateConfigurationLeg_source_fkey" FOREIGN KEY ("templateId","sourceLegId") REFERENCES "RouteTemplateLeg"("routeTemplateId","id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "TemplateConfigurationLeg_sequence_key" ON "RouteTemplateConfigurationLeg"("versionId","sequence");
CREATE UNIQUE INDEX "TemplateConfigurationLeg_code_key" ON "RouteTemplateConfigurationLeg"("versionId","legCode");
ALTER TABLE "RouteTemplate" ADD CONSTRAINT "Template_current_configuration_fkey"
 FOREIGN KEY ("currentConfigurationId","id","companyId","configurationRevision") REFERENCES "RouteTemplateConfigurationVersion"("id","templateId","companyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT "Template_configuration_complete_check" CHECK (("currentConfigurationId" IS NULL AND "configurationRevision"=0) OR ("currentConfigurationId" IS NOT NULL AND "configurationRevision">0));
CREATE FUNCTION cp_protect_template_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Template configuration history is immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER "TemplateConfiguration_immutable" BEFORE UPDATE OR DELETE ON "RouteTemplateConfigurationVersion" FOR EACH ROW EXECUTE FUNCTION cp_protect_template_history();
CREATE TRIGGER "TemplateConfiguration_no_truncate" BEFORE TRUNCATE ON "RouteTemplateConfigurationVersion" FOR EACH STATEMENT EXECUTE FUNCTION cp_protect_template_history();
CREATE TRIGGER "TemplateConfigurationLeg_immutable" BEFORE UPDATE OR DELETE ON "RouteTemplateConfigurationLeg" FOR EACH ROW EXECUTE FUNCTION cp_protect_template_history();
CREATE TRIGGER "TemplateConfigurationLeg_no_truncate" BEFORE TRUNCATE ON "RouteTemplateConfigurationLeg" FOR EACH STATEMENT EXECUTE FUNCTION cp_protect_template_history();
-- Seal child insertion to the creating transaction, not a time-window heuristic.
CREATE FUNCTION cp_stamp_template_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW."createdTransaction":=txid_current(); RETURN NEW; END; $$;
CREATE TRIGGER "TemplateConfiguration_transaction" BEFORE INSERT ON "RouteTemplateConfigurationVersion" FOR EACH ROW EXECUTE FUNCTION cp_stamp_template_transaction();
CREATE FUNCTION cp_seal_template_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "RouteTemplateConfigurationVersion" WHERE "id"=NEW."versionId" AND "templateId"=NEW."templateId" AND "createdTransaction"=txid_current()) THEN
  RAISE EXCEPTION 'Template configuration children are sealed' USING ERRCODE='23514';
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER "TemplateConfigurationLeg_sealed" BEFORE INSERT ON "RouteTemplateConfigurationLeg" FOR EACH ROW EXECUTE FUNCTION cp_seal_template_leg();
CREATE FUNCTION cp_template_snapshot_agrees(p_id UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t "RouteTemplate"%ROWTYPE; v "RouteTemplateConfigurationVersion"%ROWTYPE;
BEGIN
 SELECT * INTO t FROM "RouteTemplate" WHERE "id"=p_id;
 IF NOT FOUND OR t."currentConfigurationId" IS NULL THEN RETURN; END IF;
 SELECT * INTO v FROM "RouteTemplateConfigurationVersion" WHERE "id"=t."currentConfigurationId";
 IF NOT FOUND OR ROW(v."templateId",v."companyId",v."revision",v."name",v."code",v."isActive",v."priority",v."serviceType",v."transportMode",v."originCountryCode",v."destinationCountryCode")
   IS DISTINCT FROM ROW(t."id",t."companyId",t."configurationRevision",t."name",t."code",t."isActive",t."priority",t."serviceType",t."transportMode",t."originCountryCode",t."destinationCountryCode")
 OR octet_length(v."name"||COALESCE(v."code",'')||COALESCE(v."originCountryCode",'')||COALESCE(v."destinationCountryCode",''))+
  (SELECT COALESCE(sum(octet_length("legCode"||COALESCE("label",'')||COALESCE("originCountryCode",'')||COALESCE("destinationCountryCode",''))),0) FROM "RouteTemplateConfigurationLeg" WHERE "versionId"=v."id")>65536
 OR v."legCount"<>(SELECT count(*) FROM "RouteTemplateLeg" WHERE "routeTemplateId"=t."id")
 OR v."legCount"<>(SELECT count(*) FROM "RouteTemplateConfigurationLeg" WHERE "versionId"=v."id")
 OR EXISTS (
  (SELECT "id","sequence","legCode","label","mode","originCountryCode","destinationCountryCode" FROM "RouteTemplateLeg" WHERE "routeTemplateId"=t."id")
  EXCEPT
  (SELECT "sourceLegId","sequence","legCode","label","mode","originCountryCode","destinationCountryCode" FROM "RouteTemplateConfigurationLeg" WHERE "versionId"=v."id")
 ) THEN RAISE EXCEPTION 'Template configuration snapshot disagrees' USING ERRCODE='23514'; END IF;
END; $$;
CREATE FUNCTION cp_check_template_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v "RouteTemplateConfigurationVersion"%ROWTYPE;
BEGIN
 IF OLD."currentConfigurationId" IS NOT NULL AND NEW."currentConfigurationId" IS NULL THEN RAISE EXCEPTION 'Template history cannot be cleared' USING ERRCODE='23514'; END IF;
 IF NEW."currentConfigurationId" IS DISTINCT FROM OLD."currentConfigurationId" THEN
  SELECT * INTO v FROM "RouteTemplateConfigurationVersion" WHERE "id"=NEW."currentConfigurationId";
  IF NOT FOUND OR NEW."configurationRevision"<>OLD."configurationRevision"+1 OR v."expectedRevision"<>OLD."configurationRevision" THEN RAISE EXCEPTION 'Template configuration revision is stale' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER "TemplateConfiguration_publication" BEFORE UPDATE ON "RouteTemplate" FOR EACH ROW EXECUTE FUNCTION cp_check_template_publication();
CREATE FUNCTION cp_check_template_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "RouteTemplate" WHERE "id"=NEW."templateId" AND "currentConfigurationId"=NEW."id" AND "configurationRevision"=NEW."revision") THEN
  RAISE EXCEPTION 'Template configuration receipt was not published' USING ERRCODE='23514';
 END IF;
 PERFORM cp_template_snapshot_agrees(NEW."templateId"); RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "TemplateConfiguration_receipt_publication" AFTER INSERT ON "RouteTemplateConfigurationVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cp_check_template_receipt();
CREATE FUNCTION cp_check_template_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='RouteTemplate' THEN PERFORM cp_template_snapshot_agrees(NEW."id");
 ELSE
  IF TG_OP<>'INSERT' THEN PERFORM cp_template_snapshot_agrees(OLD."routeTemplateId"); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM cp_template_snapshot_agrees(NEW."routeTemplateId"); END IF;
 END IF; RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "TemplateConfiguration_current_snapshot" AFTER UPDATE ON "RouteTemplate" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cp_check_template_current();
CREATE CONSTRAINT TRIGGER "TemplateConfiguration_current_legs" AFTER INSERT OR UPDATE OR DELETE ON "RouteTemplateLeg" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cp_check_template_current();
-- TRUNCATE must not bypass the row-level snapshot protections, even with CASCADE.
CREATE TRIGGER "TemplateConfiguration_source_no_truncate" BEFORE TRUNCATE ON "RouteTemplateLeg" FOR EACH STATEMENT EXECUTE FUNCTION cp_protect_template_history();
-- Child changes and publication serialize on the same parent, before mutation.
CREATE FUNCTION cp_lock_template_leg_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_ids UUID[];
BEGIN
 IF TG_OP='INSERT' THEN parent_ids:=ARRAY[NEW."routeTemplateId"];
 ELSIF TG_OP='DELETE' THEN parent_ids:=ARRAY[OLD."routeTemplateId"];
 ELSE parent_ids:=ARRAY[OLD."routeTemplateId",NEW."routeTemplateId"]; END IF;
 PERFORM "id" FROM "RouteTemplate" WHERE "id"=ANY(parent_ids) ORDER BY "id" FOR UPDATE;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER "TemplateConfiguration_source_parent_lock" BEFORE INSERT OR UPDATE OR DELETE ON "RouteTemplateLeg" FOR EACH ROW EXECUTE FUNCTION cp_lock_template_leg_parent();
