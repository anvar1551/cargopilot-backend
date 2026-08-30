CREATE TYPE "FinancePaymentRunStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'executed', 'cancelled');
CREATE TYPE "FinancePaymentRunLineStatus" AS ENUM ('pending', 'executed', 'allocated', 'cancelled');
CREATE TYPE "FinanceBankStatementStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected');
CREATE TYPE "FinanceBankStatementLineDirection" AS ENUM ('debit', 'credit');
CREATE TYPE "FinanceBankReconciliationTargetType" AS ENUM ('payment_run', 'provider_settlement');

CREATE TABLE "FinanceBankAccount" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "bankName" TEXT NOT NULL,
  "accountIdentifierHash" TEXT NOT NULL,
  "accountIdentifierMasked" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "idempotencyKey" TEXT NOT NULL,
  "metadataJson" JSONB,
  "createdByUserId" UUID NOT NULL,
  "updatedByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceBankAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePaymentRun" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "runNumber" TEXT NOT NULL,
  "paymentDate" DATE NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "totalAmount" DECIMAL(20,4) NOT NULL,
  "fxRate" DECIMAL(20,10) NOT NULL,
  "fxRateAsOf" TIMESTAMP(3),
  "status" "FinancePaymentRunStatus" NOT NULL DEFAULT 'draft',
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "bankReference" TEXT,
  "metadataJson" JSONB,
  "createdByUserId" UUID NOT NULL,
  "submittedByUserId" UUID,
  "approvedByUserId" UUID,
  "rejectedByUserId" UUID,
  "executedByUserId" UUID,
  "submittedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "executedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePaymentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePaymentRunLine" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "paymentRunId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "payableItemId" UUID NOT NULL,
  "carrierProviderId" UUID NOT NULL,
  "carrierCode" TEXT NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL,
  "status" "FinancePaymentRunLineStatus" NOT NULL DEFAULT 'pending',
  "accountingSourceEventId" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePaymentRunLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePayableAllocation" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "payableItemId" UUID NOT NULL,
  "paymentRunLineId" UUID NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePayableAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceBankStatement" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "statementNumber" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "openingBalance" DECIMAL(20,4) NOT NULL,
  "totalDebits" DECIMAL(20,4) NOT NULL,
  "totalCredits" DECIMAL(20,4) NOT NULL,
  "closingBalance" DECIMAL(20,4) NOT NULL,
  "status" "FinanceBankStatementStatus" NOT NULL DEFAULT 'draft',
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "metadataJson" JSONB,
  "createdByUserId" UUID NOT NULL,
  "submittedByUserId" UUID,
  "approvedByUserId" UUID,
  "rejectedByUserId" UUID,
  "submittedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceBankStatement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceBankStatementLine" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "bankStatementId" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "bookingDate" DATE NOT NULL,
  "valueDate" DATE,
  "direction" "FinanceBankStatementLineDirection" NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "externalTransactionId" TEXT,
  "description" TEXT,
  "reconciliationStatus" "FinanceReconciliationStatus" NOT NULL DEFAULT 'unmatched',
  "reconciliationTarget" "FinanceBankReconciliationTargetType",
  "reconciliationMessage" TEXT,
  "paymentRunId" UUID,
  "providerSettlementId" UUID,
  "reconciledByUserId" UUID,
  "reconciledAt" TIMESTAMP(3),
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceBankStatementLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceBankAccount_legalEntityId_code_key" ON "FinanceBankAccount"("legalEntityId", "code");
CREATE UNIQUE INDEX "FinanceBankAccount_legalEntityId_accountIdentifierHash_key" ON "FinanceBankAccount"("legalEntityId", "accountIdentifierHash");
CREATE UNIQUE INDEX "FinanceBankAccount_legalEntityId_idempotencyKey_key" ON "FinanceBankAccount"("legalEntityId", "idempotencyKey");
CREATE INDEX "FinanceBankAccount_legalEntityId_isActive_currency_idx" ON "FinanceBankAccount"("legalEntityId", "isActive", "currency");
CREATE UNIQUE INDEX "FinancePaymentRun_legalEntityId_runNumber_key" ON "FinancePaymentRun"("legalEntityId", "runNumber");
CREATE UNIQUE INDEX "FinancePaymentRun_legalEntityId_idempotencyKey_key" ON "FinancePaymentRun"("legalEntityId", "idempotencyKey");
CREATE UNIQUE INDEX "FinancePaymentRun_legalEntityId_bankReference_key" ON "FinancePaymentRun"("legalEntityId", "bankReference");
CREATE INDEX "FinancePaymentRun_legalEntityId_status_paymentDate_id_idx" ON "FinancePaymentRun"("legalEntityId", "status", "paymentDate", "id");
CREATE INDEX "FinancePaymentRun_bankAccountId_paymentDate_idx" ON "FinancePaymentRun"("bankAccountId", "paymentDate");
CREATE UNIQUE INDEX "FinancePaymentRunLine_accountingSourceEventId_key" ON "FinancePaymentRunLine"("accountingSourceEventId");
CREATE UNIQUE INDEX "FinancePaymentRunLine_paymentRunId_sequence_key" ON "FinancePaymentRunLine"("paymentRunId", "sequence");
CREATE UNIQUE INDEX "FinancePaymentRunLine_paymentRunId_payableItemId_key" ON "FinancePaymentRunLine"("paymentRunId", "payableItemId");
CREATE INDEX "FinancePaymentRunLine_payableItemId_status_idx" ON "FinancePaymentRunLine"("payableItemId", "status");
CREATE INDEX "FinancePaymentRunLine_carrierProviderId_idx" ON "FinancePaymentRunLine"("carrierProviderId");
CREATE UNIQUE INDEX "FinancePayableAllocation_paymentRunLineId_key" ON "FinancePayableAllocation"("paymentRunLineId");
CREATE UNIQUE INDEX "FinancePayableAllocation_payableItemId_sourceEventId_key" ON "FinancePayableAllocation"("payableItemId", "sourceEventId");
CREATE INDEX "FinancePayableAllocation_payableItemId_occurredAt_idx" ON "FinancePayableAllocation"("payableItemId", "occurredAt");
CREATE INDEX "FinancePayableAllocation_sourceEventId_idx" ON "FinancePayableAllocation"("sourceEventId");
CREATE UNIQUE INDEX "FinanceBankStatement_legalEntityId_statementNumber_key" ON "FinanceBankStatement"("legalEntityId", "statementNumber");
CREATE UNIQUE INDEX "FinanceBankStatement_legalEntityId_idempotencyKey_key" ON "FinanceBankStatement"("legalEntityId", "idempotencyKey");
CREATE INDEX "FinanceBankStatement_legalEntityId_status_periodEnd_id_idx" ON "FinanceBankStatement"("legalEntityId", "status", "periodEnd", "id");
CREATE INDEX "FinanceBankStatement_bankAccountId_periodStart_periodEnd_idx" ON "FinanceBankStatement"("bankAccountId", "periodStart", "periodEnd");
CREATE UNIQUE INDEX "FinanceBankStatementLine_paymentRunId_key" ON "FinanceBankStatementLine"("paymentRunId");
CREATE UNIQUE INDEX "FinanceBankStatementLine_providerSettlementId_key" ON "FinanceBankStatementLine"("providerSettlementId");
CREATE UNIQUE INDEX "FinanceBankStatementLine_bankStatementId_sequence_key" ON "FinanceBankStatementLine"("bankStatementId", "sequence");
CREATE UNIQUE INDEX "FinanceBankStatementLine_bankAccountId_externalTransactionId_key" ON "FinanceBankStatementLine"("bankAccountId", "externalTransactionId");
CREATE INDEX "FinanceBankStatementLine_bankStatementId_reconciliationStatus_bookingDate_idx" ON "FinanceBankStatementLine"("bankStatementId", "reconciliationStatus", "bookingDate");
CREATE INDEX "FinanceBankStatementLine_externalTransactionId_idx" ON "FinanceBankStatementLine"("externalTransactionId");

