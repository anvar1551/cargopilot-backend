/*
  Warnings:

  - You are about to drop the column `action` on the `Tracking` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Tracking" DROP COLUMN "action";

-- DropEnum
DROP TYPE "TrackingAction";
