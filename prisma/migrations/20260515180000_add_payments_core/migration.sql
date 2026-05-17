-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('CLICK', 'PAYME', 'UZUM', 'STRIPE');

-- CreateEnum
CREATE TYPE "PaymentEnvironment" AS ENUM ('TEST', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'SENT', 'ACCEPTED', 'REJECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "PaymentWebhookProcessStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED_DUPLICATE', 'FAILED');

-- AlterEnum
ALTER TYPE "ScopeResource" ADD VALUE IF NOT EXISTS 'payments';

-- CreateTable
CREATE TABLE "PaymentProviderConfig" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "environment" "PaymentEnvironment" NOT NULL DEFAULT 'TEST',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "merchantId" TEXT,
    "serviceId" TEXT,
    "accountId" TEXT,
    "secretEncrypted" TEXT NOT NULL,
    "secretMasked" TEXT NOT NULL,
    "callbackPath" TEXT NOT NULL,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerConfigId" UUID NOT NULL,
    "environment" "PaymentEnvironment" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "providerPaymentId" TEXT,
    "providerInvoiceId" TEXT,
    "providerCheckoutUrl" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "requestJson" JSONB,
    "responseJson" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "provider" "PaymentProvider" NOT NULL,
    "environment" "PaymentEnvironment" NOT NULL,
    "externalEventId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "processStatus" "PaymentWebhookProcessStatus" NOT NULL DEFAULT 'RECEIVED',
    "headersJson" JSONB,
    "payloadJson" JSONB NOT NULL,
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "paymentIntentId" UUID,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLedgerEntry" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "entryType" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "reference" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uniq_provider_per_company_env" ON "PaymentProviderConfig"("companyId", "provider", "environment");

-- CreateIndex
CREATE INDEX "PaymentProviderConfig_companyId_isEnabled_idx" ON "PaymentProviderConfig"("companyId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_intent_idempotency_per_company" ON "PaymentIntent"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentIntent_companyId_orderId_idx" ON "PaymentIntent"("companyId", "orderId");

-- CreateIndex
CREATE INDEX "PaymentIntent_companyId_status_idx" ON "PaymentIntent"("companyId", "status");

-- CreateIndex
CREATE INDEX "PaymentAttempt_paymentIntentId_createdAt_idx" ON "PaymentAttempt"("paymentIntentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_webhook_provider_env_idempotency" ON "PaymentWebhookEvent"("provider", "environment", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_provider_receivedAt_idx" ON "PaymentWebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_companyId_processStatus_idx" ON "PaymentWebhookEvent"("companyId", "processStatus");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_companyId_orderId_idx" ON "PaymentLedgerEntry"("companyId", "orderId");

-- CreateIndex
CREATE INDEX "PaymentLedgerEntry_companyId_occurredAt_idx" ON "PaymentLedgerEntry"("companyId", "occurredAt");

-- AddForeignKey
ALTER TABLE "PaymentProviderConfig" ADD CONSTRAINT "PaymentProviderConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_providerConfigId_fkey" FOREIGN KEY ("providerConfigId") REFERENCES "PaymentProviderConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLedgerEntry" ADD CONSTRAINT "PaymentLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
