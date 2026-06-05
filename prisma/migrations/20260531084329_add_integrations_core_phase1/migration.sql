-- CreateEnum
CREATE TYPE "IntegrationDomain" AS ENUM ('carrier', 'sms', 'payment', 'webhook_sink');

-- CreateEnum
CREATE TYPE "IntegrationProviderStatus" AS ENUM ('active', 'paused', 'disabled');

-- CreateEnum
CREATE TYPE "IntegrationEnvironment" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "IntegrationOutboxStatus" AS ENUM ('pending', 'processing', 'sent', 'failed', 'dead_letter');

-- CreateEnum
CREATE TYPE "IntegrationAttemptOutcome" AS ENUM ('success', 'retry', 'dead_letter', 'failed');

-- CreateTable
CREATE TABLE "IntegrationProvider" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "domain" "IntegrationDomain" NOT NULL,
    "providerCode" TEXT NOT NULL,
    "status" "IntegrationProviderStatus" NOT NULL DEFAULT 'active',
    "environment" "IntegrationEnvironment" NOT NULL DEFAULT 'sandbox',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rateLimitRps" INTEGER,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "retryPolicyId" TEXT,
    "secretRef" TEXT,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationProviderSecret" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "encryptedSecretJson" TEXT NOT NULL,
    "secretMasked" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationProviderSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationOutbox" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "providerId" UUID,
    "domain" "IntegrationDomain" NOT NULL,
    "providerCode" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "IntegrationOutboxStatus" NOT NULL DEFAULT 'pending',
    "maxAttempts" INTEGER NOT NULL DEFAULT 10,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationDeliveryAttempt" (
    "id" UUID NOT NULL,
    "outboxId" UUID NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "outcome" "IntegrationAttemptOutcome" NOT NULL,
    "statusCode" INTEGER,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "providerRequestId" TEXT,
    "requestJson" JSONB,
    "responseJson" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationWebhookEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "providerId" UUID,
    "domain" "IntegrationDomain" NOT NULL,
    "providerCode" TEXT NOT NULL,
    "environment" "IntegrationEnvironment" NOT NULL DEFAULT 'sandbox',
    "providerEventId" TEXT NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "rawBody" TEXT NOT NULL,
    "rawBodySha256" TEXT NOT NULL,
    "headersJson" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationWebhookCanonicalEvent" (
    "id" UUID NOT NULL,
    "webhookEventId" UUID NOT NULL,
    "providerCode" TEXT NOT NULL,
    "domain" "IntegrationDomain" NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "companyId" UUID,
    "aggregateType" TEXT,
    "aggregateId" TEXT,
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationWebhookCanonicalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationProvider_companyId_domain_status_idx" ON "IntegrationProvider"("companyId", "domain", "status");

-- CreateIndex
CREATE INDEX "IntegrationProvider_providerCode_environment_status_idx" ON "IntegrationProvider"("providerCode", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_provider_company_domain_code_env" ON "IntegrationProvider"("companyId", "domain", "providerCode", "environment");

-- CreateIndex
CREATE INDEX "IntegrationProviderSecret_providerId_createdAt_idx" ON "IntegrationProviderSecret"("providerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_provider_secret_version" ON "IntegrationProviderSecret"("providerId", "keyVersion");

-- CreateIndex
CREATE INDEX "IntegrationOutbox_status_nextAttemptAt_createdAt_idx" ON "IntegrationOutbox"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationOutbox_companyId_domain_status_nextAttemptAt_idx" ON "IntegrationOutbox"("companyId", "domain", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "IntegrationOutbox_providerId_status_nextAttemptAt_idx" ON "IntegrationOutbox"("providerId", "status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_outbox_company_provider_idempotency" ON "IntegrationOutbox"("companyId", "providerCode", "idempotencyKey");

-- CreateIndex
CREATE INDEX "IntegrationDeliveryAttempt_outboxId_createdAt_idx" ON "IntegrationDeliveryAttempt"("outboxId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationDeliveryAttempt_outcome_createdAt_idx" ON "IntegrationDeliveryAttempt"("outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_delivery_attempt_outbox_attempt" ON "IntegrationDeliveryAttempt"("outboxId", "attemptNo");

-- CreateIndex
CREATE INDEX "IntegrationWebhookEvent_companyId_receivedAt_idx" ON "IntegrationWebhookEvent"("companyId", "receivedAt");

-- CreateIndex
CREATE INDEX "IntegrationWebhookEvent_providerId_receivedAt_idx" ON "IntegrationWebhookEvent"("providerId", "receivedAt");

-- CreateIndex
CREATE INDEX "IntegrationWebhookEvent_domain_providerCode_receivedAt_idx" ON "IntegrationWebhookEvent"("domain", "providerCode", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_webhook_provider_event" ON "IntegrationWebhookEvent"("providerCode", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationWebhookCanonicalEvent_webhookEventId_key" ON "IntegrationWebhookCanonicalEvent"("webhookEventId");

-- CreateIndex
CREATE INDEX "IntegrationWebhookCanonicalEvent_providerCode_eventType_occ_idx" ON "IntegrationWebhookCanonicalEvent"("providerCode", "eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "IntegrationWebhookCanonicalEvent_companyId_occurredAt_idx" ON "IntegrationWebhookCanonicalEvent"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "IntegrationWebhookCanonicalEvent_aggregateType_aggregateId__idx" ON "IntegrationWebhookCanonicalEvent"("aggregateType", "aggregateId", "occurredAt");

-- AddForeignKey
ALTER TABLE "IntegrationProvider" ADD CONSTRAINT "IntegrationProvider_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationProviderSecret" ADD CONSTRAINT "IntegrationProviderSecret_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IntegrationProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationOutbox" ADD CONSTRAINT "IntegrationOutbox_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationOutbox" ADD CONSTRAINT "IntegrationOutbox_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IntegrationProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDeliveryAttempt" ADD CONSTRAINT "IntegrationDeliveryAttempt_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "IntegrationOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationWebhookEvent" ADD CONSTRAINT "IntegrationWebhookEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationWebhookEvent" ADD CONSTRAINT "IntegrationWebhookEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IntegrationProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationWebhookCanonicalEvent" ADD CONSTRAINT "IntegrationWebhookCanonicalEvent_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "IntegrationWebhookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
