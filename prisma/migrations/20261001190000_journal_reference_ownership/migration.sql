-- Additive expansion only: no historical ownership guesses or posted-row rewrites.
ALTER TABLE "FinanceJournalLine" ADD COLUMN "legalEntityId" UUID;
CREATE UNIQUE INDEX "FinanceDocument_id_legalEntityId_key" ON "FinanceDocument"("id", "legalEntityId");
CREATE UNIQUE INDEX "FinanceJournalEntry_id_legalEntityId_key" ON "FinanceJournalEntry"("id", "legalEntityId");
CREATE UNIQUE INDEX "FinanceJournalEntry_documentId_legalEntityId_key" ON "FinanceJournalEntry"("documentId", "legalEntityId");
CREATE INDEX "FinanceJournalLine_legalEntityId_journalEntryId_idx" ON "FinanceJournalLine"("legalEntityId", "journalEntryId");
-- Retain existing single-column FKs during expansion. All new targets are unique.
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_reversal_entity_fkey" FOREIGN KEY ("reversalOfId", "legalEntityId") REFERENCES "FinanceDocument"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceJournalEntry" ADD CONSTRAINT "FinanceJournalEntry_document_entity_fkey" FOREIGN KEY ("documentId", "legalEntityId") REFERENCES "FinanceDocument"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceJournalEntry" ADD CONSTRAINT "FinanceJournalEntry_reversal_entity_fkey" FOREIGN KEY ("reversalOfId", "legalEntityId") REFERENCES "FinanceJournalEntry"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceJournalLine" ADD CONSTRAINT "FinanceJournalLine_journal_entity_fkey" FOREIGN KEY ("journalEntryId", "legalEntityId") REFERENCES "FinanceJournalEntry"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "FinanceJournalLine" ADD CONSTRAINT "FinanceJournalLine_account_entity_fkey" FOREIGN KEY ("accountId", "legalEntityId") REFERENCES "FinanceAccount"("id", "legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
-- Prisma field stays nullable to represent historical rows. New/updated lines must be bound.
ALTER TABLE "FinanceJournalLine" ADD CONSTRAINT "FinanceJournalLine_entity_required_check" CHECK ("legalEntityId" IS NOT NULL) NOT VALID;
