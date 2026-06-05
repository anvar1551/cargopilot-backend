/*
  Warnings:

  - The `actorRole` column on the `CashCollectionEvent` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `actorRole` column on the `Tracking` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "CashCollectionEvent" DROP COLUMN "actorRole",
ADD COLUMN     "actorRole" TEXT;

-- AlterTable
ALTER TABLE "Tracking" DROP COLUMN "actorRole",
ADD COLUMN     "actorRole" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'customer';

-- DropEnum
DROP TYPE "UserProfileType";

-- CreateIndex
CREATE INDEX "User_role_createdAt_idx" ON "User"("role", "createdAt");

-- CreateIndex
CREATE INDEX "User_role_warehouseId_createdAt_idx" ON "User"("role", "warehouseId", "createdAt");
