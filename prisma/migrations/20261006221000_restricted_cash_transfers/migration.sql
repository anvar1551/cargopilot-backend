ALTER TABLE "OrderPriceApproval" ADD CONSTRAINT "Price_cash_owner_key" UNIQUE("snapshotId","tenantId","companyId","legalEntityId","orderId");
ALTER TABLE "CashCustodyOperation" ADD CONSTRAINT "Cash_operation_basis_key" UNIQUE("collectionId","eventId","tenantId","companyId","orderId",amount,currency);
CREATE TABLE "RestrictedCashState" (
 "collectionId" uuid PRIMARY KEY,"orderId" uuid NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cod','service_charge')),amount numeric(20,4) NOT NULL CHECK(amount>0),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 "holderMembershipId" uuid NOT NULL,"holderUserId" uuid NOT NULL,"holderWarehouseId" uuid,"eventId" uuid NOT NULL UNIQUE,"priceApprovalId" uuid NOT NULL,
 CONSTRAINT "DOM05_RestrictedCashState_fk0" FOREIGN KEY("tenantId","orderId","companyId") REFERENCES "Order"("tenantId",id,"ownerOrgId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashState_fk1" FOREIGN KEY("orderId","collectionId") REFERENCES "CashCollection"("orderId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashState_fk2" FOREIGN KEY("collectionId","eventId","tenantId","companyId","orderId",amount,currency) REFERENCES "CashCustodyOperation"("collectionId","eventId","tenantId","companyId","orderId",amount,currency) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashState_fk3" FOREIGN KEY("holderMembershipId","holderUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashState_fk4" FOREIGN KEY("tenantId","holderWarehouseId") REFERENCES "Warehouse"("tenantId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashState_fk5" FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashState_fk6" FOREIGN KEY("priceApprovalId","tenantId","companyId","legalEntityId","orderId") REFERENCES "OrderPriceApproval"("snapshotId","tenantId","companyId","legalEntityId","orderId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 UNIQUE("collectionId","tenantId","companyId","legalEntityId","orderId",kind,amount,currency)
);
CREATE TABLE "RestrictedCashTransferOffer" (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),"operationId" text NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,"orderId" uuid NOT NULL,"collectionId" uuid NOT NULL,
 kind text NOT NULL,amount numeric(20,4) NOT NULL,currency text NOT NULL,"expectedEventId" uuid NOT NULL,
 "sourceMembershipId" uuid NOT NULL,"sourceUserId" uuid NOT NULL,"sourceWarehouseId" uuid,
 "recipientMembershipId" uuid NOT NULL,"recipientUserId" uuid NOT NULL,"recipientWarehouseId" uuid,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),note text,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(("sourceWarehouseId" IS NULL)<>("recipientWarehouseId" IS NULL)),CHECK("sourceUserId"<>"recipientUserId"),
 CONSTRAINT "DOM05_RestrictedCashTransferOffer_fk0" FOREIGN KEY("collectionId","tenantId","companyId","legalEntityId","orderId",kind,amount,currency) REFERENCES "RestrictedCashState"("collectionId","tenantId","companyId","legalEntityId","orderId",kind,amount,currency) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashTransferOffer_fk1" FOREIGN KEY("collectionId","expectedEventId") REFERENCES "CashCustodyOperation"("collectionId","eventId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashTransferOffer_fk2" FOREIGN KEY("sourceMembershipId","sourceUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashTransferOffer_fk3" FOREIGN KEY("recipientMembershipId","recipientUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashTransferOffer_fk4" FOREIGN KEY("tenantId","sourceWarehouseId") REFERENCES "Warehouse"("tenantId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashTransferOffer_fk5" FOREIGN KEY("tenantId","recipientWarehouseId") REFERENCES "Warehouse"("tenantId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 UNIQUE("collectionId","expectedEventId"),UNIQUE(id,"tenantId","companyId"),UNIQUE("tenantId","companyId","operationId")
);
CREATE TABLE "RestrictedCashReceipt" (
 "operationId" text NOT NULL,"tenantId" uuid NOT NULL,"companyId" uuid NOT NULL,"legalEntityId" uuid NOT NULL,"orderId" uuid NOT NULL,"collectionId" uuid NOT NULL,
 "actorMembershipId" uuid NOT NULL,"actorUserId" uuid NOT NULL,"capabilityAcceptanceId" uuid NOT NULL,"capabilityAction" text NOT NULL DEFAULT 'accept' CHECK("capabilityAction"='accept'),
 action text NOT NULL CHECK(action IN ('collect','offer','accept','settle')), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 "transferOfferId" uuid,result jsonb NOT NULL,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("tenantId","companyId","operationId"),
 CONSTRAINT "DOM05_RestrictedCashReceipt_fk0" FOREIGN KEY("tenantId","orderId","companyId") REFERENCES "Order"("tenantId",id,"ownerOrgId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashReceipt_fk1" FOREIGN KEY("orderId","collectionId") REFERENCES "CashCollection"("orderId",id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashReceipt_fk2" FOREIGN KEY("actorMembershipId","actorUserId","tenantId","companyId") REFERENCES "CompanyMembership"(id,"userId","tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashReceipt_fk3" FOREIGN KEY("capabilityAcceptanceId","actorMembershipId","tenantId","companyId","legalEntityId","capabilityAction") REFERENCES "CashCapabilityGrantAction"("operationId","targetMembershipId","tenantId","companyId","legalEntityId",action) ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashReceipt_fk4" FOREIGN KEY("transferOfferId","tenantId","companyId") REFERENCES "RestrictedCashTransferOffer"(id,"tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
 CONSTRAINT "DOM05_RestrictedCashReceipt_fk5" FOREIGN KEY("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity"(id,"tenantId","companyId") ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "RestrictedCashReceipt_one_accept" ON "RestrictedCashReceipt"("transferOfferId") WHERE action='accept';
CREATE INDEX "RestrictedCashState_context" ON "RestrictedCashState"("tenantId","companyId","holderMembershipId","orderId");
CREATE INDEX "RestrictedCashTransferOffer_context" ON "RestrictedCashTransferOffer"("tenantId","companyId","recipientMembershipId","createdAt");
CREATE INDEX "RestrictedCashReceipt_context" ON "RestrictedCashReceipt"("tenantId","companyId","actorMembershipId","createdAt");
CREATE TRIGGER "RestrictedCashTransferOffer_immutable" BEFORE UPDATE OR DELETE ON "RestrictedCashTransferOffer" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "RestrictedCashTransferOffer_no_truncate" BEFORE TRUNCATE ON "RestrictedCashTransferOffer" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "RestrictedCashReceipt_immutable" BEFORE UPDATE OR DELETE ON "RestrictedCashReceipt" FOR EACH ROW EXECUTE FUNCTION cp_onboarding_receipt_immutable();
CREATE TRIGGER "RestrictedCashReceipt_no_truncate" BEFORE TRUNCATE ON "RestrictedCashReceipt" FOR EACH STATEMENT EXECUTE FUNCTION cp_onboarding_receipt_immutable();
-- Custody pointers may advance; accepted financial ownership/basis may not change.
CREATE FUNCTION cp_restricted_cash_basis_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['holderMembershipId','holderUserId','holderWarehouseId','eventId'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['holderMembershipId','holderUserId','holderWarehouseId','eventId'])
 THEN RAISE EXCEPTION 'Restricted cash basis is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "RestrictedCashState_basis_immutable" BEFORE UPDATE ON "RestrictedCashState"
 FOR EACH ROW EXECUTE FUNCTION cp_restricted_cash_basis_immutable();
