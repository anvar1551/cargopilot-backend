/*
  Warnings:

  - You are about to drop the column `invoiceUrl` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `labelUrl` on the `Order` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "invoiceUrl",
ADD COLUMN     "invoiceKey" TEXT;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "labelUrl",
ADD COLUMN     "labelKey" TEXT;
