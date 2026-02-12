-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastExceptionAt" TIMESTAMP(3),
ADD COLUMN     "lastExceptionReason" "ReasonCode",
ADD COLUMN     "pickupAttemptCount" INTEGER NOT NULL DEFAULT 0;
