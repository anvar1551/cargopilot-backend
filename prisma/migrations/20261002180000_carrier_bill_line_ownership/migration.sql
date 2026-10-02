-- Additive ownership expansion, no mapping or historical record changes.
ALTER TABLE "FinanceCarrierBillLine" ADD COLUMN "legalEntityId" UUID, ADD COLUMN "tenantId" UUID, ADD COLUMN "companyId" UUID;
CREATE UNIQUE INDEX "FinanceCarrierBill_line_owner_key" ON "FinanceCarrierBill" ("id", "legalEntityId", "companyId");
CREATE UNIQUE INDEX "OrderLeg_id_order_key" ON "OrderLeg" ("id", "orderId");
CREATE INDEX "FinanceCarrierBillLine_tenant_company_bill_idx" ON "FinanceCarrierBillLine" ("tenantId", "companyId", "billId");
ALTER TABLE "FinanceCarrierBillLine" ADD CONSTRAINT "FinanceCarrierBillLine_header_owner_fkey" FOREIGN KEY ("billId", "legalEntityId", "companyId") REFERENCES "FinanceCarrierBill" ("id", "legalEntityId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceCarrierBillLine" ADD CONSTRAINT "FinanceCarrierBillLine_entity_owner_fkey" FOREIGN KEY ("legalEntityId", "tenantId", "companyId") REFERENCES "FinanceLegalEntity" ("id", "tenantId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceCarrierBillLine" ADD CONSTRAINT "FinanceCarrierBillLine_order_owner_fkey" FOREIGN KEY ("tenantId", "orderId", "companyId") REFERENCES "Order" ("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceCarrierBillLine" ADD CONSTRAINT "FinanceCarrierBillLine_leg_order_fkey" FOREIGN KEY ("orderLegId", "orderId") REFERENCES "OrderLeg" ("id", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceCarrierBillLine" ADD CONSTRAINT "FinanceCarrierBillLine_owner_required_check" CHECK ("legalEntityId" IS NOT NULL AND "tenantId" IS NOT NULL AND "companyId" IS NOT NULL) NOT VALID;
