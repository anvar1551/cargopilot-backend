CREATE TABLE "CarrierPublicationRepair" (
 "outboxId" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL,
 "providerId" UUID NOT NULL, "domain" "IntegrationDomain" NOT NULL, "providerCode" TEXT NOT NULL,
 "attemptNo" INTEGER NOT NULL, "userId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL,
 "tenantMembershipId" UUID NOT NULL, "resultSha256" CHAR(64) NOT NULL,
 "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CarrierPublicationRepair_purpose_check" CHECK ("domain" = 'carrier' AND "providerCode" = 'fake_carrier' AND "attemptNo" = 1 AND "resultSha256" ~ '^[0-9a-f]{64}$'),
 CONSTRAINT "CarrierPublicationRepair_source_fkey" FOREIGN KEY ("outboxId","companyId","providerId","domain","providerCode") REFERENCES "IntegrationOutbox" ("id","companyId","providerId","domain","providerCode") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CarrierPublicationRepair_publication_fkey" FOREIGN KEY ("outboxId","companyId","providerId","domain","providerCode") REFERENCES "IntegrationCanonicalEvent" ("outboxId","companyId","providerId","domain","providerCode") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CarrierPublicationRepair_attempt_fkey" FOREIGN KEY ("outboxId","attemptNo") REFERENCES "IntegrationDeliveryAttempt" ("outboxId","attemptNo") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CarrierPublicationRepair_company_fkey" FOREIGN KEY ("companyMembershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership" ("id","userId","tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CarrierPublicationRepair_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership" ("id","tenantMembershipId","userId","tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "CarrierPublicationRepair_tenantId_companyId_recordedAt_idx" ON "CarrierPublicationRepair" ("tenantId","companyId","recordedAt");
CREATE FUNCTION public.cp_publication_repair_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Carrier publication repair evidence is immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER "CarrierPublicationRepair_immutable" BEFORE UPDATE OR DELETE ON "CarrierPublicationRepair" FOR EACH ROW EXECUTE FUNCTION public.cp_publication_repair_immutable();
