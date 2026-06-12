-- RenameIndex
-- This migration originally assumed the old index already existed.
-- Shadow database replay starts from an empty schema, so guard the rename.
DO $$
BEGIN
  IF to_regclass('public."IntegrationCanonicalEvent_aggregateType_aggregateId_eventType_i"') IS NOT NULL
     AND to_regclass('public."IntegrationCanonicalEvent_aggregateType_aggregateId_eventTy_idx"') IS NULL THEN
    ALTER INDEX "IntegrationCanonicalEvent_aggregateType_aggregateId_eventType_i"
      RENAME TO "IntegrationCanonicalEvent_aggregateType_aggregateId_eventTy_idx";
  END IF;
END $$;
