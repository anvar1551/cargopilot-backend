-- Additive expansion. No inferred ownership, historic certification or data rewrite.
ALTER TABLE "FinanceReceivableAllocation" ADD COLUMN "legalEntityId" UUID;
ALTER TABLE "FinanceUnappliedCashApplication" ADD COLUMN "legalEntityId" UUID;
CREATE UNIQUE INDEX "FinanceReceivableItem_id_entity_key" ON "FinanceReceivableItem" ("id", "legalEntityId");
CREATE UNIQUE INDEX "FinanceUnappliedCash_id_entity_key" ON "FinanceUnappliedCash" ("id", "legalEntityId");
CREATE INDEX "FinanceReceivableAllocation_entity_parent_idx" ON "FinanceReceivableAllocation" ("legalEntityId", "receivableId");
CREATE INDEX "FinanceUnappliedCashApplication_entity_parent_idx" ON "FinanceUnappliedCashApplication" ("legalEntityId", "unappliedCashId");
-- Existing simple parent FKs remain. NOT VALID protects new/changed references.
ALTER TABLE "FinanceReceivableAllocation" ADD CONSTRAINT "FinanceReceivableAllocation_parent_entity_fkey" FOREIGN KEY ("receivableId", "legalEntityId") REFERENCES "FinanceReceivableItem" ("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceUnappliedCashApplication" ADD CONSTRAINT "FinanceUnappliedCashApplication_parent_entity_fkey" FOREIGN KEY ("unappliedCashId", "legalEntityId") REFERENCES "FinanceUnappliedCash" ("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceUnappliedCashApplication" ADD CONSTRAINT "FinanceUnappliedCashApplication_receivable_entity_fkey" FOREIGN KEY ("receivableId", "legalEntityId") REFERENCES "FinanceReceivableItem" ("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceReceivableAllocation" ADD CONSTRAINT "FinanceReceivableAllocation_entity_required_check" CHECK ("legalEntityId" IS NOT NULL) NOT VALID;
ALTER TABLE "FinanceUnappliedCashApplication" ADD CONSTRAINT "FinanceUnappliedCashApplication_entity_required_check" CHECK ("legalEntityId" IS NOT NULL) NOT VALID;
