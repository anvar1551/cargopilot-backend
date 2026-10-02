-- Additive populated ownership equality; no historic inference or source acceptance.
ALTER TABLE "FinanceProviderSettlement" ADD COLUMN "companyId" UUID;
ALTER TABLE "FinanceCarrierBill" ADD COLUMN "companyId" UUID;
CREATE UNIQUE INDEX "FinanceLegalEntity_id_companyId_key" ON "FinanceLegalEntity"("id", "companyId");
CREATE UNIQUE INDEX "PaymentProviderConfig_id_companyId_key" ON "PaymentProviderConfig"("id", "companyId");
CREATE UNIQUE INDEX "IntegrationProvider_id_companyId_key" ON "IntegrationProvider"("id", "companyId");
CREATE INDEX "FinanceProviderSettlement_companyId_legalEntityId_idx" ON "FinanceProviderSettlement"("companyId", "legalEntityId");
CREATE INDEX "FinanceCarrierBill_companyId_legalEntityId_idx" ON "FinanceCarrierBill"("companyId", "legalEntityId");
ALTER TABLE "FinanceProviderSettlement" ADD CONSTRAINT "FinanceProviderSettlement_entity_company_fkey" FOREIGN KEY ("legalEntityId", "companyId") REFERENCES "FinanceLegalEntity"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceProviderSettlement" ADD CONSTRAINT "FinanceProviderSettlement_provider_company_fkey" FOREIGN KEY ("providerConfigId", "companyId") REFERENCES "PaymentProviderConfig"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceCarrierBill" ADD CONSTRAINT "FinanceCarrierBill_entity_company_fkey" FOREIGN KEY ("legalEntityId", "companyId") REFERENCES "FinanceLegalEntity"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceCarrierBill" ADD CONSTRAINT "FinanceCarrierBill_provider_company_fkey" FOREIGN KEY ("carrierProviderId", "companyId") REFERENCES "IntegrationProvider"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceProviderSettlement" ADD CONSTRAINT "FinanceProviderSettlement_company_required_check" CHECK ("companyId" IS NOT NULL) NOT VALID;
ALTER TABLE "FinanceCarrierBill" ADD CONSTRAINT "FinanceCarrierBill_company_required_check" CHECK ("companyId" IS NOT NULL) NOT VALID;
