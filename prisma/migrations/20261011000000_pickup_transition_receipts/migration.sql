-- New accepted pickup facts only; no historical inference/backfill.
CREATE TABLE "OrderPickupReceipt" (
 "tenantId" uuid NOT NULL, "operationId" uuid NOT NULL, "companyId" uuid NOT NULL,
 "userId" uuid NOT NULL, "companyMembershipId" uuid NOT NULL, "tenantMembershipId" uuid NOT NULL,
 "orderId" uuid NOT NULL, "trackingId" uuid NOT NULL, "intentHash" char(64) NOT NULL,
 "intent" jsonb NOT NULL, "result" jsonb NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("tenantId", "operationId"),
 FOREIGN KEY ("tenantId", "orderId", "companyId") REFERENCES "Order" ("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY ("companyMembershipId", "userId", "tenantId", "companyId") REFERENCES "CompanyMembership" ("id", "userId", "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY ("companyMembershipId", "tenantMembershipId", "userId", "tenantId") REFERENCES "CompanyMembership" ("id", "tenantMembershipId", "userId", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY ("trackingId", "orderId") REFERENCES "Tracking" ("id", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK ("intent"->>'status' IN ('pickup_in_progress','picked_up'))
);
CREATE UNIQUE INDEX "OrderPickupReceipt_trackingId_key" ON "OrderPickupReceipt" ("trackingId");
CREATE INDEX "OrderPickupReceipt_tenantId_companyId_orderId_createdAt_idx" ON "OrderPickupReceipt" ("tenantId", "companyId", "orderId", "createdAt");
CREATE FUNCTION cp_pickup_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Pickup receipts are append-only'; END $$;
CREATE TRIGGER "PickupReceipt_no_change" BEFORE UPDATE OR DELETE ON "OrderPickupReceipt" FOR EACH ROW EXECUTE FUNCTION cp_pickup_receipt_immutable();
CREATE TRIGGER "PickupReceipt_no_truncate" BEFORE TRUNCATE ON "OrderPickupReceipt" FOR EACH STATEMENT EXECUTE FUNCTION cp_pickup_receipt_immutable();
