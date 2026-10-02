-- Additive ownership enforcement; retained simple FK remains an existence check.
-- NOT VALID protects new/changed references, not historical certification.
CREATE UNIQUE INDEX "IntegrationWebhookEvent_normalized_context_key" ON "IntegrationWebhookEvent" (id,"companyId",domain,"providerCode");
CREATE UNIQUE INDEX "IntegrationWebhookCanonicalEvent_context_key" ON "IntegrationWebhookCanonicalEvent" ("webhookEventId","companyId",domain,"providerCode");
ALTER TABLE "IntegrationWebhookCanonicalEvent" ADD CONSTRAINT "IntegrationWebhookCanonicalEvent_context_fkey"
 FOREIGN KEY ("webhookEventId","companyId",domain,"providerCode") REFERENCES "IntegrationWebhookEvent" (id,"companyId",domain,"providerCode")
 ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "IntegrationWebhookCanonicalEvent" ADD CONSTRAINT "IntegrationWebhookCanonicalEvent_context_complete_check"
 CHECK ("companyId" IS NOT NULL) NOT VALID;
