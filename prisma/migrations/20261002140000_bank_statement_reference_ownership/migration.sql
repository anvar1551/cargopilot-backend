-- Expansion only; no source approval, historical assignment or certification.
ALTER TABLE "FinanceBankStatementLine" ADD COLUMN "legalEntityId" UUID;
CREATE UNIQUE INDEX "FinanceProviderSettlement_id_legalEntityId_key" ON "FinanceProviderSettlement"("id", "legalEntityId");
CREATE UNIQUE INDEX "FinancePaymentRun_id_bankAccountId_legalEntityId_key" ON "FinancePaymentRun"("id", "bankAccountId", "legalEntityId");
CREATE UNIQUE INDEX "FinanceBankStatement_id_bankAccountId_legalEntityId_key" ON "FinanceBankStatement"("id", "bankAccountId", "legalEntityId");
CREATE UNIQUE INDEX "FinanceBankStatementLine_run_bank_entity_key" ON "FinanceBankStatementLine"("paymentRunId", "bankAccountId", "legalEntityId");
CREATE UNIQUE INDEX "FinanceBankStatementLine_settlement_entity_key" ON "FinanceBankStatementLine"("providerSettlementId", "legalEntityId");
CREATE INDEX "FinanceBankStatementLine_legalEntityId_bankStatementId_idx" ON "FinanceBankStatementLine"("legalEntityId", "bankStatementId");
-- Existing simple FKs and deletion restrictions are retained.
ALTER TABLE "FinanceBankStatement" ADD CONSTRAINT "FinanceBankStatement_bank_entity_fkey" FOREIGN KEY ("bankAccountId", "legalEntityId") REFERENCES "FinanceBankAccount"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_parent_bank_entity_fkey" FOREIGN KEY ("bankStatementId", "bankAccountId", "legalEntityId") REFERENCES "FinanceBankStatement"("id", "bankAccountId", "legalEntityId") ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_run_bank_entity_fkey" FOREIGN KEY ("paymentRunId", "bankAccountId", "legalEntityId") REFERENCES "FinancePaymentRun"("id", "bankAccountId", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_settlement_entity_fkey" FOREIGN KEY ("providerSettlementId", "legalEntityId") REFERENCES "FinanceProviderSettlement"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_entity_required_check" CHECK ("legalEntityId" IS NOT NULL) NOT VALID;
