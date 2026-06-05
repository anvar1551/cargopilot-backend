CREATE TYPE "TariffPricingStrategy" AS ENUM ('FIXED_LANE', 'LEG_TRANSIT');

ALTER TABLE "TariffPlan"
ADD COLUMN "pricingStrategy" "TariffPricingStrategy" NOT NULL DEFAULT 'FIXED_LANE',
ADD COLUMN "transitPricingConfig" JSONB;
