ALTER TABLE "SupportTicket" ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "SupportTicket_sourceKey_key" ON "SupportTicket"("sourceKey");
CREATE INDEX "SupportTicket_sourceKey_idx" ON "SupportTicket"("sourceKey");
