-- Tracking retention helper (PostgreSQL)
--
-- This script creates an archive table and a batching function.
-- Call:
--   SELECT archive_tracking_batch(180, 50000);
-- repeatedly from a scheduler.

CREATE TABLE IF NOT EXISTS "TrackingArchive" (LIKE "Tracking" INCLUDING ALL);

CREATE INDEX IF NOT EXISTS "TrackingArchive_orderId_timestamp_idx"
  ON "TrackingArchive"("orderId", "timestamp");

CREATE INDEX IF NOT EXISTS "TrackingArchive_warehouseId_timestamp_idx"
  ON "TrackingArchive"("warehouseId", "timestamp");

CREATE OR REPLACE FUNCTION archive_tracking_batch(
  retention_days integer DEFAULT 180,
  batch_size integer DEFAULT 50000
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  moved_count integer := 0;
BEGIN
  WITH to_move AS (
    SELECT ctid
    FROM "Tracking"
    WHERE "timestamp" < now() - make_interval(days => retention_days)
    ORDER BY "timestamp" ASC
    LIMIT batch_size
  ), moved AS (
    DELETE FROM "Tracking" t
    USING to_move
    WHERE t.ctid = to_move.ctid
    RETURNING t.*
  )
  INSERT INTO "TrackingArchive"
  SELECT * FROM moved;

  GET DIAGNOSTICS moved_count = ROW_COUNT;
  RETURN moved_count;
END;
$$;
