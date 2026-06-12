-- CreateTable
CREATE TABLE "RouteTemplate" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "serviceType" "ServiceType",
    "transportMode" "TransportMode",
    "originCountryCode" TEXT,
    "destinationCountryCode" TEXT,
    "metadata" JSONB,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteTemplateLeg" (
    "id" UUID NOT NULL,
    "routeTemplateId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "legCode" TEXT NOT NULL,
    "label" TEXT,
    "mode" "TransportMode" NOT NULL DEFAULT 'road',
    "originCountryCode" TEXT,
    "destinationCountryCode" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteTemplateLeg_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CarrierRoutingRule"
ADD COLUMN "routeTemplateId" UUID,
ADD COLUMN "routeTemplateLegId" UUID;

-- AlterTable
ALTER TABLE "OrderLeg"
ADD COLUMN "routeTemplateId" UUID,
ADD COLUMN "routeTemplateLegId" UUID;

-- AlterTable
ALTER TABLE "TariffPlan"
ADD COLUMN "routeTemplateId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "uniq_route_template_company_code" ON "RouteTemplate"("companyId", "code");

-- CreateIndex
CREATE INDEX "RouteTemplate_companyId_isActive_priority_idx" ON "RouteTemplate"("companyId", "isActive", "priority");

-- CreateIndex
CREATE INDEX "RouteTemplate_originCountryCode_destinationCountryCode_tran_idx" ON "RouteTemplate"("originCountryCode", "destinationCountryCode", "transportMode");

-- CreateIndex
CREATE INDEX "RouteTemplate_serviceType_transportMode_isActive_idx" ON "RouteTemplate"("serviceType", "transportMode", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_route_template_leg_sequence" ON "RouteTemplateLeg"("routeTemplateId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_route_template_leg_code" ON "RouteTemplateLeg"("routeTemplateId", "legCode");

-- CreateIndex
CREATE INDEX "RouteTemplateLeg_routeTemplateId_sequence_idx" ON "RouteTemplateLeg"("routeTemplateId", "sequence");

-- CreateIndex
CREATE INDEX "RouteTemplateLeg_originCountryCode_destinationCountryCode_m_idx" ON "RouteTemplateLeg"("originCountryCode", "destinationCountryCode", "mode");

-- CreateIndex
CREATE INDEX "CarrierRoutingRule_routeTemplateId_isActive_priority_idx" ON "CarrierRoutingRule"("routeTemplateId", "isActive", "priority");

-- CreateIndex
CREATE INDEX "CarrierRoutingRule_routeTemplateLegId_isActive_priority_idx" ON "CarrierRoutingRule"("routeTemplateLegId", "isActive", "priority");

-- CreateIndex
CREATE INDEX "OrderLeg_routeTemplateId_idx" ON "OrderLeg"("routeTemplateId");

-- CreateIndex
CREATE INDEX "OrderLeg_routeTemplateLegId_idx" ON "OrderLeg"("routeTemplateLegId");

-- CreateIndex
CREATE INDEX "TariffPlan_routeTemplateId_status_idx" ON "TariffPlan"("routeTemplateId", "status");

-- AddForeignKey
ALTER TABLE "RouteTemplate" ADD CONSTRAINT "RouteTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteTemplateLeg" ADD CONSTRAINT "RouteTemplateLeg_routeTemplateId_fkey" FOREIGN KEY ("routeTemplateId") REFERENCES "RouteTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierRoutingRule" ADD CONSTRAINT "CarrierRoutingRule_routeTemplateId_fkey" FOREIGN KEY ("routeTemplateId") REFERENCES "RouteTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarrierRoutingRule" ADD CONSTRAINT "CarrierRoutingRule_routeTemplateLegId_fkey" FOREIGN KEY ("routeTemplateLegId") REFERENCES "RouteTemplateLeg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLeg" ADD CONSTRAINT "OrderLeg_routeTemplateId_fkey" FOREIGN KEY ("routeTemplateId") REFERENCES "RouteTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLeg" ADD CONSTRAINT "OrderLeg_routeTemplateLegId_fkey" FOREIGN KEY ("routeTemplateLegId") REFERENCES "RouteTemplateLeg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffPlan" ADD CONSTRAINT "TariffPlan_routeTemplateId_fkey" FOREIGN KEY ("routeTemplateId") REFERENCES "RouteTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
