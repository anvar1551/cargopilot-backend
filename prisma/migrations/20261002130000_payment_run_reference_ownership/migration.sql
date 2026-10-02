-- Additive reference equality; no historical mapping or acceptance restoration.
ALTER TABLE "FinancePaymentRunLine" ADD COLUMN "legalEntityId" UUID;
ALTER TABLE "FinancePayableAllocation" ADD COLUMN "legalEntityId" UUID;
CREATE UNIQUE INDEX "FinanceBankAccount_id_legalEntityId_key" ON "FinanceBankAccount"("id", "legalEntityId");
CREATE UNIQUE INDEX "FinancePaymentRun_id_legalEntityId_key" ON "FinancePaymentRun"("id", "legalEntityId");
CREATE UNIQUE INDEX "FinancePayableItem_id_legalEntityId_key" ON "FinancePayableItem"("id", "legalEntityId");
CREATE UNIQUE INDEX "FinancePaymentRunLine_id_payableItemId_legalEntityId_key" ON "FinancePaymentRunLine"("id", "payableItemId", "legalEntityId");
CREATE INDEX "FinancePaymentRunLine_legalEntityId_paymentRunId_idx" ON "FinancePaymentRunLine"("legalEntityId", "paymentRunId");
CREATE INDEX "FinancePayableAllocation_legalEntityId_paymentRunLineId_idx" ON "FinancePayableAllocation"("legalEntityId", "paymentRunLineId");
-- Preserve existing simple FKs and parent deletion behavior during expansion.
ALTER TABLE "FinancePaymentRun" ADD CONSTRAINT "FinancePaymentRun_bank_entity_fkey" FOREIGN KEY ("bankAccountId", "legalEntityId") REFERENCES "FinanceBankAccount"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinancePaymentRunLine" ADD CONSTRAINT "FinancePaymentRunLine_run_entity_fkey" FOREIGN KEY ("paymentRunId", "legalEntityId") REFERENCES "FinancePaymentRun"("id", "legalEntityId") ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinancePaymentRunLine" ADD CONSTRAINT "FinancePaymentRunLine_payable_entity_fkey" FOREIGN KEY ("payableItemId", "legalEntityId") REFERENCES "FinancePayableItem"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinancePayableAllocation" ADD CONSTRAINT "FinancePayableAllocation_payable_entity_fkey" FOREIGN KEY ("payableItemId", "legalEntityId") REFERENCES "FinancePayableItem"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinancePayableAllocation" ADD CONSTRAINT "FinancePayableAllocation_line_payable_entity_fkey" FOREIGN KEY ("paymentRunLineId", "payableItemId", "legalEntityId") REFERENCES "FinancePaymentRunLine"("id", "payableItemId", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinancePaymentRunLine" ADD CONSTRAINT "FinancePaymentRunLine_entity_required_check" CHECK ("legalEntityId" IS NOT NULL) NOT VALID;
ALTER TABLE "FinancePayableAllocation" ADD CONSTRAINT "FinancePayableAllocation_entity_required_check" CHECK ("legalEntityId" IS NOT NULL) NOT VALID;
CREATE UNIQUE INDEX "FinancePayableAllocation_line_payable_entity_key" ON "FinancePayableAllocation"("paymentRunLineId", "payableItemId", "legalEntityId");
