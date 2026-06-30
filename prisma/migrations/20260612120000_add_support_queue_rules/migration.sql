-- Add support as a first-class notification channel.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'support';

-- ERP support queues: company-scoped inboxes used by assignment rules.
CREATE TABLE IF NOT EXISTS "SupportQueue" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "defaultOrgId" UUID,
  "defaultOwnerId" UUID,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportQueue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SupportQueue_companyId_code_key"
  ON "SupportQueue"("companyId", "code");
CREATE INDEX IF NOT EXISTS "SupportQueue_companyId_isActive_idx"
  ON "SupportQueue"("companyId", "isActive");
CREATE INDEX IF NOT EXISTS "SupportQueue_companyId_isDefault_idx"
  ON "SupportQueue"("companyId", "isDefault");

ALTER TABLE "SupportQueue"
  ADD CONSTRAINT "SupportQueue_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportQueue"
  ADD CONSTRAINT "SupportQueue_defaultOrgId_fkey"
  FOREIGN KEY ("defaultOrgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ERP assignment rules: deterministic routing into queues and optional owners.
CREATE TABLE IF NOT EXISTS "SupportAssignmentRule" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "queueId" UUID,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "source" "SupportTicketSource",
  "priority" "SupportTicketPriority",
  "routeContains" TEXT,
  "defaultOwnerId" UUID,
  "conditionsJson" JSONB,
  "sortOrder" INTEGER NOT NULL DEFAULT 100,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportAssignmentRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SupportAssignmentRule_companyId_code_key"
  ON "SupportAssignmentRule"("companyId", "code");
CREATE INDEX IF NOT EXISTS "SupportAssignmentRule_companyId_isActive_sortOrder_idx"
  ON "SupportAssignmentRule"("companyId", "isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "SupportAssignmentRule_queueId_idx"
  ON "SupportAssignmentRule"("queueId");

ALTER TABLE "SupportAssignmentRule"
  ADD CONSTRAINT "SupportAssignmentRule_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportAssignmentRule"
  ADD CONSTRAINT "SupportAssignmentRule_queueId_fkey"
  FOREIGN KEY ("queueId") REFERENCES "SupportQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Attach support tickets to queues while keeping existing owner/org fields.
ALTER TABLE "SupportTicket"
  ADD COLUMN IF NOT EXISTS "queueId" UUID;

CREATE INDEX IF NOT EXISTS "SupportTicket_queueId_status_lastActivityAt_idx"
  ON "SupportTicket"("queueId", "status", "lastActivityAt");

ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_queueId_fkey"
  FOREIGN KEY ("queueId") REFERENCES "SupportQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
