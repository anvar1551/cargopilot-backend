CREATE TABLE "OrderCreationIntent" (
 "id" UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "userId" UUID NOT NULL,
 "tenantMembershipId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL,
 "operationId" UUID NOT NULL, "kind" VARCHAR(10) NOT NULL,
 "fingerprint" CHAR(64) NOT NULL, "normalizationVersion" INTEGER NOT NULL DEFAULT 1,
 "rowCount" INTEGER NOT NULL, "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "OrderCreationIntent_tenant_operation_key" UNIQUE ("tenantId","operationId"),
 CONSTRAINT "OrderCreationIntent_owner_key" UNIQUE ("id","tenantId","companyId"),
 CONSTRAINT "OrderCreationIntent_shape_check" CHECK (
  "normalizationVersion"=1 AND "fingerprint" ~ '^[a-f0-9]{64}$' AND
  (("kind"='order' AND "rowCount"=1) OR ("kind"='import' AND "rowCount" BETWEEN 1 AND 100))),
 CONSTRAINT "OrderCreationIntent_company_context_fkey" FOREIGN KEY ("companyMembershipId","userId","tenantId","companyId") REFERENCES "CompanyMembership"("id","userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "OrderCreationIntent_membership_bridge_fkey" FOREIGN KEY ("companyMembershipId","tenantMembershipId","userId","tenantId") REFERENCES "CompanyMembership"("id","tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "OrderCreationIntent_tenantId_companyId_acceptedAt_idx" ON "OrderCreationIntent"("tenantId","companyId","acceptedAt");
CREATE TABLE "OrderCreationReceipt" (
 "intentId" UUID NOT NULL, "ordinal" INTEGER NOT NULL CHECK ("ordinal">=0),
 "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "orderId" UUID NOT NULL UNIQUE,
 "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("intentId","ordinal"),
 CONSTRAINT "OrderCreationReceipt_intent_owner_fkey" FOREIGN KEY ("intentId","tenantId","companyId") REFERENCES "OrderCreationIntent"("id","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "OrderCreationReceipt_order_owner_fkey" FOREIGN KEY ("tenantId","orderId","companyId") REFERENCES "Order"("tenantId","id","ownerOrgId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "OrderCreationReceipt_tenantId_companyId_confirmedAt_idx" ON "OrderCreationReceipt"("tenantId","companyId","confirmedAt");
CREATE FUNCTION cp_creation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Creation identity and receipts are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER "OrderCreationIntent_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE ON "OrderCreationIntent" FOR EACH STATEMENT EXECUTE FUNCTION cp_creation_immutable();
CREATE TRIGGER "OrderCreationReceipt_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE ON "OrderCreationReceipt" FOR EACH STATEMENT EXECUTE FUNCTION cp_creation_immutable();
CREATE FUNCTION cp_creation_receipt_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
 SELECT "rowCount" INTO n FROM "OrderCreationIntent" WHERE "id"=NEW."intentId" AND "tenantId"=NEW."tenantId" AND "companyId"=NEW."companyId";
 IF n IS NULL OR NEW."ordinal">=n THEN RAISE EXCEPTION 'Invalid creation receipt ordinal' USING ERRCODE='23514'; END IF;
 NEW."confirmedAt" := CURRENT_TIMESTAMP; RETURN NEW;
END $$;
CREATE TRIGGER "OrderCreationReceipt_ordinal" BEFORE INSERT ON "OrderCreationReceipt" FOR EACH ROW EXECUTE FUNCTION cp_creation_receipt_ordinal();
CREATE FUNCTION cp_creation_normal_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."kind"='order' AND NOT EXISTS (SELECT 1 FROM "OrderCreationReceipt" WHERE "intentId"=NEW."id" AND "ordinal"=0) THEN
 RAISE EXCEPTION 'Normal creation must confirm atomically' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "OrderCreationIntent_normal_confirmation" AFTER INSERT ON "OrderCreationIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cp_creation_normal_confirmation();
