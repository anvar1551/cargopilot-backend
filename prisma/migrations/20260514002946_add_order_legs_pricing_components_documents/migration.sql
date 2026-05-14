-- CreateEnum
CREATE TYPE "TransportMode" AS ENUM ('road', 'air', 'rail', 'sea', 'multimodal');

-- CreateEnum
CREATE TYPE "OrderLegStatus" AS ENUM ('planned', 'booked', 'departed', 'in_transit', 'arrived', 'completed', 'cancelled', 'exception');

-- CreateEnum
CREATE TYPE "PricingComponentType" AS ENUM ('warehouse_service', 'linehaul', 'local_delivery', 'customs', 'insurance', 'handling', 'surcharge', 'discount', 'other');

-- CreateEnum
CREATE TYPE "PricingComponentSource" AS ENUM ('manual', 'rule', 'integration', 'adjustment');

-- CreateEnum
CREATE TYPE "OrderDocumentType" AS ENUM ('label', 'manifest', 'route_sheet', 'handover_act', 'sender_data', 'receiver_data', 'customs_doc', 'invoice', 'other');

-- CreateEnum
CREATE TYPE "OrderDocumentFormat" AS ENUM ('pdf', 'png', 'zpl', 'csv', 'json', 'other');

-- AlterTable
ALTER TABLE "Tracking" ADD COLUMN     "orderLegId" UUID;

-- CreateTable
CREATE TABLE "OrderLeg" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "mode" "TransportMode" NOT NULL DEFAULT 'road',
    "status" "OrderLegStatus" NOT NULL DEFAULT 'planned',
    "fromCountry" TEXT,
    "toCountry" TEXT,
    "transitRoute" JSONB,
    "fromWarehouseId" UUID,
    "toWarehouseId" UUID,
    "carrierCode" TEXT,
    "carrierRef" TEXT,
    "vehicleRef" TEXT,
    "plannedDepartureAt" TIMESTAMP(3),
    "plannedArrivalAt" TIMESTAMP(3),
    "actualDepartureAt" TIMESTAMP(3),
    "actualArrivalAt" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingComponent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLegId" UUID,
    "componentType" "PricingComponentType" NOT NULL,
    "source" "PricingComponentSource" NOT NULL DEFAULT 'manual',
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "fxRateSnapshot" DECIMAL(14,6),
    "baseCurrency" TEXT,
    "baseAmount" DECIMAL(14,2),
    "referenceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderDocument" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLegId" UUID,
    "type" "OrderDocumentType" NOT NULL,
    "format" "OrderDocumentFormat" NOT NULL DEFAULT 'pdf',
    "locale" TEXT,
    "templateCode" TEXT,
    "templateVersion" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "metadata" JSONB,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderLeg_orderId_status_sequence_idx" ON "OrderLeg"("orderId", "status", "sequence");

-- CreateIndex
CREATE INDEX "OrderLeg_mode_status_idx" ON "OrderLeg"("mode", "status");

-- CreateIndex
CREATE INDEX "OrderLeg_fromWarehouseId_idx" ON "OrderLeg"("fromWarehouseId");

-- CreateIndex
CREATE INDEX "OrderLeg_toWarehouseId_idx" ON "OrderLeg"("toWarehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLeg_orderId_sequence_key" ON "OrderLeg"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "PricingComponent_orderId_componentType_createdAt_idx" ON "PricingComponent"("orderId", "componentType", "createdAt");

-- CreateIndex
CREATE INDEX "PricingComponent_orderLegId_componentType_createdAt_idx" ON "PricingComponent"("orderLegId", "componentType", "createdAt");

-- CreateIndex
CREATE INDEX "PricingComponent_currency_createdAt_idx" ON "PricingComponent"("currency", "createdAt");

-- CreateIndex
CREATE INDEX "OrderDocument_orderId_type_createdAt_idx" ON "OrderDocument"("orderId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "OrderDocument_orderLegId_type_createdAt_idx" ON "OrderDocument"("orderLegId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "OrderDocument_createdById_createdAt_idx" ON "OrderDocument"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "Tracking_orderLegId_timestamp_idx" ON "Tracking"("orderLegId", "timestamp");

-- AddForeignKey
ALTER TABLE "OrderLeg" ADD CONSTRAINT "OrderLeg_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLeg" ADD CONSTRAINT "OrderLeg_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLeg" ADD CONSTRAINT "OrderLeg_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingComponent" ADD CONSTRAINT "PricingComponent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingComponent" ADD CONSTRAINT "PricingComponent_orderLegId_fkey" FOREIGN KEY ("orderLegId") REFERENCES "OrderLeg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_orderLegId_fkey" FOREIGN KEY ("orderLegId") REFERENCES "OrderLeg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tracking" ADD CONSTRAINT "Tracking_orderLegId_fkey" FOREIGN KEY ("orderLegId") REFERENCES "OrderLeg"("id") ON DELETE SET NULL ON UPDATE CASCADE;
