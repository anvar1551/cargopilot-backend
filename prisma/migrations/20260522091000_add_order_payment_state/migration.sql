-- CreateEnum
CREATE TYPE "OrderPaymentState" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- AlterTable
ALTER TABLE "Order"
ADD COLUMN "paymentState" "OrderPaymentState" NOT NULL DEFAULT 'UNPAID';

-- CreateIndex
CREATE INDEX "Order_paymentState_createdAt_idx" ON "Order"("paymentState", "createdAt");
