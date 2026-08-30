-- CreateEnum
CREATE TYPE "FinanceAccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

-- CreateEnum
CREATE TYPE "FinanceAccountStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "FinanceFiscalPeriodStatus" AS ENUM ('open', 'restricted', 'closed');

-- CreateEnum
CREATE TYPE "FinanceDocumentType" AS ENUM ('manual_journal', 'customer_invoice', 'credit_note', 'carrier_bill', 'carrier_cost_accrual', 'payment', 'cash_movement', 'adjustment', 'fx_revaluation', 'opening_balance');

-- CreateEnum
CREATE TYPE "FinanceDocumentStatus" AS ENUM ('draft', 'submitted', 'approved', 'posted', 'reversed', 'cancelled');

-- CreateEnum
CREATE TYPE "FinanceJournalStatus" AS ENUM ('draft', 'posted', 'reversed');

-- CreateEnum
CREATE TYPE "FinanceEntrySide" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "FinancePostingRuleStatus" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "FinanceLegalEntity" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "companyId" UUID NOT NULL,
    "baseCurrency" VARCHAR(3) NOT NULL,
    "reportingCurrency" VARCHAR(3),
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceLegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAccount" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinanceAccountType" NOT NULL,
    "status" "FinanceAccountStatus" NOT NULL DEFAULT 'active',
    "parentId" UUID,
    "allowPosting" BOOLEAN NOT NULL DEFAULT true,
    "isControlAccount" BOOLEAN NOT NULL DEFAULT false,
    "currency" VARCHAR(3),
    "description" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceFiscalPeriod" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FinanceFiscalPeriodStatus" NOT NULL DEFAULT 'open',
    "closedAt" TIMESTAMP(3),
    "closedByUserId" UUID,
    "reopenedAt" TIMESTAMP(3),
    "reopenedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceFiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancePostingRule" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "FinancePostingRuleStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditionsJson" JSONB,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancePostingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancePostingRuleLine" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "postingRuleId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "side" "FinanceEntrySide" NOT NULL,
    "accountId" UUID NOT NULL,
    "amountExpression" TEXT NOT NULL DEFAULT 'amount',
    "descriptionTemplate" TEXT,
    "dimensionsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancePostingRuleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceDocument" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "type" "FinanceDocumentType" NOT NULL,
    "status" "FinanceDocumentStatus" NOT NULL DEFAULT 'draft',
    "documentDate" DATE NOT NULL,
    "postingDate" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "totalAmount" DECIMAL(20,4) NOT NULL,
    "baseAmount" DECIMAL(20,4) NOT NULL,
    "fxRate" DECIMAL(20,10) NOT NULL,
    "fxRateAsOf" TIMESTAMP(3),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceEventId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT,
    "metadataJson" JSONB,
    "createdByUserId" UUID NOT NULL,
    "submittedByUserId" UUID,
    "approvedByUserId" UUID,
    "postedByUserId" UUID,
    "reversedByUserId" UUID,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reversalOfId" UUID,

    CONSTRAINT "FinanceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceJournalEntry" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "journalNumber" TEXT NOT NULL,
    "status" "FinanceJournalStatus" NOT NULL DEFAULT 'draft',
    "postingDate" DATE NOT NULL,
    "description" TEXT,
    "totalDebitBase" DECIMAL(20,4) NOT NULL,
    "totalCreditBase" DECIMAL(20,4) NOT NULL,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" UUID,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reversalOfId" UUID,

    CONSTRAINT "FinanceJournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceJournalLine" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "journalEntryId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "accountId" UUID NOT NULL,
    "debitAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "creditAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "fxRate" DECIMAL(20,10) NOT NULL,
    "debitBase" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "creditBase" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "description" TEXT,
    "orderId" UUID,
    "orderLegId" UUID,
    "customerEntityId" UUID,
    "branchId" UUID,
    "warehouseId" UUID,
    "carrierProviderId" UUID,
    "costCenterCode" TEXT,
    "profitCenterCode" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceJournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAuditEvent" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "documentId" UUID,
    "journalEntryId" UUID,
    "action" TEXT NOT NULL,
    "actorUserId" UUID,
    "detailsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceDomainEventOutbox" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "eventId" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceDomainEventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceNumberSequence" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "nextValue" BIGINT NOT NULL DEFAULT 1,
    "prefix" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 8,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceNumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceLegalEntity_companyId_key" ON "FinanceLegalEntity"("companyId");

-- CreateIndex
CREATE INDEX "FinanceLegalEntity_isActive_idx" ON "FinanceLegalEntity"("isActive");

-- CreateIndex
CREATE INDEX "FinanceAccount_legalEntityId_type_status_idx" ON "FinanceAccount"("legalEntityId", "type", "status");

-- CreateIndex
CREATE INDEX "FinanceAccount_parentId_idx" ON "FinanceAccount"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceAccount_legalEntityId_code_key" ON "FinanceAccount"("legalEntityId", "code");

