/*
  Warnings:

  - The `status` column on the `Invoice` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `shipmentId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `shipmentId` on the `Parcel` table. All the data in the column will be lost.
  - You are about to drop the `Shipment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ShipmentTracking` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[orderNumber]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[orderId,pieceNo]` on the table `Parcel` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `orderNumber` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orderId` to the `Parcel` table without a default value. This is not possible if the table is not empty.
  - Made the column `event` on table `Tracking` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('pending', 'paid', 'cancelled');

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_shipmentId_fkey";

-- DropForeignKey
ALTER TABLE "Parcel" DROP CONSTRAINT "Parcel_shipmentId_fkey";

-- DropForeignKey
ALTER TABLE "Shipment" DROP CONSTRAINT "Shipment_assignedDriverId_fkey";

-- DropForeignKey
ALTER TABLE "Shipment" DROP CONSTRAINT "Shipment_currentWarehouseId_fkey";

-- DropForeignKey
ALTER TABLE "Shipment" DROP CONSTRAINT "Shipment_customerId_fkey";

-- DropForeignKey
ALTER TABLE "ShipmentTracking" DROP CONSTRAINT "ShipmentTracking_actorId_fkey";

-- DropForeignKey
ALTER TABLE "ShipmentTracking" DROP CONSTRAINT "ShipmentTracking_shipmentId_fkey";

-- DropForeignKey
ALTER TABLE "ShipmentTracking" DROP CONSTRAINT "ShipmentTracking_warehouseId_fkey";

-- DropIndex
DROP INDEX "Parcel_shipmentId_pieceNo_key";

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "status",
ADD COLUMN     "status" "InvoiceStatus" NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "shipmentId",
ADD COLUMN     "codAmount" DOUBLE PRECISION,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "destinationCity" TEXT,
ADD COLUMN     "orderNumber" TEXT NOT NULL,
ADD COLUMN     "receiverAddress" TEXT,
ADD COLUMN     "receiverName" TEXT,
ADD COLUMN     "receiverPhone" TEXT,
ADD COLUMN     "senderAddress" TEXT,
ADD COLUMN     "senderName" TEXT,
ADD COLUMN     "senderPhone" TEXT,
ADD COLUMN     "serviceType" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "weightKg" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Parcel" DROP COLUMN "shipmentId",
ADD COLUMN     "orderId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "Tracking" ADD COLUMN     "parcelId" UUID,
ALTER COLUMN "event" SET NOT NULL,
ALTER COLUMN "status" DROP NOT NULL;

-- DropTable
DROP TABLE "Shipment";

-- DropTable
DROP TABLE "ShipmentTracking";

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Parcel_orderId_pieceNo_key" ON "Parcel"("orderId", "pieceNo");

-- CreateIndex
CREATE INDEX "Tracking_parcelId_idx" ON "Tracking"("parcelId");

-- AddForeignKey
ALTER TABLE "Tracking" ADD CONSTRAINT "Tracking_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "Parcel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
