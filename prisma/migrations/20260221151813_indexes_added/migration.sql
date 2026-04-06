-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_currentWarehouseId_status_createdAt_idx" ON "Order"("currentWarehouseId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_assignedDriverId_status_createdAt_idx" ON "Order"("assignedDriverId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Tracking_warehouseId_timestamp_idx" ON "Tracking"("warehouseId", "timestamp");
