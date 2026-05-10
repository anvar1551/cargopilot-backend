-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('urgent', 'high', 'normal');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('open', 'waiting_customer', 'waiting_driver', 'escalated', 'resolved');

-- CreateEnum
CREATE TYPE "SupportTicketSource" AS ENUM ('customer_chat', 'driver_app', 'system_alert', 'manager');

-- CreateEnum
CREATE TYPE "SupportTicketAuthorType" AS ENUM ('customer', 'driver', 'support', 'system');

-- CreateEnum
CREATE TYPE "SupportTicketEventType" AS ENUM ('created', 'status_changed', 'assigned', 'note_added', 'message_added', 'escalated', 'resolved', 'archived', 'system');

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" UUID NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "orderId" UUID,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'normal',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'open',
    "source" "SupportTicketSource" NOT NULL DEFAULT 'manager',
    "customerUserId" UUID,
    "customerEntityId" UUID,
    "driverId" UUID,
    "warehouseId" UUID,
    "ownerId" UUID,
    "ownerName" TEXT,
    "customerName" TEXT,
    "companyName" TEXT,
    "routeSnapshot" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "warehouseLabel" TEXT,
    "lastMessage" TEXT,
    "lastReplyBy" "SupportTicketAuthorType",
    "slaPercent" INTEGER NOT NULL DEFAULT 100,
    "slaDueAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketMessage" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorType" "SupportTicketAuthorType" NOT NULL,
    "authorId" UUID,
    "authorName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketNote" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "actorId" UUID,
    "actorName" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketEvent" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "eventType" "SupportTicketEventType" NOT NULL,
    "actorId" UUID,
    "actorName" TEXT,
    "body" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_ticketNumber_key" ON "SupportTicket"("ticketNumber");

-- CreateIndex
CREATE INDEX "SupportTicket_status_lastActivityAt_idx" ON "SupportTicket"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SupportTicket_ownerId_status_lastActivityAt_idx" ON "SupportTicket"("ownerId", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SupportTicket_archivedAt_status_lastActivityAt_idx" ON "SupportTicket"("archivedAt", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SupportTicket_orderId_idx" ON "SupportTicket"("orderId");

-- CreateIndex
CREATE INDEX "SupportTicket_priority_status_lastActivityAt_idx" ON "SupportTicket"("priority", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SupportTicket_source_status_lastActivityAt_idx" ON "SupportTicket"("source", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SupportTicket_slaDueAt_idx" ON "SupportTicket"("slaDueAt");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_idx" ON "SupportTicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_authorId_createdAt_idx" ON "SupportTicketMessage"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketNote_ticketId_createdAt_idx" ON "SupportTicketNote"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketNote_actorId_createdAt_idx" ON "SupportTicketNote"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketEvent_ticketId_createdAt_idx" ON "SupportTicketEvent"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketEvent_eventType_createdAt_idx" ON "SupportTicketEvent"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "SupportTicket"
ADD CONSTRAINT "SupportTicket_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage"
ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey"
FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketNote"
ADD CONSTRAINT "SupportTicketNote_ticketId_fkey"
FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketEvent"
ADD CONSTRAINT "SupportTicketEvent_ticketId_fkey"
FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
