-- CreateTable
CREATE TABLE "FinanceChartTemplateInstallation" (
    "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
    "legalEntityId" UUID NOT NULL,
    "templateCode" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "installedByUserId" UUID NOT NULL,
    "accountCount" INTEGER NOT NULL,
    "metadataJson" JSONB,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceChartTemplateInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceChartTemplateInstallation_legalEntityId_installedAt_idx" ON "FinanceChartTemplateInstallation"("legalEntityId", "installedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceChartTemplateInstallation_legalEntityId_templateCode_key" ON "FinanceChartTemplateInstallation"("legalEntityId", "templateCode", "templateVersion");

-- AddForeignKey
ALTER TABLE "FinanceChartTemplateInstallation" ADD CONSTRAINT "FinanceChartTemplateInstallation_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "FinanceLegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
