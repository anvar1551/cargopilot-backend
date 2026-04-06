/*
  Warnings:

  - You are about to drop the `OrderTask` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_assignedById_fkey";

-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_completedById_fkey";

-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_dispatchedById_fkey";

-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_driverId_fkey";

-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_failedById_fkey";

-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_orderId_fkey";

-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_startedById_fkey";

-- DropForeignKey
ALTER TABLE "OrderTask" DROP CONSTRAINT "OrderTask_warehouseId_fkey";

-- DropTable
DROP TABLE "OrderTask";

-- DropEnum
DROP TYPE "TaskStatus";

-- DropEnum
DROP TYPE "TaskType";
