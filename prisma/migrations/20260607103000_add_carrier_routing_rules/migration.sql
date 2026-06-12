-- Carrier routing rules decide which integration provider should execute an order leg.
-- Pricing/tariffs remain separate and continue to decide what CargoPilot charges the customer.

CREATE TABLE "CarrierRoutingRule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "fallbackProviderId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "autoBook" BOOLEAN NOT NULL DEFAULT true,
    "serviceType" "ServiceType",
    "transportMode" "TransportMode",
    "originCountryCode" TEXT,
    "destinationCountryCode" TEXT,
    "minWeightKg" DECIMAL(10,2),
    "maxWeightKg" DECIMAL(10,2),
    "legSequence" INTEGER,
    "conditionsJson" JSONB,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierRoutingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uniq_carrier_routing_rule_company_code" ON "CarrierRoutingRule"("companyId", "code");
CREATE INDEX "CarrierRoutingRule_companyId_isActive_priority_idx" ON "CarrierRoutingRule"("companyId", "isActive", "priority");
CREATE INDEX "CarrierRoutingRule_providerId_isActive_idx" ON "CarrierRoutingRule"("providerId", "isActive");
CREATE INDEX "CarrierRoutingRule_originCountryCode_destinationCountryCode_idx" ON "CarrierRoutingRule"("originCountryCode", "destinationCountryCode", "transportMode");
CREATE INDEX "CarrierRoutingRule_serviceType_transportMode_isActive_idx" ON "CarrierRoutingRule"("serviceType", "transportMode", "isActive");

ALTER TABLE "CarrierRoutingRule"
ADD CONSTRAINT "CarrierRoutingRule_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CarrierRoutingRule"
ADD CONSTRAINT "CarrierRoutingRule_providerId_fkey"
FOREIGN KEY ("providerId") REFERENCES "IntegrationProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CarrierRoutingRule"
ADD CONSTRAINT "CarrierRoutingRule_fallbackProviderId_fkey"
FOREIGN KEY ("fallbackProviderId") REFERENCES "IntegrationProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
