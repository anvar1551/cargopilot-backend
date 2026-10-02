-- Expand only: retain historical simple FKs deliberately as additional existence
-- checks. NOT VALID does not certify historical rows or infer their ownership.
CREATE UNIQUE INDEX "IntegrationProvider_context_key" ON "IntegrationProvider" (id,"companyId",domain,"providerCode",environment);
CREATE UNIQUE INDEX "IntegrationProvider_event_context_key" ON "IntegrationProvider" (id,"companyId",domain,"providerCode");
CREATE UNIQUE INDEX "IntegrationOutbox_event_context_key" ON "IntegrationOutbox" (id,"companyId","providerId",domain,"providerCode");
CREATE UNIQUE INDEX "IntegrationWebhookEvent_context_key" ON "IntegrationWebhookEvent" (id,"companyId","providerId",domain,"providerCode");
CREATE UNIQUE INDEX "IntegrationCanonicalEvent_outbox_context_key" ON "IntegrationCanonicalEvent" ("outboxId","companyId","providerId",domain,"providerCode");
ALTER TABLE "IntegrationOutbox" ADD CONSTRAINT "IntegrationOutbox_provider_context_fkey"
 FOREIGN KEY ("providerId","companyId",domain,"providerCode",environment)
 REFERENCES "IntegrationProvider" (id,"companyId",domain,"providerCode",environment) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "IntegrationWebhookEvent" ADD CONSTRAINT "IntegrationWebhookEvent_provider_context_fkey"
 FOREIGN KEY ("providerId","companyId",domain,"providerCode",environment)
 REFERENCES "IntegrationProvider" (id,"companyId",domain,"providerCode",environment) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "IntegrationWebhookEvent" ADD CONSTRAINT "IntegrationWebhookEvent_context_complete_check"
 CHECK (("companyId" IS NULL AND "providerId" IS NULL) OR ("companyId" IS NOT NULL AND "providerId" IS NOT NULL)) NOT VALID;
ALTER TABLE "IntegrationCanonicalEvent" ADD CONSTRAINT "IntegrationCanonicalEvent_provider_context_fkey"
 FOREIGN KEY ("providerId","companyId",domain,"providerCode")
 REFERENCES "IntegrationProvider" (id,"companyId",domain,"providerCode") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "IntegrationCanonicalEvent" ADD CONSTRAINT "IntegrationCanonicalEvent_webhook_context_fkey"
 FOREIGN KEY ("webhookEventId","companyId","providerId",domain,"providerCode")
 REFERENCES "IntegrationWebhookEvent" (id,"companyId","providerId",domain,"providerCode") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "IntegrationCanonicalEvent" ADD CONSTRAINT "IntegrationCanonicalEvent_outbox_context_fkey"
 FOREIGN KEY ("outboxId","companyId","providerId",domain,"providerCode")
 REFERENCES "IntegrationOutbox" (id,"companyId","providerId",domain,"providerCode") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "IntegrationCanonicalEvent" ADD CONSTRAINT "IntegrationCanonicalEvent_source_complete_check"
 CHECK ("companyId" IS NOT NULL AND "providerId" IS NOT NULL AND (
   (source='inbound_webhook' AND "webhookEventId" IS NOT NULL AND "outboxId" IS NULL)
   OR (source='outbound_response' AND "outboxId" IS NOT NULL AND "webhookEventId" IS NULL))) NOT VALID;
