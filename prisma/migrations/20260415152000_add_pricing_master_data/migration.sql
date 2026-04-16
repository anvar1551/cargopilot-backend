-- CreateEnum
CREATE TYPE "PricingPlanStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "TariffPriceType" AS ENUM ('bucket', 'linear');

-- CreateTable
CREATE TABLE "PricingRegion" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PricingRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneMatrixEntry" (
  "id" UUID NOT NULL,
  "originRegionId" UUID NOT NULL,
  "destinationRegionId" UUID NOT NULL,
  "zone" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ZoneMatrixEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffPlan" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "description" TEXT,
  "status" "PricingPlanStatus" NOT NULL DEFAULT 'draft',
  "serviceType" "ServiceType" NOT NULL,
  "priceType" "TariffPriceType" NOT NULL DEFAULT 'bucket',
  "currency" TEXT NOT NULL DEFAULT 'UZS',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "customerEntityId" UUID,
  CONSTRAINT "TariffPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffRate" (
  "id" UUID NOT NULL,
  "tariffPlanId" UUID NOT NULL,
  "zone" INTEGER NOT NULL,
  "weightFromKg" DECIMAL(10,2) NOT NULL,
  "weightToKg" DECIMAL(10,2) NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TariffRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PricingRegion_code_key" ON "PricingRegion"("code");
CREATE INDEX "PricingRegion_isActive_sortOrder_idx" ON "PricingRegion"("isActive", "sortOrder");
CREATE INDEX "PricingRegion_name_idx" ON "PricingRegion"("name");
CREATE UNIQUE INDEX "ZoneMatrixEntry_originRegionId_destinationRegionId_key" ON "ZoneMatrixEntry"("originRegionId", "destinationRegionId");
CREATE INDEX "ZoneMatrixEntry_zone_idx" ON "ZoneMatrixEntry"("zone");
CREATE UNIQUE INDEX "TariffPlan_code_key" ON "TariffPlan"("code");
CREATE INDEX "TariffPlan_status_serviceType_priority_idx" ON "TariffPlan"("status", "serviceType", "priority");
CREATE INDEX "TariffPlan_customerEntityId_status_idx" ON "TariffPlan"("customerEntityId", "status");
CREATE UNIQUE INDEX "TariffRate_tariffPlanId_zone_weightFromKg_weightToKg_key" ON "TariffRate"("tariffPlanId", "zone", "weightFromKg", "weightToKg");
CREATE INDEX "TariffRate_tariffPlanId_zone_idx" ON "TariffRate"("tariffPlanId", "zone");

-- AddForeignKey
ALTER TABLE "ZoneMatrixEntry" ADD CONSTRAINT "ZoneMatrixEntry_originRegionId_fkey" FOREIGN KEY ("originRegionId") REFERENCES "PricingRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ZoneMatrixEntry" ADD CONSTRAINT "ZoneMatrixEntry_destinationRegionId_fkey" FOREIGN KEY ("destinationRegionId") REFERENCES "PricingRegion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TariffPlan" ADD CONSTRAINT "TariffPlan_customerEntityId_fkey" FOREIGN KEY ("customerEntityId") REFERENCES "CustomerEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TariffRate" ADD CONSTRAINT "TariffRate_tariffPlanId_fkey" FOREIGN KEY ("tariffPlanId") REFERENCES "TariffPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
