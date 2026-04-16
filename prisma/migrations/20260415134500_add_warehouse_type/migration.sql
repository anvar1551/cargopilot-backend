-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('warehouse', 'pickup_point');

-- AlterTable
ALTER TABLE "Warehouse"
ADD COLUMN "type" "WarehouseType" NOT NULL DEFAULT 'warehouse';
