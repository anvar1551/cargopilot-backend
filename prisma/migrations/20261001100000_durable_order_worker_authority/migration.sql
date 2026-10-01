-- Additive grants. Existing rows are deliberately unaccepted, never backfilled.
ALTER TABLE "OrderLabelJob"
 ADD COLUMN "ownershipTenantId" UUID,
 ADD COLUMN "ownershipCompanyId" UUID,
 ADD COLUMN "acceptedAt" TIMESTAMP(3),
 ADD COLUMN "capability" TEXT;
ALTER TABLE "OrderLabelJob" ADD CONSTRAINT "OrderLabelJob_grant_complete_check" CHECK (
 ("ownershipTenantId" IS NULL AND "ownershipCompanyId" IS NULL AND "acceptedAt" IS NULL AND "capability" IS NULL)
 OR ("ownershipTenantId" IS NOT NULL AND "ownershipCompanyId" IS NOT NULL AND "acceptedAt" IS NOT NULL AND "capability" = 'label.generate' AND "capability" IS NOT NULL)
);
ALTER TABLE "OrderLabelJob" ADD CONSTRAINT "OrderLabelJob_accepted_order_fkey"
 FOREIGN KEY ("ownershipTenantId", "orderId", "ownershipCompanyId") REFERENCES "Order" ("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "OrderLabelJob_tenant_company_status_idx" ON "OrderLabelJob" ("ownershipTenantId", "ownershipCompanyId", "status");

ALTER TABLE "IntegrationOutbox"
 ADD COLUMN "ownershipTenantId" UUID,
 ADD COLUMN "ownershipOrderId" UUID,
 ADD COLUMN "acceptedAt" TIMESTAMP(3),
 ADD COLUMN "executionStartedAt" TIMESTAMP(3);
ALTER TABLE "IntegrationOutbox" ADD CONSTRAINT "IntegrationOutbox_grant_complete_check" CHECK (
 ("ownershipTenantId" IS NULL AND "ownershipOrderId" IS NULL AND "acceptedAt" IS NULL AND "executionStartedAt" IS NULL)
 OR ("ownershipTenantId" IS NOT NULL AND "ownershipOrderId" IS NOT NULL AND "acceptedAt" IS NOT NULL
     AND "domain" = 'carrier' AND "operation" IS NOT NULL AND "operation" IN ('create_shipment', 'track', 'cancel_shipment'))
);
ALTER TABLE "IntegrationOutbox" ADD CONSTRAINT "IntegrationOutbox_accepted_order_fkey"
 FOREIGN KEY ("ownershipTenantId", "ownershipOrderId", "companyId") REFERENCES "Order" ("tenantId", "id", "ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "IntegrationOutbox_ownershipTenantId_companyId_status_idx" ON "IntegrationOutbox" ("ownershipTenantId", "companyId", "status");
