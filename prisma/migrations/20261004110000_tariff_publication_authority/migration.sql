CREATE TYPE "TariffPublicationDecisionKind" AS ENUM ('approved','rejected');
ALTER TABLE "TariffPlan" ADD COLUMN "contentGeneration" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "approvedVersionId" UUID, ADD COLUMN "approvedDecision" "TariffPublicationDecisionKind",
 ADD CONSTRAINT "TariffPlan_version_owner_key" UNIQUE ("id","tenantId","companyId"),
 ADD CONSTRAINT "TariffPlan_publication_complete_check" CHECK ("contentGeneration">=0 AND (("approvedVersionId" IS NULL AND "approvedDecision" IS NULL) OR ("approvedVersionId" IS NOT NULL AND "approvedDecision" IS NOT NULL AND "approvedDecision"='approved' AND "tenantId" IS NOT NULL AND "companyId" IS NOT NULL)));
CREATE TABLE "TariffConfigurationVersion" (
 "id" UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(), "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "planId" UUID NOT NULL,
 "sourceGeneration" INTEGER NOT NULL, "contentSha256" CHAR(64) NOT NULL, "content" JSONB NOT NULL,
 "actorUserId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL, "tenantMembershipId" UUID NOT NULL,
 "operationId" UUID NOT NULL, "intentSha256" CHAR(64) NOT NULL, "reason" TEXT NOT NULL, "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TariffVersion_operation_key" UNIQUE ("tenantId","operationId"),
 CONSTRAINT "TariffVersion_generation_key" UNIQUE ("planId","sourceGeneration"),
 CONSTRAINT "TariffVersion_content_key" UNIQUE ("id","planId","tenantId","companyId","sourceGeneration","contentSha256"),
 CONSTRAINT "TariffVersion_owner_key" UNIQUE ("id","planId","tenantId","companyId"),
 CONSTRAINT "TariffVersion_maker_key" UNIQUE ("id","actorUserId"),
 CONSTRAINT "TariffVersion_content_check" CHECK ("sourceGeneration">=0 AND "contentSha256" ~ '^[0-9a-f]{64}$' AND "intentSha256" ~ '^[0-9a-f]{64}$' AND length(btrim("reason")) BETWEEN 1 AND 1000 AND octet_length("content"::text)<=262144),
 CONSTRAINT "TariffVersion_owner_fkey" FOREIGN KEY ("planId","tenantId","companyId") REFERENCES "TariffPlan"("id","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "TariffVersion_actor_fkey" FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"("id","userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "TariffVersion_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"("id","tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "TariffVersion_owner_idx" ON "TariffConfigurationVersion"("tenantId","companyId","planId","proposedAt");
CREATE TABLE "TariffPublicationDecision" (
 "versionId" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "planId" UUID NOT NULL,
 "sourceGeneration" INTEGER NOT NULL, "contentSha256" CHAR(64) NOT NULL, "decision" "TariffPublicationDecisionKind" NOT NULL,
 "makerUserId" UUID NOT NULL, "actorUserId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL, "tenantMembershipId" UUID NOT NULL,
 "operationId" UUID NOT NULL, "intentSha256" CHAR(64) NOT NULL, "reason" TEXT NOT NULL, "previousVersionId" UUID,
 "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TariffDecision_operation_key" UNIQUE ("tenantId","operationId"),
 CONSTRAINT "TariffDecision_pointer_key" UNIQUE ("versionId","planId","tenantId","companyId","decision"),
 CONSTRAINT "TariffDecision_separation_check" CHECK ("makerUserId"<>"actorUserId" AND "intentSha256" ~ '^[0-9a-f]{64}$' AND length(btrim("reason")) BETWEEN 1 AND 1000 AND ("previousVersionId" IS NULL OR ("decision"='approved' AND "previousVersionId"<>"versionId"))),
 CONSTRAINT "TariffDecision_content_fkey" FOREIGN KEY ("versionId","planId","tenantId","companyId","sourceGeneration","contentSha256") REFERENCES "TariffConfigurationVersion"("id","planId","tenantId","companyId","sourceGeneration","contentSha256") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "TariffDecision_maker_fkey" FOREIGN KEY ("versionId","makerUserId") REFERENCES "TariffConfigurationVersion"("id","actorUserId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "TariffDecision_actor_fkey" FOREIGN KEY ("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"("id","userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "TariffDecision_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"("id","tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "TariffDecision_previous_fkey" FOREIGN KEY ("previousVersionId","planId","tenantId","companyId") REFERENCES "TariffConfigurationVersion"("id","planId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "TariffDecision_owner_idx" ON "TariffPublicationDecision"("tenantId","companyId","decidedAt");
ALTER TABLE "TariffPlan" ADD CONSTRAINT "TariffPlan_approved_pointer_fkey" FOREIGN KEY ("approvedVersionId","id","tenantId","companyId","approvedDecision") REFERENCES "TariffPublicationDecision"("versionId","planId","tenantId","companyId","decision") ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE FUNCTION public.cp_tariff_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Tariff history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER "TariffVersion_immutable" BEFORE UPDATE OR DELETE ON "TariffConfigurationVersion" FOR EACH ROW EXECUTE FUNCTION public.cp_tariff_history_immutable();
CREATE TRIGGER "TariffDecision_immutable" BEFORE UPDATE OR DELETE ON "TariffPublicationDecision" FOR EACH ROW EXECUTE FUNCTION public.cp_tariff_history_immutable();
CREATE TRIGGER "TariffVersion_no_truncate" BEFORE TRUNCATE ON "TariffConfigurationVersion" FOR EACH STATEMENT EXECUTE FUNCTION public.cp_tariff_history_immutable();
CREATE TRIGGER "TariffDecision_no_truncate" BEFORE TRUNCATE ON "TariffPublicationDecision" FOR EACH STATEMENT EXECUTE FUNCTION public.cp_tariff_history_immutable();
CREATE FUNCTION public.cp_tariff_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_generation INTEGER; prior_generation INTEGER;
BEGIN
 IF TG_OP='INSERT' THEN NEW."contentGeneration"=0; RETURN NEW; END IF;
 IF NEW."approvedVersionId" IS DISTINCT FROM OLD."approvedVersionId" THEN
  IF NEW."approvedVersionId" IS NULL THEN RAISE EXCEPTION 'Approved tariff history cannot be cleared' USING ERRCODE='23514'; END IF;
  SELECT "sourceGeneration" INTO next_generation FROM "TariffPublicationDecision" WHERE "versionId"=NEW."approvedVersionId" AND "planId"=OLD.id AND "tenantId"=OLD."tenantId" AND "companyId"=OLD."companyId" AND decision='approved';
  IF next_generation IS DISTINCT FROM OLD."contentGeneration" THEN RAISE EXCEPTION 'Stale or unapproved tariff publication' USING ERRCODE='23514'; END IF;
  IF OLD."approvedVersionId" IS NOT NULL THEN
   SELECT "sourceGeneration" INTO prior_generation FROM "TariffPublicationDecision" WHERE "versionId"=OLD."approvedVersionId";
   IF next_generation<=prior_generation THEN RAISE EXCEPTION 'Tariff publication cannot move backwards' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['updatedAt','contentGeneration','approvedVersionId','approvedDecision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updatedAt','contentGeneration','approvedVersionId','approvedDecision']) OR pg_trigger_depth()>1 THEN
  NEW."contentGeneration"=OLD."contentGeneration"+1;
 ELSE NEW."contentGeneration"=OLD."contentGeneration"; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "TariffPlan_generation" BEFORE INSERT OR UPDATE ON "TariffPlan" FOR EACH ROW EXECUTE FUNCTION public.cp_tariff_generation();
CREATE FUNCTION public.cp_tariff_rate_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'updatedAt') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN RETURN NEW; END IF;
 IF TG_OP IN ('UPDATE','DELETE') THEN UPDATE "TariffPlan" SET "updatedAt"=CURRENT_TIMESTAMP WHERE id=OLD."tariffPlanId"; END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW."tariffPlanId"<>OLD."tariffPlanId") THEN UPDATE "TariffPlan" SET "updatedAt"=CURRENT_TIMESTAMP WHERE id=NEW."tariffPlanId"; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER "TariffRate_generation" AFTER INSERT OR UPDATE OR DELETE ON "TariffRate" FOR EACH ROW EXECUTE FUNCTION public.cp_tariff_rate_generation();
