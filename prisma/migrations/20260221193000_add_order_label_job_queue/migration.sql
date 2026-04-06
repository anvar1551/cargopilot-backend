-- CreateEnum
CREATE TYPE "OrderLabelJobStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "OrderLabelJob" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "OrderLabelJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "error" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLabelJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderLabelJob_orderId_key" ON "OrderLabelJob"("orderId");

-- CreateIndex
CREATE INDEX "OrderLabelJob_status_availableAt_idx" ON "OrderLabelJob"("status", "availableAt");

-- AddForeignKey
ALTER TABLE "OrderLabelJob" ADD CONSTRAINT "OrderLabelJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
