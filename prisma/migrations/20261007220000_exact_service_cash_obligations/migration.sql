-- Approved zero service prices are noncollectible; preserve every other price-snapshot check.
ALTER TABLE "OrderPriceSnapshot" DROP CONSTRAINT "OrderPriceSnapshot_check";
ALTER TABLE "OrderPriceSnapshot" ADD CONSTRAINT "OrderPriceSnapshot_check" CHECK (kind IN ('standard','exception','revision') AND total>=0 AND octet_length(content::text)<=65536 AND "contentHash" ~ '^[a-f0-9]{64}$' AND "intentHash" ~ '^[a-f0-9]{64}$' AND length(btrim(reason)) BETWEEN 1 AND 1000);

CREATE TABLE "OrderServicePaymentInstruction" (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), "tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,"orderId" uuid NOT NULL UNIQUE,
 "billToId" uuid NOT NULL,"payerCustomerEntityId" uuid NOT NULL,"actorUserId" uuid NOT NULL,"companyMembershipId" uuid NOT NULL,"tenantMembershipId" uuid NOT NULL,
 "operationId" uuid NOT NULL,"intentHash" text NOT NULL CHECK("intentHash" ~ '^[a-f0-9]{64}$'), method text NOT NULL CHECK(method='CASH'),
 "collectionParty" text NOT NULL CHECK("collectionParty" IN ('SENDER','RECIPIENT')),evidence text NOT NULL CHECK(length(evidence) BETWEEN 1 AND 500),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("tenantId","operationId"),UNIQUE(id,"tenantId","companyId","legalEntityId","orderId","billToId","payerCustomerEntityId"),
 CONSTRAINT "ServiceInstruction_billto_fk" FOREIGN KEY("billToId","tenantId","companyId","legalEntityId","orderId","payerCustomerEntityId") REFERENCES "OrderBillTo"(id,"tenantId","companyId","legalEntityId","orderId","payerCustomerEntityId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "ServiceInstruction_actor_fk" FOREIGN KEY("companyMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "ServiceInstruction_bridge_fk" FOREIGN KEY("companyMembershipId","tenantMembershipId","actorUserId","tenantId") REFERENCES "CompanyMembership"(id,"tenantMembershipId","userId","tenantId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "ServiceInstruction_owner_idx" ON "OrderServicePaymentInstruction"("tenantId","companyId","orderId");
CREATE TABLE "OrderServiceCashObligation" (
 "priceApprovalId" uuid PRIMARY KEY,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,"orderId" uuid NOT NULL,
 "instructionId" uuid NOT NULL,"billToId" uuid NOT NULL,"payerCustomerEntityId" uuid NOT NULL,"policyVersionId" uuid NOT NULL,
 amount numeric(20,4) NOT NULL CHECK(amount>=0),currency varchar(3) NOT NULL,"collectionId" uuid,"previousApprovalId" uuid,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(amount=0 OR "collectionId" IS NOT NULL),
 CONSTRAINT "ServiceObligation_money_key" UNIQUE("priceApprovalId","tenantId","companyId","legalEntityId","orderId",amount,currency),
 CONSTRAINT "ServiceObligation_owner_key" UNIQUE("priceApprovalId","tenantId","companyId","legalEntityId","orderId"),
 CONSTRAINT "ServiceObligation_source_fk" FOREIGN KEY("priceApprovalId","tenantId","companyId","legalEntityId","orderId",currency,amount,"billToId","payerCustomerEntityId","policyVersionId") REFERENCES "OrderPriceApproval"("snapshotId","tenantId","companyId","legalEntityId","orderId",currency,total,"billToId","payerCustomerEntityId","policyVersionId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "ServiceObligation_instruction_fk" FOREIGN KEY("instructionId","tenantId","companyId","legalEntityId","orderId","billToId","payerCustomerEntityId") REFERENCES "OrderServicePaymentInstruction"(id,"tenantId","companyId","legalEntityId","orderId","billToId","payerCustomerEntityId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "ServiceObligation_collection_fk" FOREIGN KEY("orderId","collectionId") REFERENCES "CashCollection"("orderId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "ServiceObligation_previous_fk" FOREIGN KEY("previousApprovalId","tenantId","companyId","legalEntityId","orderId") REFERENCES "OrderServiceCashObligation"("priceApprovalId","tenantId","companyId","legalEntityId","orderId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX "ServiceObligation_owner_idx" ON "OrderServiceCashObligation"("tenantId","companyId","orderId");
-- Existing unproved states are not adopted/certified. New/changed references must match exact obligation money.
ALTER TABLE "RestrictedCashState" ADD CONSTRAINT "RestrictedCashState_service_basis_fk" FOREIGN KEY("priceApprovalId","tenantId","companyId","legalEntityId","orderId",amount,currency) REFERENCES "OrderServiceCashObligation"("priceApprovalId","tenantId","companyId","legalEntityId","orderId",amount,currency) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
CREATE TRIGGER "ServiceInstruction_immutable" BEFORE UPDATE OR DELETE ON "OrderServicePaymentInstruction" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "ServiceInstruction_no_truncate" BEFORE TRUNCATE ON "OrderServicePaymentInstruction" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "ServiceObligation_immutable" BEFORE UPDATE OR DELETE ON "OrderServiceCashObligation" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "ServiceObligation_no_truncate" BEFORE TRUNCATE ON "OrderServiceCashObligation" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE FUNCTION cp_service_cash_price_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."currentPriceApprovalId" IS DISTINCT FROM OLD."currentPriceApprovalId" AND EXISTS(SELECT 1 FROM "OrderServicePaymentInstruction" WHERE "orderId"=OLD.id) THEN
  IF OLD."paymentState"<>'UNPAID' OR OLD."serviceChargePaidStatus" IS DISTINCT FROM 'NOT_PAID' OR
    EXISTS(SELECT 1 FROM "PaymentIntent" WHERE "orderId"=OLD.id) OR EXISTS(SELECT 1 FROM "Invoice" WHERE "orderId"=OLD.id) OR
    EXISTS(SELECT 1 FROM "RestrictedCashState" WHERE "orderId"=OLD.id) OR
    EXISTS(SELECT 1 FROM "CashCollection" c WHERE c."orderId"=OLD.id AND (c.status<>'expected' OR c."collectedAmount" IS NOT NULL OR c."currentHolderType"<>'none' OR EXISTS(SELECT 1 FROM "CashCollectionEvent" e WHERE e."cashCollectionId"=c.id AND e."eventType"<>'expected'))) THEN
      RAISE EXCEPTION 'Service cash basis frozen';
  END IF;
  IF NEW."currentPriceApprovalId" IS NULL OR NOT EXISTS(SELECT 1 FROM "OrderServiceCashObligation" WHERE "priceApprovalId"=NEW."currentPriceApprovalId" AND "orderId"=NEW.id) THEN RAISE EXCEPTION 'Exact service obligation required'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER "Order_service_cash_price_fence" BEFORE UPDATE OF "currentPriceApprovalId" ON "Order" FOR EACH ROW EXECUTE FUNCTION cp_service_cash_price_fence();
