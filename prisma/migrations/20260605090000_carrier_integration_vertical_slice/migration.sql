-- CreateEnum
CREATE TYPE "CarrierBookingStatus" AS ENUM ('not_requested', 'requested', 'booked', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "IntegrationEventSource" AS ENUM ('outbound_response', 'inbound_webhook');

-- CreateEnum
CREATE TYPE "IntegrationEventProcessStatus" AS ENUM ('pending', 'processing', 'processed', 'failed', 'ignored');

-- AlterTable
ALTER TABLE "IntegrationOutbox"
ADD COLUMN "environment" "IntegrationEnvironment" NOT NULL DEFAULT 'sandbox',
ADD COLUMN "aggregateType" TEXT,
ADD COLUMN "aggregateId" TEXT,
ADD COLUMN "operation" TEXT;

-- AlterTable
ALTER TABLE "OrderLeg"
ADD COLUMN "carrierProviderId" UUID,
ADD COLUMN "carrierBookingStatus" "CarrierBookingStatus" NOT NULL DEFAULT 'not_requested',
ADD COLUMN "carrierTrackingNumber" TEXT,
ADD COLUMN "carrierBookingError" TEXT,
ADD COLUMN "carrierBookedAt" TIMESTAMP(3),
ADD COLUMN "carrierLastStatusAt" TIMESTAMP(3);

-- Re-scope webhook idempotency to the exact provider config.
DROP INDEX IF EXISTS "uniq_integration_webhook_provider_event";

-- CreateTable
CREATE TABLE "IntegrationCanonicalEvent" (
    "id" UUID NOT NULL,
    "source" "IntegrationEventSource" NOT NULL,
    "status" "IntegrationEventProcessStatus" NOT NULL DEFAULT 'pending',
    "companyId" UUID,
    "providerId" UUID,
    "webhookEventId" UUID,
    "outboxId" UUID,
    "domain" "IntegrationDomain" NOT NULL,
    "providerCode" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT,
    "aggregateId" TEXT,
    "payloadJson" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "processAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCanonicalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationOutbox_aggregateType_aggregateId_operation_idx" ON "IntegrationOutbox"("aggregateType", "aggregateId", "operation");

-- CreateIndex
CREATE INDEX "OrderLeg_carrierProviderId_idx" ON "OrderLeg"("carrierProviderId");

-- CreateIndex
CREATE INDEX "OrderLeg_carrierBookingStatus_updatedAt_idx" ON "OrderLeg"("carrierBookingStatus", "updatedAt");

-- CreateIndex
CREATE INDEX "OrderLeg_carrierRef_idx" ON "OrderLeg"("carrierRef");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_canonical_event_identity" ON "IntegrationCanonicalEvent"("source", "providerCode", "eventType", "aggregateType", "aggregateId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_canonical_event_outbox" ON "IntegrationCanonicalEvent"("outboxId");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_canonical_event_webhook" ON "IntegrationCanonicalEvent"("webhookEventId");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_integration_webhook_provider_event" ON "IntegrationWebhookEvent"("providerId", "providerEventId");

-- CreateIndex
CREATE INDEX "IntegrationCanonicalEvent_status_occurredAt_createdAt_idx" ON "IntegrationCanonicalEvent"("status", "occurredAt", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationCanonicalEvent_companyId_domain_status_idx" ON "IntegrationCanonicalEvent"("companyId", "domain", "status");

-- CreateIndex
CREATE INDEX "IntegrationCanonicalEvent_providerId_status_occurredAt_idx" ON "IntegrationCanonicalEvent"("providerId", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "IntegrationCanonicalEvent_aggregateType_aggregateId_eventTy_idx" ON "IntegrationCanonicalEvent"("aggregateType", "aggregateId", "eventType");

-- AddForeignKey
ALTER TABLE "IntegrationCanonicalEvent" ADD CONSTRAINT "IntegrationCanonicalEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IntegrationProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCanonicalEvent" ADD CONSTRAINT "IntegrationCanonicalEvent_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "IntegrationWebhookEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
