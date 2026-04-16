-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('DOOR_TO_DOOR', 'DOOR_TO_POINT', 'POINT_TO_DOOR', 'POINT_TO_POINT');

-- AlterTable
ALTER TABLE "Order"
ALTER COLUMN "serviceType" TYPE "ServiceType"
USING (
  CASE
    WHEN "serviceType" IS NULL OR BTRIM("serviceType") = '' THEN NULL
    WHEN UPPER(REPLACE(REPLACE(BTRIM("serviceType"), '-', '_'), ' ', '_')) IN ('DOOR_TO_DOOR', 'EXPRESS', 'SAME_DAY', 'ECONOMY') THEN 'DOOR_TO_DOOR'
    WHEN UPPER(REPLACE(REPLACE(BTRIM("serviceType"), '-', '_'), ' ', '_')) = 'DOOR_TO_POINT' THEN 'DOOR_TO_POINT'
    WHEN UPPER(REPLACE(REPLACE(BTRIM("serviceType"), '-', '_'), ' ', '_')) = 'POINT_TO_DOOR' THEN 'POINT_TO_DOOR'
    WHEN UPPER(REPLACE(REPLACE(BTRIM("serviceType"), '-', '_'), ' ', '_')) = 'POINT_TO_POINT' THEN 'POINT_TO_POINT'
    ELSE 'DOOR_TO_DOOR'
  END
)::"ServiceType";
