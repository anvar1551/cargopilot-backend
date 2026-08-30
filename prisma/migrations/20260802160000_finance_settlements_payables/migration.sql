CREATE TYPE "FinanceOperationalDocumentStatus" AS ENUM (
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled'
);

CREATE TYPE "FinanceProviderSettlementLineType" AS ENUM (
  'payment',
  'refund',
  'fee',
  'adjustment'
);

CREATE TYPE "FinanceReconciliationStatus" AS ENUM (
  'unmatched',
  'matched',
  'mismatch',
  'ignored'
);

CREATE TABLE "FinanceProviderSettlement" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "settlementNumber" TEXT NOT NULL,
  "providerConfigId" UUID NOT NULL,
  "providerCode" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "externalReference" TEXT,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "grossAmount" DECIMAL(20,4) NOT NULL,
  "refundAmount" DECIMAL(20,4) NOT NULL,
  "feeAmount" DECIMAL(20,4) NOT NULL,
  "adjustmentAmount" DECIMAL(20,4) NOT NULL,
  "netAmount" DECIMAL(20,4) NOT NULL,
  "fxRate" DECIMAL(20,10) NOT NULL,
  "fxRateAsOf" TIMESTAMP(3),
  "status" "FinanceOperationalDocumentStatus" NOT NULL DEFAULT 'draft',
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "accountingSourceEventId" TEXT,
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
  CONSTRAINT "FinanceProviderSettlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceProviderSettlementLine" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "settlementId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "FinanceProviderSettlementLineType" NOT NULL,
  "reconciliationStatus" "FinanceReconciliationStatus" NOT NULL DEFAULT 'unmatched',
  "reconciliationMessage" TEXT,
  "amount" DECIMAL(20,4) NOT NULL,
  "externalTransactionId" TEXT,
  "paymentIntentId" UUID,
  "paymentRefundId" UUID,
  "orderId" UUID,
  "occurredAt" TIMESTAMP(3),
  "description" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceProviderSettlementLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceCarrierBill" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "billNumber" TEXT NOT NULL,
  "carrierProviderId" UUID NOT NULL,
  "carrierCode" TEXT NOT NULL,
  "supplierInvoiceNumber" TEXT NOT NULL,
  "invoiceDate" DATE NOT NULL,
  "dueDate" DATE,
  "currency" VARCHAR(3) NOT NULL,
  "subtotalAmount" DECIMAL(20,4) NOT NULL,
  "taxAmount" DECIMAL(20,4) NOT NULL,
  "totalAmount" DECIMAL(20,4) NOT NULL,
  "fxRate" DECIMAL(20,10) NOT NULL,
  "fxRateAsOf" TIMESTAMP(3),
  "status" "FinanceOperationalDocumentStatus" NOT NULL DEFAULT 'draft',
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "accountingSourceEventId" TEXT,
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
  CONSTRAINT "FinanceCarrierBill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceCarrierBillLine" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "billId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "orderId" UUID NOT NULL,
  "orderLegId" UUID NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" DECIMAL(20,4) NOT NULL DEFAULT 1,
  "unitPrice" DECIMAL(20,4) NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL,
  "taxAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceCarrierBillLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceProviderSettlement_accountingSourceEventId_key" ON "FinanceProviderSettlement"("accountingSourceEventId");
CREATE UNIQUE INDEX "FinanceProviderSettlement_legalEntityId_settlementNumber_key" ON "FinanceProviderSettlement"("legalEntityId", "settlementNumber");
CREATE UNIQUE INDEX "FinanceProviderSettlement_legalEntityId_idempotencyKey_key" ON "FinanceProviderSettlement"("legalEntityId", "idempotencyKey");
CREATE INDEX "FinanceProviderSettlement_legalEntityId_status_periodEnd_idx" ON "FinanceProviderSettlement"("legalEntityId", "status", "periodEnd");
CREATE INDEX "FinanceProviderSettlement_providerConfigId_periodStart_periodEnd_idx" ON "FinanceProviderSettlement"("providerConfigId", "periodStart", "periodEnd");
CREATE UNIQUE INDEX "FinanceProviderSettlementLine_settlementId_sequence_key" ON "FinanceProviderSettlementLine"("settlementId", "sequence");
CREATE INDEX "FinanceProviderSettlementLine_paymentIntentId_idx" ON "FinanceProviderSettlementLine"("paymentIntentId");
CREATE INDEX "FinanceProviderSettlementLine_paymentRefundId_idx" ON "FinanceProviderSettlementLine"("paymentRefundId");
CREATE INDEX "FinanceProviderSettlementLine_orderId_idx" ON "FinanceProviderSettlementLine"("orderId");
CREATE INDEX "FinanceProviderSettlementLine_externalTransactionId_idx" ON "FinanceProviderSettlementLine"("externalTransactionId");
CREATE INDEX "FinanceProviderSettlementLine_settlementId_reconciliationStatus_idx" ON "FinanceProviderSettlementLine"("settlementId", "reconciliationStatus");

CREATE UNIQUE INDEX "FinanceCarrierBill_accountingSourceEventId_key" ON "FinanceCarrierBill"("accountingSourceEventId");
CREATE UNIQUE INDEX "FinanceCarrierBill_legalEntityId_billNumber_key" ON "FinanceCarrierBill"("legalEntityId", "billNumber");
CREATE UNIQUE INDEX "FinanceCarrierBill_legalEntityId_carrierProviderId_supplierInvoiceNumber_key" ON "FinanceCarrierBill"("legalEntityId", "carrierProviderId", "supplierInvoiceNumber");
CREATE UNIQUE INDEX "FinanceCarrierBill_legalEntityId_idempotencyKey_key" ON "FinanceCarrierBill"("legalEntityId", "idempotencyKey");
CREATE INDEX "FinanceCarrierBill_legalEntityId_status_invoiceDate_idx" ON "FinanceCarrierBill"("legalEntityId", "status", "invoiceDate");
CREATE INDEX "FinanceCarrierBill_carrierProviderId_invoiceDate_idx" ON "FinanceCarrierBill"("carrierProviderId", "invoiceDate");
CREATE UNIQUE INDEX "FinanceCarrierBillLine_billId_sequence_key" ON "FinanceCarrierBillLine"("billId", "sequence");
CREATE INDEX "FinanceCarrierBillLine_orderId_idx" ON "FinanceCarrierBillLine"("orderId");
CREATE INDEX "FinanceCarrierBillLine_orderLegId_idx" ON "FinanceCarrierBillLine"("orderLegId");

ALTER TABLE "FinanceProviderSettlement"
  ADD CONSTRAINT "FinanceProviderSettlement_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceProviderSettlementLine"
  ADD CONSTRAINT "FinanceProviderSettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "FinanceProviderSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FinanceCarrierBill"
  ADD CONSTRAINT "FinanceCarrierBill_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceCarrierBillLine"
  ADD CONSTRAINT "FinanceCarrierBillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "FinanceCarrierBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
