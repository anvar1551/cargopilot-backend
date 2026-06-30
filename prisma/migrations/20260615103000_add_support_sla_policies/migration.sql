CREATE TABLE "SupportSlaPolicy" (
  "id" UUID NOT NULL DEFAULT public.uuid_generate_v7(),
  "companyId" UUID NOT NULL,
  "queueId" UUID,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "priority" "SupportTicketPriority" NOT NULL,
  "targetMinutes" INTEGER NOT NULL,
  "warningMinutes" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportSlaPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportSlaPolicy_companyId_code_key"
  ON "SupportSlaPolicy"("companyId", "code");

CREATE INDEX "SupportSlaPolicy_companyId_queueId_priority_isActive_idx"
  ON "SupportSlaPolicy"("companyId", "queueId", "priority", "isActive");

ALTER TABLE "SupportSlaPolicy"
  ADD CONSTRAINT "SupportSlaPolicy_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportSlaPolicy"
  ADD CONSTRAINT "SupportSlaPolicy_queueId_fkey"
  FOREIGN KEY ("queueId") REFERENCES "SupportQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
