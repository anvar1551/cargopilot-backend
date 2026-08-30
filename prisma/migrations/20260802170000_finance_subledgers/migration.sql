CREATE TYPE "FinanceOpenItemStatus" AS ENUM ('open', 'partial', 'settled');
CREATE TYPE "FinanceReceivableAllocationType" AS ENUM ('payment', 'unapplied_receipt', 'refund');
CREATE TYPE "FinanceUnappliedCashType" AS ENUM ('receipt', 'refund');
CREATE TYPE "FinanceUnappliedCashStatus" AS ENUM ('open', 'applied');
CREATE TYPE "FinanceUnappliedCashApplicationType" AS ENUM ('receivable', 'refund');

CREATE TABLE "FinanceReceivableItem" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "sourceInvoiceId" UUID NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "orderId" UUID NOT NULL,
  "customerEntityId" UUID,
  "documentDate" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "originalAmount" DECIMAL(20,4) NOT NULL,
  "outstandingAmount" DECIMAL(20,4) NOT NULL,
  "status" "FinanceOpenItemStatus" NOT NULL DEFAULT 'open',
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceReceivableItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceReceivableAllocation" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "receivableId" UUID NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "type" "FinanceReceivableAllocationType" NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "paymentIntentId" UUID,
  "paymentRefundId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceReceivableAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceUnappliedCash" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "type" "FinanceUnappliedCashType" NOT NULL,
  "orderId" UUID NOT NULL,
  "customerEntityId" UUID,
  "currency" VARCHAR(3) NOT NULL,
  "originalAmount" DECIMAL(20,4) NOT NULL,
  "remainingAmount" DECIMAL(20,4) NOT NULL,
  "status" "FinanceUnappliedCashStatus" NOT NULL DEFAULT 'open',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceUnappliedCash_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinancePayableItem" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "legalEntityId" UUID NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "sourceCarrierBillId" UUID NOT NULL,
  "billNumber" TEXT NOT NULL,
  "supplierInvoiceNumber" TEXT NOT NULL,
  "carrierProviderId" UUID NOT NULL,
  "carrierCode" TEXT NOT NULL,
  "documentDate" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "originalAmount" DECIMAL(20,4) NOT NULL,
  "outstandingAmount" DECIMAL(20,4) NOT NULL,
  "status" "FinanceOpenItemStatus" NOT NULL DEFAULT 'open',
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePayableItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FinanceUnappliedCashApplication" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "unappliedCashId" UUID NOT NULL,
  "receivableId" UUID,
  "idempotencyKey" TEXT NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "type" "FinanceUnappliedCashApplicationType" NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceUnappliedCashApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceReceivableItem_legalEntityId_sourceEventId_key" ON "FinanceReceivableItem"("legalEntityId", "sourceEventId");
CREATE UNIQUE INDEX "FinanceReceivableItem_legalEntityId_sourceInvoiceId_key" ON "FinanceReceivableItem"("legalEntityId", "sourceInvoiceId");
CREATE INDEX "FinanceReceivableItem_legalEntityId_status_dueDate_id_idx" ON "FinanceReceivableItem"("legalEntityId", "status", "dueDate", "id");
CREATE INDEX "FinanceReceivableItem_legalEntityId_customerEntityId_status_dueDate_idx" ON "FinanceReceivableItem"("legalEntityId", "customerEntityId", "status", "dueDate");
CREATE INDEX "FinanceReceivableItem_legalEntityId_orderId_currency_status_idx" ON "FinanceReceivableItem"("legalEntityId", "orderId", "currency", "status");

CREATE UNIQUE INDEX "FinanceReceivableAllocation_receivableId_sourceEventId_key" ON "FinanceReceivableAllocation"("receivableId", "sourceEventId");
CREATE INDEX "FinanceReceivableAllocation_sourceEventId_idx" ON "FinanceReceivableAllocation"("sourceEventId");
CREATE INDEX "FinanceReceivableAllocation_paymentIntentId_idx" ON "FinanceReceivableAllocation"("paymentIntentId");
CREATE INDEX "FinanceReceivableAllocation_paymentRefundId_idx" ON "FinanceReceivableAllocation"("paymentRefundId");
CREATE INDEX "FinanceReceivableAllocation_receivableId_occurredAt_idx" ON "FinanceReceivableAllocation"("receivableId", "occurredAt");

CREATE UNIQUE INDEX "FinanceUnappliedCash_legalEntityId_sourceEventId_type_key" ON "FinanceUnappliedCash"("legalEntityId", "sourceEventId", "type");
CREATE INDEX "FinanceUnappliedCash_legalEntityId_status_occurredAt_id_idx" ON "FinanceUnappliedCash"("legalEntityId", "status", "occurredAt", "id");
CREATE INDEX "FinanceUnappliedCash_legalEntityId_orderId_currency_type_status_idx" ON "FinanceUnappliedCash"("legalEntityId", "orderId", "currency", "type", "status");
CREATE INDEX "FinanceUnappliedCash_legalEntityId_customerEntityId_status_idx" ON "FinanceUnappliedCash"("legalEntityId", "customerEntityId", "status");

CREATE UNIQUE INDEX "FinancePayableItem_legalEntityId_sourceEventId_key" ON "FinancePayableItem"("legalEntityId", "sourceEventId");
CREATE UNIQUE INDEX "FinancePayableItem_legalEntityId_sourceCarrierBillId_key" ON "FinancePayableItem"("legalEntityId", "sourceCarrierBillId");
CREATE INDEX "FinancePayableItem_legalEntityId_status_dueDate_id_idx" ON "FinancePayableItem"("legalEntityId", "status", "dueDate", "id");
CREATE INDEX "FinancePayableItem_legalEntityId_carrierProviderId_status_dueDate_idx" ON "FinancePayableItem"("legalEntityId", "carrierProviderId", "status", "dueDate");

CREATE UNIQUE INDEX "FinanceUnappliedCashApplication_idempotencyKey_key" ON "FinanceUnappliedCashApplication"("idempotencyKey");
CREATE INDEX "FinanceUnappliedCashApplication_unappliedCashId_occurredAt_idx" ON "FinanceUnappliedCashApplication"("unappliedCashId", "occurredAt");
CREATE INDEX "FinanceUnappliedCashApplication_receivableId_idx" ON "FinanceUnappliedCashApplication"("receivableId");
CREATE INDEX "FinanceUnappliedCashApplication_sourceEventId_idx" ON "FinanceUnappliedCashApplication"("sourceEventId");

ALTER TABLE "FinanceReceivableItem" ADD CONSTRAINT "FinanceReceivableItem_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceReceivableAllocation" ADD CONSTRAINT "FinanceReceivableAllocation_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "FinanceReceivableItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceUnappliedCash" ADD CONSTRAINT "FinanceUnappliedCash_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancePayableItem" ADD CONSTRAINT "FinancePayableItem_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceUnappliedCashApplication" ADD CONSTRAINT "FinanceUnappliedCashApplication_unappliedCashId_fkey" FOREIGN KEY ("unappliedCashId") REFERENCES "FinanceUnappliedCash"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceUnappliedCashApplication" ADD CONSTRAINT "FinanceUnappliedCashApplication_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "FinanceReceivableItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
