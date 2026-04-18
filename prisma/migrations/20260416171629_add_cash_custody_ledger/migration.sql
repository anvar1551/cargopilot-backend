-- CreateEnum
CREATE TYPE "CashCollectionKind" AS ENUM ('cod', 'service_charge');

-- CreateEnum
CREATE TYPE "CashCollectionStatus" AS ENUM ('expected', 'held', 'settled', 'cancelled');

-- CreateEnum
CREATE TYPE "CashHolderType" AS ENUM ('none', 'driver', 'warehouse', 'pickup_point', 'finance');

-- CreateEnum
CREATE TYPE "CashCollectionEventType" AS ENUM ('expected', 'collected', 'handoff', 'settled', 'adjusted', 'cancelled');

-- CreateTable
CREATE TABLE "CashCollection" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "CashCollectionKind" NOT NULL,
    "status" "CashCollectionStatus" NOT NULL DEFAULT 'expected',
    "expectedAmount" DOUBLE PRECISION NOT NULL,
    "collectedAmount" DOUBLE PRECISION,
    "currency" TEXT,
    "currentHolderType" "CashHolderType" NOT NULL DEFAULT 'none',
    "currentHolderUserId" UUID,
    "currentHolderWarehouseId" UUID,
    "currentHolderLabel" TEXT,
    "collectedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashCollectionEvent" (
    "id" UUID NOT NULL,
    "cashCollectionId" UUID NOT NULL,
    "eventType" "CashCollectionEventType" NOT NULL,
    "amount" DOUBLE PRECISION,
    "note" TEXT,
    "fromHolderType" "CashHolderType",
    "fromHolderId" TEXT,
    "fromHolderName" TEXT,
    "toHolderType" "CashHolderType",
    "toHolderId" TEXT,
    "toHolderName" TEXT,
    "actorId" UUID,
    "actorRole" "AppRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashCollectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashCollection_status_idx" ON "CashCollection"("status");

-- CreateIndex
CREATE INDEX "CashCollection_currentHolderType_status_idx" ON "CashCollection"("currentHolderType", "status");

-- CreateIndex
CREATE INDEX "CashCollection_currentHolderUserId_status_idx" ON "CashCollection"("currentHolderUserId", "status");

-- CreateIndex
CREATE INDEX "CashCollection_currentHolderWarehouseId_status_idx" ON "CashCollection"("currentHolderWarehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CashCollection_orderId_kind_key" ON "CashCollection"("orderId", "kind");

-- CreateIndex
CREATE INDEX "CashCollectionEvent_cashCollectionId_createdAt_idx" ON "CashCollectionEvent"("cashCollectionId", "createdAt");

-- CreateIndex
CREATE INDEX "CashCollectionEvent_actorId_createdAt_idx" ON "CashCollectionEvent"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "CashCollection" ADD CONSTRAINT "CashCollection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCollection" ADD CONSTRAINT "CashCollection_currentHolderUserId_fkey" FOREIGN KEY ("currentHolderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCollection" ADD CONSTRAINT "CashCollection_currentHolderWarehouseId_fkey" FOREIGN KEY ("currentHolderWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCollectionEvent" ADD CONSTRAINT "CashCollectionEvent_cashCollectionId_fkey" FOREIGN KEY ("cashCollectionId") REFERENCES "CashCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCollectionEvent" ADD CONSTRAINT "CashCollectionEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
