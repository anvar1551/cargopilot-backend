-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('RESIDENTIAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('CASH', 'CARD', 'COD', 'TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "PaidBy" AS ENUM ('SENDER', 'RECIPIENT', 'COMPANY');

-- CreateEnum
CREATE TYPE "PaidStatus" AS ENUM ('NOT_PAID', 'PAID', 'PARTIAL');

-- CreateEnum
CREATE TYPE "RecipientUnavailableAction" AS ENUM ('DO_NOT_DELIVER', 'LEAVE_AT_DOOR', 'LEAVE_WITH_CONCIERGE', 'CALL_SENDER', 'RESCHEDULE', 'RETURN_TO_SENDER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "codPaidStatus" "PaidStatus",
ADD COLUMN     "customerEntityId" UUID,
ADD COLUMN     "dangerousGoods" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deliveryChargePaidBy" "PaidBy",
ADD COLUMN     "fragile" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ifRecipientNotAvailable" "RecipientUnavailableAction",
ADD COLUMN     "itemValue" DOUBLE PRECISION,
ADD COLUMN     "numberOfCalls" INTEGER,
ADD COLUMN     "paymentType" "PaymentType",
ADD COLUMN     "plannedDeliveryAt" TIMESTAMP(3),
ADD COLUMN     "plannedPickupAt" TIMESTAMP(3),
ADD COLUMN     "promiseDate" TIMESTAMP(3),
ADD COLUMN     "promoCode" TEXT,
ADD COLUMN     "receiverAddressId" UUID,
ADD COLUMN     "referenceId" TEXT,
ADD COLUMN     "senderAddressId" UUID,
ADD COLUMN     "serviceCharge" DOUBLE PRECISION,
ADD COLUMN     "serviceChargePaidStatus" "PaidStatus",
ADD COLUMN     "shelfId" TEXT,
ADD COLUMN     "shipmentInsurance" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "customerEntityId" UUID;

-- CreateTable
CREATE TABLE "Address" (
    "id" UUID NOT NULL,
    "customerEntityId" UUID,
    "country" TEXT,
    "city" TEXT,
    "neighborhood" TEXT,
    "street" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "building" TEXT,
    "apartment" TEXT,
    "floor" TEXT,
    "landmark" TEXT,
    "postalCode" TEXT,
    "addressType" "AddressType",
    "passportSeries" TEXT,
    "passportNumber" TEXT,
    "isSaved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEntity" (
    "id" UUID NOT NULL,
    "type" "CustomerType" NOT NULL DEFAULT 'PERSON',
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "altPhone1" TEXT,
    "altPhone2" TEXT,
    "companyName" TEXT,
    "taxId" TEXT,
    "defaultAddressId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAttachment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Address_customerEntityId_idx" ON "Address"("customerEntityId");

-- CreateIndex
CREATE INDEX "Address_city_idx" ON "Address"("city");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEntity_defaultAddressId_key" ON "CustomerEntity"("defaultAddressId");

-- CreateIndex
CREATE INDEX "CustomerEntity_type_idx" ON "CustomerEntity"("type");

-- CreateIndex
CREATE INDEX "CustomerEntity_name_idx" ON "CustomerEntity"("name");

-- CreateIndex
CREATE INDEX "OrderAttachment_orderId_idx" ON "OrderAttachment"("orderId");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_assignedDriverId_idx" ON "Order"("assignedDriverId");

-- CreateIndex
CREATE INDEX "Order_currentWarehouseId_idx" ON "Order"("currentWarehouseId");

-- CreateIndex
CREATE INDEX "Order_customerEntityId_idx" ON "Order"("customerEntityId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_customerEntityId_fkey" FOREIGN KEY ("customerEntityId") REFERENCES "CustomerEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerEntityId_fkey" FOREIGN KEY ("customerEntityId") REFERENCES "CustomerEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_senderAddressId_fkey" FOREIGN KEY ("senderAddressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_receiverAddressId_fkey" FOREIGN KEY ("receiverAddressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_customerEntityId_fkey" FOREIGN KEY ("customerEntityId") REFERENCES "CustomerEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEntity" ADD CONSTRAINT "CustomerEntity_defaultAddressId_fkey" FOREIGN KEY ("defaultAddressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAttachment" ADD CONSTRAINT "OrderAttachment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
