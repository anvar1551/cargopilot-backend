-- CreateEnum
CREATE TYPE "OrderSlaSource" AS ENUM ('PROMISE_DATE', 'SLA_RULE', 'NONE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "expectedDeliveryAt" TIMESTAMP(3),
ADD COLUMN     "slaRuleId" UUID,
ADD COLUMN     "slaSource" "OrderSlaSource",
ADD COLUMN     "slaTargetDays" INTEGER;

-- CreateTable
CREATE TABLE "DeliverySlaRule" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "serviceType" "ServiceType" NOT NULL,
    "originRegionId" UUID,
    "destinationRegionId" UUID,
    "zone" INTEGER,
    "deliveryDays" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliverySlaRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliverySlaRule_serviceType_isActive_priority_idx" ON "DeliverySlaRule"("serviceType", "isActive", "priority");

-- CreateIndex
CREATE INDEX "DeliverySlaRule_originRegionId_destinationRegionId_idx" ON "DeliverySlaRule"("originRegionId", "destinationRegionId");

-- CreateIndex
CREATE INDEX "DeliverySlaRule_zone_idx" ON "DeliverySlaRule"("zone");

-- CreateIndex
CREATE INDEX "Order_status_expectedDeliveryAt_idx" ON "Order"("status", "expectedDeliveryAt");

-- CreateIndex
CREATE INDEX "Order_expectedDeliveryAt_idx" ON "Order"("expectedDeliveryAt");

-- CreateIndex
CREATE INDEX "Order_slaRuleId_idx" ON "Order"("slaRuleId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_slaRuleId_fkey" FOREIGN KEY ("slaRuleId") REFERENCES "DeliverySlaRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySlaRule" ADD CONSTRAINT "DeliverySlaRule_originRegionId_fkey" FOREIGN KEY ("originRegionId") REFERENCES "PricingRegion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySlaRule" ADD CONSTRAINT "DeliverySlaRule_destinationRegionId_fkey" FOREIGN KEY ("destinationRegionId") REFERENCES "PricingRegion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