ALTER TABLE "FinanceBankAccount" ADD CONSTRAINT "FinanceBankAccount_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePaymentRun" ADD CONSTRAINT "FinancePaymentRun_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePaymentRun" ADD CONSTRAINT "FinancePaymentRun_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "FinanceBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePaymentRunLine" ADD CONSTRAINT "FinancePaymentRunLine_paymentRunId_fkey" FOREIGN KEY ("paymentRunId") REFERENCES "FinancePaymentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FinancePaymentRunLine" ADD CONSTRAINT "FinancePaymentRunLine_payableItemId_fkey" FOREIGN KEY ("payableItemId") REFERENCES "FinancePayableItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePayableAllocation" ADD CONSTRAINT "FinancePayableAllocation_payableItemId_fkey" FOREIGN KEY ("payableItemId") REFERENCES "FinancePayableItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePayableAllocation" ADD CONSTRAINT "FinancePayableAllocation_paymentRunLineId_fkey" FOREIGN KEY ("paymentRunLineId") REFERENCES "FinancePaymentRunLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceBankStatement" ADD CONSTRAINT "FinanceBankStatement_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceBankStatement" ADD CONSTRAINT "FinanceBankStatement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "FinanceBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_bankStatementId_fkey" FOREIGN KEY ("bankStatementId") REFERENCES "FinanceBankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "FinanceBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_paymentRunId_fkey" FOREIGN KEY ("paymentRunId") REFERENCES "FinancePaymentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceBankStatementLine" ADD CONSTRAINT "FinanceBankStatementLine_providerSettlementId_fkey" FOREIGN KEY ("providerSettlementId") REFERENCES "FinanceProviderSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
