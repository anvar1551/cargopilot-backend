DO $$
BEGIN
  -- This migration may run before OrderLabelJob exists on clean databases.
  IF to_regclass('public."OrderLabelJob"') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'OrderLabelJob_orderId_fkey'
      AND conrelid = 'public."OrderLabelJob"'::regclass
  ) THEN
    ALTER TABLE "OrderLabelJob" DROP CONSTRAINT "OrderLabelJob_orderId_fkey";
  END IF;

  ALTER TABLE "OrderLabelJob"
    ADD CONSTRAINT "OrderLabelJob_orderId_fkey"
    FOREIGN KEY ("orderId")
    REFERENCES "Order"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
END $$;
