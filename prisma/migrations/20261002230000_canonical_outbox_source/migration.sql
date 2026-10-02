-- Read-side authoritative source traversal. Optional sources remain transitional.
-- No historical ownership inference or certification; protect new/changed IDs only.
ALTER TABLE "IntegrationCanonicalEvent"
  ADD CONSTRAINT "IntegrationCanonicalEvent_outbox_source_fkey"
  FOREIGN KEY ("outboxId") REFERENCES "IntegrationOutbox" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
