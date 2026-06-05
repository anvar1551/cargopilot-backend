-- CreateEnum
CREATE TYPE "TariffCoverageType" AS ENUM ('domestic', 'international');

-- CreateEnum
CREATE TYPE "TariffTransportMode" AS ENUM ('ROAD', 'AIR', 'SEA', 'RAIL', 'COURIER', 'MULTIMODAL');

-- AlterTable
ALTER TABLE "TariffPlan"
ADD COLUMN "coverageType" "TariffCoverageType" NOT NULL DEFAULT 'domestic',
ADD COLUMN "transportMode" "TariffTransportMode" NOT NULL DEFAULT 'ROAD',
ADD COLUMN "originCountryCode" TEXT,
ADD COLUMN "destinationCountryCode" TEXT;

-- CreateIndex
CREATE INDEX "TariffPlan_coverageType_transportMode_status_idx" ON "TariffPlan"("coverageType", "transportMode", "status");

-- CreateIndex
CREATE INDEX "TariffPlan_originCountryCode_destinationCountryCode_idx" ON "TariffPlan"("originCountryCode", "destinationCountryCode");