-- CreateIndex
CREATE INDEX "FinanceFiscalPeriod_legalEntityId_startDate_endDate_idx" ON "FinanceFiscalPeriod"("legalEntityId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "FinanceFiscalPeriod_legalEntityId_status_idx" ON "FinanceFiscalPeriod"("legalEntityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceFiscalPeriod_legalEntityId_fiscalYear_periodNumber_key" ON "FinanceFiscalPeriod"("legalEntityId", "fiscalYear", "periodNumber");

-- CreateIndex
CREATE INDEX "FinancePostingRule_legalEntityId_sourceType_eventType_statu_idx" ON "FinancePostingRule"("legalEntityId", "sourceType", "eventType", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "FinancePostingRule_legalEntityId_code_version_key" ON "FinancePostingRule"("legalEntityId", "code", "version");

-- CreateIndex
CREATE INDEX "FinancePostingRuleLine_accountId_idx" ON "FinancePostingRuleLine"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancePostingRuleLine_postingRuleId_lineNumber_key" ON "FinancePostingRuleLine"("postingRuleId", "lineNumber");

-- CreateIndex
CREATE INDEX "FinanceDocument_legalEntityId_status_postingDate_idx" ON "FinanceDocument"("legalEntityId", "status", "postingDate");

-- CreateIndex
CREATE INDEX "FinanceDocument_legalEntityId_sourceType_sourceId_idx" ON "FinanceDocument"("legalEntityId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "FinanceDocument_sourceEventId_idx" ON "FinanceDocument"("sourceEventId");

-- CreateIndex
CREATE INDEX "FinanceDocument_reversalOfId_idx" ON "FinanceDocument"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceDocument_legalEntityId_documentNumber_key" ON "FinanceDocument"("legalEntityId", "documentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceDocument_legalEntityId_idempotencyKey_key" ON "FinanceDocument"("legalEntityId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceJournalEntry_documentId_key" ON "FinanceJournalEntry"("documentId");

-- CreateIndex
CREATE INDEX "FinanceJournalEntry_legalEntityId_status_postingDate_idx" ON "FinanceJournalEntry"("legalEntityId", "status", "postingDate");

-- CreateIndex
CREATE INDEX "FinanceJournalEntry_reversalOfId_idx" ON "FinanceJournalEntry"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceJournalEntry_legalEntityId_journalNumber_key" ON "FinanceJournalEntry"("legalEntityId", "journalNumber");

-- CreateIndex
CREATE INDEX "FinanceJournalLine_accountId_journalEntryId_idx" ON "FinanceJournalLine"("accountId", "journalEntryId");

-- CreateIndex
CREATE INDEX "FinanceJournalLine_orderId_idx" ON "FinanceJournalLine"("orderId");

-- CreateIndex
CREATE INDEX "FinanceJournalLine_customerEntityId_idx" ON "FinanceJournalLine"("customerEntityId");

-- CreateIndex
CREATE INDEX "FinanceJournalLine_warehouseId_idx" ON "FinanceJournalLine"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceJournalLine_journalEntryId_lineNumber_key" ON "FinanceJournalLine"("journalEntryId", "lineNumber");

-- CreateIndex
CREATE INDEX "FinanceAuditEvent_legalEntityId_createdAt_idx" ON "FinanceAuditEvent"("legalEntityId", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceAuditEvent_documentId_createdAt_idx" ON "FinanceAuditEvent"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceAuditEvent_journalEntryId_createdAt_idx" ON "FinanceAuditEvent"("journalEntryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceDomainEventOutbox_eventId_key" ON "FinanceDomainEventOutbox"("eventId");

-- CreateIndex
CREATE INDEX "FinanceDomainEventOutbox_publishedAt_nextAttemptAt_claimedA_idx" ON "FinanceDomainEventOutbox"("publishedAt", "nextAttemptAt", "claimedAt", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceDomainEventOutbox_legalEntityId_eventType_createdAt_idx" ON "FinanceDomainEventOutbox"("legalEntityId", "eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceNumberSequence_legalEntityId_key_key" ON "FinanceNumberSequence"("legalEntityId", "key");

-- AddForeignKey
ALTER TABLE "FinanceLegalEntity" ADD CONSTRAINT "FinanceLegalEntity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAccount" ADD CONSTRAINT "FinanceAccount_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAccount" ADD CONSTRAINT "FinanceAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceFiscalPeriod" ADD CONSTRAINT "FinanceFiscalPeriod_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancePostingRule" ADD CONSTRAINT "FinancePostingRule_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancePostingRuleLine" ADD CONSTRAINT "FinancePostingRuleLine_postingRuleId_fkey" FOREIGN KEY ("postingRuleId") REFERENCES "FinancePostingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancePostingRuleLine" ADD CONSTRAINT "FinancePostingRuleLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceDocument" ADD CONSTRAINT "FinanceDocument_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "FinanceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceJournalEntry" ADD CONSTRAINT "FinanceJournalEntry_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceJournalEntry" ADD CONSTRAINT "FinanceJournalEntry_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "FinanceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceJournalEntry" ADD CONSTRAINT "FinanceJournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "FinanceJournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceJournalLine" ADD CONSTRAINT "FinanceJournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "FinanceJournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceJournalLine" ADD CONSTRAINT "FinanceJournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinanceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAuditEvent" ADD CONSTRAINT "FinanceAuditEvent_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAuditEvent" ADD CONSTRAINT "FinanceAuditEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "FinanceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAuditEvent" ADD CONSTRAINT "FinanceAuditEvent_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "FinanceJournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceDomainEventOutbox" ADD CONSTRAINT "FinanceDomainEventOutbox_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceNumberSequence" ADD CONSTRAINT "FinanceNumberSequence_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

