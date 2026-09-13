-- Additive tariff ownership expansion. Existing plans remain unowned and are
-- intentionally excluded by tenant-facing application queries.
ALTER TABLE "TariffPlan"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "companyId" UUID,
  ADD CONSTRAINT "TariffPlan_ownership_presence_check" CHECK (
    ("tenantId" IS NULL AND "companyId" IS NULL)
    OR
    ("tenantId" IS NOT NULL AND "companyId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "RouteTemplate_company_identity_key"
  ON "RouteTemplate"("companyId", "id");

CREATE INDEX "TariffPlan_tenant_company_status_serviceType_priority_idx"
  ON "TariffPlan"("tenantId", "companyId", "status", "serviceType", "priority");

ALTER TABLE "TariffPlan"
  ADD CONSTRAINT "TariffPlan_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TariffPlan_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId")
    REFERENCES "Organization"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "TariffPlan_tenant_customer_fkey"
    FOREIGN KEY ("tenantId", "customerEntityId")
    REFERENCES "CustomerEntity"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "TariffPlan_company_route_template_fkey"
    FOREIGN KEY ("companyId", "routeTemplateId")
    REFERENCES "RouteTemplate"("companyId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
