-- Additive ownership expansion. No historical mapping, mutation or certification.
ALTER TABLE "FinanceJournalLine" ADD COLUMN "tenantId" UUID, ADD COLUMN "companyId" UUID;
CREATE INDEX "JournalLine_dimension_owner_idx" ON "FinanceJournalLine"("tenantId", "companyId", "journalEntryId");
CREATE UNIQUE INDEX "Order_journal_customer_key" ON "Order"("tenantId", id, "customerEntityId");
CREATE UNIQUE INDEX "OrderLeg_journal_provider_key" ON "OrderLeg"(id, "orderId", "carrierProviderId");

ALTER TABLE "FinanceJournalLine"
  ADD CONSTRAINT "JournalLine_dimension_entity_fkey" FOREIGN KEY ("legalEntityId", "tenantId", "companyId") REFERENCES "FinanceLegalEntity"(id, "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_dimension_order_fkey" FOREIGN KEY ("tenantId", "orderId", "companyId") REFERENCES "Order"("tenantId", id, "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_dimension_leg_fkey" FOREIGN KEY ("orderLegId", "orderId") REFERENCES "OrderLeg"(id, "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_dimension_customer_fkey" FOREIGN KEY ("tenantId", "customerEntityId") REFERENCES "CustomerEntity"("tenantId", id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_dimension_warehouse_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "Warehouse"("tenantId", id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_dimension_provider_fkey" FOREIGN KEY ("carrierProviderId", "companyId") REFERENCES "IntegrationProvider"(id, "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_order_customer_fkey" FOREIGN KEY ("tenantId", "orderId", "customerEntityId") REFERENCES "Order"("tenantId", id, "customerEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_leg_provider_fkey" FOREIGN KEY ("orderLegId", "orderId", "carrierProviderId") REFERENCES "OrderLeg"(id, "orderId", "carrierProviderId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "JournalLine_dimension_owner_check" CHECK (
    ("tenantId" IS NULL AND "companyId" IS NULL AND "orderId" IS NULL AND "orderLegId" IS NULL AND "customerEntityId" IS NULL AND "warehouseId" IS NULL AND "carrierProviderId" IS NULL)
    OR ("tenantId" IS NOT NULL AND "companyId" IS NOT NULL AND "legalEntityId" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "JournalLine_dimension_policy_check" CHECK (
    ("orderLegId" IS NULL OR "orderId" IS NOT NULL)
    AND "branchId" IS NULL AND "costCenterCode" IS NULL AND "profitCenterCode" IS NULL
  ) NOT VALID;
-- Optional missing references intentionally skip their own MATCH SIMPLE FK.
-- New/changed populated references still require a complete owned entity bridge.
-- This proves ownership/paired-reference equality, never approval/accounting policy.
