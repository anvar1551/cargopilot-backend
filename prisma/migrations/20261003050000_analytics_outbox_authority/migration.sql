-- Additive only. Legacy rows remain unaccepted; no ownership inference/backfill.
ALTER TABLE "AnalyticsDomainEventOutbox"
 ADD COLUMN "tenantId" uuid, ADD COLUMN "companyId" uuid,
 ADD COLUMN "orderId" uuid, ADD COLUMN "ticketId" uuid,
 ADD COLUMN "acceptedAt" timestamp(3), ADD COLUMN "capability" text, ADD COLUMN "contentHash" text,
 ADD COLUMN "publicationState" text NOT NULL DEFAULT 'unaccepted',
 ADD COLUMN "claimToken" uuid, ADD COLUMN "claimedAt" timestamp(3), ADD COLUMN "leaseExpiresAt" timestamp(3),
 ADD COLUMN "dispatchStartedAt" timestamp(3), ADD COLUMN "nextAttemptAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "SupportTicket_analytics_owner_key" ON "SupportTicket" ("tenantId",id,"ownerOrgId");
CREATE INDEX "AnalyticsOutbox_owner_state_idx" ON "AnalyticsDomainEventOutbox" ("tenantId","companyId","publicationState","nextAttemptAt");
CREATE INDEX "AnalyticsOutbox_claim_idx" ON "AnalyticsDomainEventOutbox" ("publicationState","nextAttemptAt","createdAt");
ALTER TABLE "AnalyticsDomainEventOutbox"
 ADD CONSTRAINT "AnalyticsOutbox_tenant_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "AnalyticsOutbox_company_fkey" FOREIGN KEY ("tenantId","companyId") REFERENCES "Organization"("tenantId",id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "AnalyticsOutbox_order_fkey" FOREIGN KEY ("tenantId","orderId","companyId") REFERENCES "Order"("tenantId",id,"ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "AnalyticsOutbox_ticket_fkey" FOREIGN KEY ("tenantId","ticketId","companyId") REFERENCES "SupportTicket"("tenantId",id,"ownerOrgId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "AnalyticsOutbox_acceptance_check" CHECK (
  ("acceptedAt" IS NULL AND num_nonnulls("tenantId","companyId","orderId","ticketId",capability,"contentHash")=0 AND "publicationState"='unaccepted') OR
  ("acceptedAt" IS NOT NULL AND "tenantId" IS NOT NULL AND "companyId" IS NOT NULL AND "publicationState"<>'unaccepted' AND capability IS NOT NULL AND "contentHash" IS NOT NULL AND "contentHash" ~ '^[a-f0-9]{64}$' AND "schemaVersion"=1 AND
   ((capability='order_event' AND type IN ('order_created','order_status_changed','manual_refresh') AND "orderId" IS NOT NULL AND "ticketId" IS NULL AND "entityId" IS NOT NULL AND "entityId"="orderId"::text) OR
    (capability='support_event' AND type='support_ticket_changed' AND "ticketId" IS NOT NULL AND "orderId" IS NULL AND "entityId" IS NOT NULL AND "entityId"="ticketId"::text) OR
    (capability='support_configuration' AND type='support_ticket_changed' AND "ticketId" IS NULL AND "orderId" IS NULL AND "entityId" IS NULL) OR
    (capability='cash_event' AND type IN ('cash_handoff','cash_settled') AND "orderId" IS NOT NULL AND "ticketId" IS NULL AND "entityId" IS NOT NULL AND "entityId"="orderId"::text) OR
    (capability='cash_finance_source' AND type='finance_source_event' AND "orderId" IS NOT NULL AND "ticketId" IS NULL AND "entityId" IS NOT NULL AND "entityId"="orderId"::text)))) NOT VALID,
 ADD CONSTRAINT "AnalyticsOutbox_state_check" CHECK (
  "publicationState" IN ('unaccepted','ready','claimed','dispatching','published','quarantined','reconciliation_required','exhausted') AND
  (("publicationState" IN ('claimed','dispatching') AND num_nonnulls("claimToken","claimedAt","leaseExpiresAt")=3) OR
   ("publicationState" NOT IN ('claimed','dispatching') AND num_nonnulls("claimToken","claimedAt","leaseExpiresAt")=0)) AND
  ("publicationState"<>'dispatching' OR "dispatchStartedAt" IS NOT NULL) AND
  ("acceptedAt" IS NULL OR (("publicationState"='published')=("publishedAt" IS NOT NULL))) AND attempts>=0) NOT VALID;
CREATE FUNCTION cp_analytics_acceptance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."acceptedAt" IS NULL AND NEW."acceptedAt" IS NOT NULL THEN
  RAISE EXCEPTION 'Historical analytics acceptance cannot be adopted' USING ERRCODE='23514';
 END IF;
 IF OLD."acceptedAt" IS NOT NULL AND ROW(OLD."eventId",OLD.type,OLD."tenantScope",OLD."entityId",OLD."schemaVersion",OLD."occurredAt",OLD.payload,OLD."tenantId",OLD."companyId",OLD."orderId",OLD."ticketId",OLD."acceptedAt",OLD.capability,OLD."contentHash") IS DISTINCT FROM
 ROW(NEW."eventId",NEW.type,NEW."tenantScope",NEW."entityId",NEW."schemaVersion",NEW."occurredAt",NEW.payload,NEW."tenantId",NEW."companyId",NEW."orderId",NEW."ticketId",NEW."acceptedAt",NEW.capability,NEW."contentHash") THEN
  RAISE EXCEPTION 'Analytics acceptance is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AnalyticsOutbox_immutable_acceptance" BEFORE UPDATE ON "AnalyticsDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_analytics_acceptance_immutable();
