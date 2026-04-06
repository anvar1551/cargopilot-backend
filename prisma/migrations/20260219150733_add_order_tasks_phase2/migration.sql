-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('pickup', 'linehaul', 'delivery');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('queued', 'assigned', 'dispatched', 'in_progress', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "OrderTask" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "warehouseId" UUID,
    "driverId" UUID,
    "assignedById" UUID,
    "dispatchedById" UUID,
    "startedById" UUID,
    "completedById" UUID,
    "failedById" UUID,
    "assignedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reasonCode" "ReasonCode",
    "note" TEXT,
    "region" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderTask_orderId_type_status_idx" ON "OrderTask"("orderId", "type", "status");

-- CreateIndex
CREATE INDEX "OrderTask_warehouseId_type_status_idx" ON "OrderTask"("warehouseId", "type", "status");

-- CreateIndex
CREATE INDEX "OrderTask_driverId_status_idx" ON "OrderTask"("driverId", "status");

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTask" ADD CONSTRAINT "OrderTask_failedById_fkey" FOREIGN KEY ("failedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
