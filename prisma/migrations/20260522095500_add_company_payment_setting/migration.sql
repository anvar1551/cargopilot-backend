-- CreateTable
CREATE TABLE "CompanyPaymentSetting" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "onlinePaymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultProvider" "PaymentProvider",
    "allowProviderOverride" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyPaymentSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyPaymentSetting_companyId_key" ON "CompanyPaymentSetting"("companyId");

-- CreateIndex
CREATE INDEX "CompanyPaymentSetting_onlinePaymentsEnabled_updatedAt_idx" ON "CompanyPaymentSetting"("onlinePaymentsEnabled", "updatedAt");

-- AddForeignKey
ALTER TABLE "CompanyPaymentSetting" ADD CONSTRAINT "CompanyPaymentSetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
