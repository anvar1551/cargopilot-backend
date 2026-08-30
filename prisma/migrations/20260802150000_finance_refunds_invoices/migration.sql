ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'issued';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'credited';

CREATE TYPE "PaymentRefundStatus" AS ENUM (
  'requested',
  'processing',
  'succeeded',
  'failed',
  'cancelled'
);

ALTER TABLE "Invoice"
  ADD COLUMN "companyId" UUID,
  ADD COLUMN "customerEntityId" UUID,
  ADD COLUMN "invoiceNumber" TEXT,
  ADD COLUMN "currency" VARCHAR(3),
  ADD COLUMN "fxRate" DECIMAL(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN "fxRateAsOf" TIMESTAMP(3),
  ADD COLUMN "issuedByUserId" UUID,
  ADD COLUMN "issuedAt" TIMESTAMP(3),
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "metadataJson" JSONB,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Invoice" AS invoice
SET
  "companyId" = orders."ownerOrgId",
  "customerEntityId" = orders."customerEntityId",
  "invoiceNumber" = 'INV-' || orders."orderNumber",
  "currency" = COALESCE(NULLIF(UPPER(TRIM(orders.currency)), ''), 'UZS'),
  "issuedAt" = CASE WHEN invoice.status = 'pending' THEN NULL ELSE invoice."createdAt" END
FROM "Order" AS orders
WHERE orders.id = invoice."orderId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Invoice" WHERE "companyId" IS NULL OR "invoiceNumber" IS NULL OR "currency" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate Invoice rows without order company, number, or currency';
  END IF;
END $$;

ALTER TABLE "Invoice"
  ALTER COLUMN "companyId" SET NOT NULL,
  ALTER COLUMN "invoiceNumber" SET NOT NULL,
  ALTER COLUMN "currency" SET NOT NULL,
  ALTER COLUMN "amount" TYPE DECIMAL(20,4) USING "amount"::numeric(20,4);

CREATE TABLE "PaymentRefund" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "companyId" UUID NOT NULL,
  "paymentIntentId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "environment" "PaymentEnvironment" NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "status" "PaymentRefundStatus" NOT NULL DEFAULT 'requested',
  "providerRefundId" TEXT,
  "reason" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "providerResponseJson" JSONB,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_companyId_invoiceNumber_key" ON "Invoice"("companyId", "invoiceNumber");
CREATE INDEX "Invoice_companyId_status_createdAt_idx" ON "Invoice"("companyId", "status", "createdAt");
CREATE INDEX "Invoice_customerEntityId_createdAt_idx" ON "Invoice"("customerEntityId", "createdAt");

CREATE UNIQUE INDEX "PaymentRefund_companyId_idempotencyKey_key" ON "PaymentRefund"("companyId", "idempotencyKey");
CREATE INDEX "PaymentRefund_paymentIntentId_status_createdAt_idx" ON "PaymentRefund"("paymentIntentId", "status", "createdAt");
CREATE INDEX "PaymentRefund_companyId_status_createdAt_idx" ON "PaymentRefund"("companyId", "status", "createdAt");
CREATE INDEX "PaymentRefund_orderId_createdAt_idx" ON "PaymentRefund"("orderId", "createdAt");

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Invoice_customerEntityId_fkey" FOREIGN KEY ("customerEntityId") REFERENCES "CustomerEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentRefund_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaymentRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
