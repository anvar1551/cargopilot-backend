-- Add warehouse map coordinates
ALTER TABLE "Warehouse"
ADD COLUMN "latitude" DOUBLE PRECISION,
ADD COLUMN "longitude" DOUBLE PRECISION;

-- Add driver type enum + field
CREATE TYPE "DriverType" AS ENUM ('local', 'linehaul');
ALTER TABLE "User"
ADD COLUMN "driverType" "DriverType";

UPDATE "User"
SET "driverType" = 'local'
WHERE "role" = 'driver' AND "driverType" IS NULL;

-- Add multi-warehouse access table for drivers
CREATE TABLE "DriverWarehouseAccess" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverWarehouseAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriverWarehouseAccess_driverId_warehouseId_key" ON "DriverWarehouseAccess"("driverId", "warehouseId");
CREATE INDEX "DriverWarehouseAccess_driverId_idx" ON "DriverWarehouseAccess"("driverId");
CREATE INDEX "DriverWarehouseAccess_warehouseId_idx" ON "DriverWarehouseAccess"("warehouseId");

ALTER TABLE "DriverWarehouseAccess"
ADD CONSTRAINT "DriverWarehouseAccess_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DriverWarehouseAccess"
ADD CONSTRAINT "DriverWarehouseAccess_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
