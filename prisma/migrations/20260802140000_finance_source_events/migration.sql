-- CreateEnum
CREATE TYPE "FinanceSourceEventStatus" AS ENUM ('pending', 'processing', 'posted', 'exception');

-- CreateTable
CREATE TABLE "FinanceSourceEvent" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "companyId" UUID NOT NULL,
    "legalEntityId" UUID,
    "sourceEventId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "FinanceSourceEventStatus" NOT NULL DEFAULT 'pending',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "postingDate" DATE NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "resolvedRuleId" UUID,
    "financeDocumentId" UUID,
    "financeJournalEntryId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSourceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceSourceEvent_companyId_sourceEventId_key" ON "FinanceSourceEvent"("companyId", "sourceEventId");

-- CreateIndex
CREATE INDEX "FinanceSourceEvent_status_nextAttemptAt_claimedAt_createdAt_idx" ON "FinanceSourceEvent"("status", "nextAttemptAt", "claimedAt", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceSourceEvent_companyId_status_createdAt_idx" ON "FinanceSourceEvent"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceSourceEvent_legalEntityId_sourceType_eventType_occurred_idx" ON "FinanceSourceEvent"("legalEntityId", "sourceType", "eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "FinanceSourceEvent_financeDocumentId_idx" ON "FinanceSourceEvent"("financeDocumentId");

-- AddForeignKey
ALTER TABLE "FinanceSourceEvent" ADD CONSTRAINT "FinanceSourceEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceSourceEvent" ADD CONSTRAINT "FinanceSourceEvent_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceSourceEvent" ADD CONSTRAINT "FinanceSourceEvent_resolvedRuleId_fkey" FOREIGN KEY ("resolvedRuleId") REFERENCES "FinancePostingRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceSourceEvent" ADD CONSTRAINT "FinanceSourceEvent_financeDocumentId_fkey" FOREIGN KEY ("financeDocumentId") REFERENCES "FinanceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceSourceEvent" ADD CONSTRAINT "FinanceSourceEvent_financeJournalEntryId_fkey" FOREIGN KEY ("financeJournalEntryId") REFERENCES "FinanceJournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
