-- Additive expansion; no ownership inference or historical configuration edits.
ALTER TABLE "FinancePostingRuleLine" ADD COLUMN "legalEntityId" UUID;
CREATE UNIQUE INDEX "FinancePostingRule_id_legalEntityId_key" ON "FinancePostingRule"("id", "legalEntityId");
CREATE INDEX "FinancePostingRuleLine_legalEntityId_postingRuleId_idx" ON "FinancePostingRuleLine"("legalEntityId", "postingRuleId");
-- Retain existing single-column FKs; preserve parent deletion cascade.
ALTER TABLE "FinancePostingRuleLine" ADD CONSTRAINT "FinancePostingRuleLine_rule_entity_fkey" FOREIGN KEY ("postingRuleId", "legalEntityId") REFERENCES "FinancePostingRule"("id", "legalEntityId") ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinancePostingRuleLine" ADD CONSTRAINT "FinancePostingRuleLine_account_entity_fkey" FOREIGN KEY ("accountId", "legalEntityId") REFERENCES "FinanceAccount"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
-- Nullable Prisma expansion represents old rows; new/updated rows cannot omit ownership.
ALTER TABLE "FinancePostingRuleLine" ADD CONSTRAINT "FinancePostingRuleLine_entity_required_check" CHECK ("legalEntityId" IS NOT NULL) NOT VALID;
