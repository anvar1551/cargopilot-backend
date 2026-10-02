-- Expand only: existing simple FKs remain intentionally; no historical inference.
-- Reuse IntegrationProvider_id_companyId_key and RouteTemplate_company_identity_key.
CREATE UNIQUE INDEX "RouteTemplateLeg_template_identity_key"
  ON "RouteTemplateLeg" ("routeTemplateId", "id");

ALTER TABLE "CarrierRoutingRule"
  ADD CONSTRAINT "CarrierRoutingRule_provider_company_fkey"
  FOREIGN KEY ("providerId", "companyId") REFERENCES "IntegrationProvider" ("id", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "CarrierRoutingRule_fallback_company_fkey"
  FOREIGN KEY ("fallbackProviderId", "companyId") REFERENCES "IntegrationProvider" ("id", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "CarrierRoutingRule_template_company_fkey"
  FOREIGN KEY ("companyId", "routeTemplateId") REFERENCES "RouteTemplate" ("companyId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "CarrierRoutingRule_template_leg_fkey"
  FOREIGN KEY ("routeTemplateId", "routeTemplateLegId") REFERENCES "RouteTemplateLeg" ("routeTemplateId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "CarrierRoutingRule_template_complete_check"
  CHECK ("routeTemplateLegId" IS NULL OR "routeTemplateId" IS NOT NULL) NOT VALID;
