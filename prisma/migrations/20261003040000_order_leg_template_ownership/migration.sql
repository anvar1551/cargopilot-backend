-- Additive expansion; no inference or backfill of historical configuration ownership.
-- Reuse Order_payment_owner_key, RouteTemplate_company_identity_key,
-- and RouteTemplateLeg_template_identity_key. Retain historical simple FKs.
ALTER TABLE "OrderLeg" ADD COLUMN "templateCompanyId" UUID;
CREATE INDEX "OrderLeg_templateCompanyId_routeTemplateId_idx"
  ON "OrderLeg" ("templateCompanyId", "routeTemplateId");
ALTER TABLE "OrderLeg"
  ADD CONSTRAINT "OrderLeg_template_order_company_fkey"
  FOREIGN KEY ("orderId", "templateCompanyId") REFERENCES "Order" ("id", "ownerOrgId")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "OrderLeg_template_company_fkey"
  FOREIGN KEY ("templateCompanyId", "routeTemplateId") REFERENCES "RouteTemplate" ("companyId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "OrderLeg_template_child_fkey"
  FOREIGN KEY ("routeTemplateId", "routeTemplateLegId") REFERENCES "RouteTemplateLeg" ("routeTemplateId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "OrderLeg_template_complete_check"
  CHECK (("routeTemplateId" IS NULL AND "routeTemplateLegId" IS NULL AND "templateCompanyId" IS NULL)
    OR ("routeTemplateId" IS NOT NULL AND "templateCompanyId" IS NOT NULL)) NOT VALID;
