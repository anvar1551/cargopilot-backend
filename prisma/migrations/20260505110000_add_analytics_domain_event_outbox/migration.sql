-- CreateTable
CREATE TABLE "AnalyticsDomainEventOutbox" (
  "id" UUID NOT NULL,
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "tenantScope" TEXT NOT NULL,
  "entityId" TEXT,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AnalyticsDomainEventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsDomainEventOutbox_eventId_key" ON "AnalyticsDomainEventOutbox"("eventId");

-- CreateIndex
CREATE INDEX "AnalyticsDomainEventOutbox_publishedAt_createdAt_idx" ON "AnalyticsDomainEventOutbox"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsDomainEventOutbox_type_createdAt_idx" ON "AnalyticsDomainEventOutbox"("type", "createdAt");
