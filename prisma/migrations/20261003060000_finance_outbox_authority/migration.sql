-- Additive: no historical adoption, backfill or certification.
ALTER TABLE "FinanceDomainEventOutbox"
 ADD COLUMN "tenantId" uuid, ADD COLUMN "companyId" uuid,
 ADD COLUMN "accountId" uuid, ADD COLUMN "installationId" uuid, ADD COLUMN "journalId" uuid,
 ADD COLUMN "acceptedAt" timestamp(3), ADD COLUMN "capability" text, ADD COLUMN "contentHash" text,
 ADD COLUMN "publicationState" text NOT NULL DEFAULT 'unaccepted',
 ADD COLUMN "claimToken" uuid, ADD COLUMN "leaseExpiresAt" timestamp(3), ADD COLUMN "dispatchStartedAt" timestamp(3);
CREATE UNIQUE INDEX "FinanceChartInstallation_entity_identity_key" ON "FinanceChartTemplateInstallation" ("legalEntityId",id);
CREATE INDEX "FinanceOutbox_owner_state_idx" ON "FinanceDomainEventOutbox" ("tenantId","companyId","publicationState","nextAttemptAt");
CREATE INDEX "FinanceOutbox_claim_idx" ON "FinanceDomainEventOutbox" ("publicationState","nextAttemptAt","createdAt");
ALTER TABLE "FinanceDomainEventOutbox"
 ADD CONSTRAINT "FinanceOutbox_owner_fkey" FOREIGN KEY ("legalEntityId","tenantId","companyId") REFERENCES "FinanceLegalEntity" (id,"tenantId","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "FinanceOutbox_account_fkey" FOREIGN KEY ("legalEntityId","accountId") REFERENCES "FinanceAccount" ("legalEntityId",id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "FinanceOutbox_chart_fkey" FOREIGN KEY ("legalEntityId","installationId") REFERENCES "FinanceChartTemplateInstallation" ("legalEntityId",id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "FinanceOutbox_journal_fkey" FOREIGN KEY ("journalId","legalEntityId") REFERENCES "FinanceJournalEntry" (id,"legalEntityId") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
 ADD CONSTRAINT "FinanceOutbox_acceptance_check" CHECK (
  ("acceptedAt" IS NULL AND num_nonnulls("tenantId","companyId","accountId","installationId","journalId",capability,"contentHash")=0 AND "publicationState"='unaccepted') OR
  ("acceptedAt" IS NOT NULL AND "tenantId" IS NOT NULL AND "companyId" IS NOT NULL AND capability IS NOT NULL
   AND "contentHash" IS NOT NULL AND "contentHash" ~ '^[a-f0-9]{64}$' AND "schemaVersion"=1 AND "payloadJson"='{}'::jsonb
   AND "publicationState"<>'unaccepted' AND num_nonnulls("accountId","installationId","journalId")=1 AND
   ((capability='account_invalidation' AND "eventType"='finance.account.created' AND "aggregateType"='finance_account' AND "accountId" IS NOT NULL AND "aggregateId"="accountId") OR
    (capability='chart_invalidation' AND "eventType"='finance.chart_template.installed' AND "aggregateType"='finance_chart_template' AND "installationId" IS NOT NULL AND "aggregateId"="installationId") OR
    (capability='draft_invalidation' AND "eventType"='finance.journal.draft_created' AND "aggregateType"='finance_journal' AND "journalId" IS NOT NULL AND "aggregateId"="journalId")))) NOT VALID,
 ADD CONSTRAINT "FinanceOutbox_state_check" CHECK (
  "publicationState" IN ('unaccepted','ready','claimed','dispatching','published','quarantined','reconciliation_required','exhausted') AND
  ("acceptedAt" IS NULL OR (
   "claimedBy" IS NULL AND attempts BETWEEN 0 AND 8 AND
   (("publicationState" IN ('claimed','dispatching') AND num_nonnulls("claimToken","claimedAt","leaseExpiresAt")=3 AND "leaseExpiresAt">"claimedAt") OR
    ("publicationState" NOT IN ('claimed','dispatching') AND num_nonnulls("claimToken","claimedAt","leaseExpiresAt")=0)) AND
   ("publicationState"<>'dispatching' OR "dispatchStartedAt" IS NOT NULL) AND
   ("publicationState" NOT IN ('ready','claimed','exhausted','quarantined') OR "dispatchStartedAt" IS NULL) AND
   (("publicationState"='published')=("publishedAt" IS NOT NULL))))) NOT VALID;
CREATE FUNCTION cp_finance_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."acceptedAt" IS NULL AND NEW."acceptedAt" IS NOT NULL THEN
  RAISE EXCEPTION 'Historical finance publication cannot be adopted' USING ERRCODE='23514';
 END IF;
 IF OLD."acceptedAt" IS NOT NULL AND ROW(OLD.id,OLD."eventId",OLD."legalEntityId",OLD."tenantId",OLD."companyId",OLD."accountId",OLD."installationId",OLD."journalId",OLD."aggregateType",OLD."aggregateId",OLD."eventType",OLD."schemaVersion",OLD."occurredAt",OLD."payloadJson",OLD."acceptedAt",OLD.capability,OLD."contentHash") IS DISTINCT FROM
 ROW(NEW.id,NEW."eventId",NEW."legalEntityId",NEW."tenantId",NEW."companyId",NEW."accountId",NEW."installationId",NEW."journalId",NEW."aggregateType",NEW."aggregateId",NEW."eventType",NEW."schemaVersion",NEW."occurredAt",NEW."payloadJson",NEW."acceptedAt",NEW.capability,NEW."contentHash") THEN
  RAISE EXCEPTION 'Finance publication acceptance is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."acceptedAt" IS NOT NULL AND
  ((OLD."publicationState" IN ('dispatching','published','reconciliation_required') AND NEW."publicationState" NOT IN ('dispatching','published','reconciliation_required')) OR
   (OLD."publicationState" IN ('published','quarantined','exhausted','reconciliation_required') AND NEW."publicationState"<>OLD."publicationState")) THEN
  RAISE EXCEPTION 'Finance publication cannot be automatically replayed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "FinanceOutbox_immutable_acceptance" BEFORE UPDATE ON "FinanceDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_finance_publication_immutable();
