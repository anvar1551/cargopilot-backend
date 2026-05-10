-- Speed up manager live-map snapshot reads.
CREATE INDEX IF NOT EXISTS "User_role_createdAt_idx" ON "User"("role", "createdAt");
CREATE INDEX IF NOT EXISTS "User_role_warehouseId_createdAt_idx" ON "User"("role", "warehouseId", "createdAt");
CREATE INDEX IF NOT EXISTS "Warehouse_createdAt_idx" ON "Warehouse"("createdAt");
CREATE INDEX IF NOT EXISTS "Warehouse_latitude_longitude_idx" ON "Warehouse"("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "Order_currentWarehouseId_status_updatedAt_idx" ON "Order"("currentWarehouseId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "Order_currentWarehouseId_updatedAt_idx" ON "Order"("currentWarehouseId", "updatedAt");
CREATE INDEX IF NOT EXISTS "Order_pickupLat_pickupLng_idx" ON "Order"("pickupLat", "pickupLng");
CREATE INDEX IF NOT EXISTS "Order_dropoffLat_dropoffLng_idx" ON "Order"("dropoffLat", "dropoffLng");