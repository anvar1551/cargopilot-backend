-- Additive receipts only. No historical amount conversion or inferred ownership.
CREATE UNIQUE INDEX "CashCollection_order_identity_key" ON "CashCollection"("orderId", "id");
CREATE UNIQUE INDEX "CashCollectionEvent_collection_identity_key" ON "CashCollectionEvent"("cashCollectionId", "id");
CREATE TABLE "CashCustodyOperation" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "tenantId" UUID NOT NULL, "companyId" UUID NOT NULL, "orderId" UUID NOT NULL,
  "collectionId" UUID NOT NULL, "eventId" UUID NOT NULL,
  "actorId" UUID NOT NULL, "companyMembershipId" UUID NOT NULL,
  "operationKey" TEXT NOT NULL, "action" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL, "currency" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CashCustodyOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CashCustodyOperation_valid_receipt" CHECK (
    "amount" > 0 AND "currency" ~ '^[A-Z]{3}$' AND "action" IN ('collect','handoff','settle')
    AND "operationKey" ~ '^[A-Za-z0-9:_-]{8,100}$' AND "fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "CashCustodyOperation_order_owner_fkey" FOREIGN KEY ("tenantId", "orderId", "companyId")
    REFERENCES "Order"("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CashCustodyOperation_collection_fkey" FOREIGN KEY ("orderId", "collectionId")
    REFERENCES "CashCollection"("orderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CashCustodyOperation_event_fkey" FOREIGN KEY ("collectionId", "eventId")
    REFERENCES "CashCollectionEvent"("cashCollectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CashCustodyOperation_actor_context_fkey" FOREIGN KEY ("companyMembershipId", "actorId", "tenantId", "companyId")
    REFERENCES "CompanyMembership"("id", "userId", "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "CashCustodyOperation_eventId_key" ON "CashCustodyOperation"("eventId");
CREATE UNIQUE INDEX "CashCustodyOperation_tenantId_companyId_operationKey_key" ON "CashCustodyOperation"("tenantId", "companyId", "operationKey");
CREATE UNIQUE INDEX "CashCustodyOperation_event_identity_key" ON "CashCustodyOperation"("collectionId", "eventId");
CREATE INDEX "CashCustodyOperation_tenantId_companyId_orderId_createdAt_idx" ON "CashCustodyOperation"("tenantId", "companyId", "orderId", "createdAt");
