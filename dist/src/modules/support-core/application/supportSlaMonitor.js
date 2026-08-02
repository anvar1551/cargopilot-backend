"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSupportSlaMonitor = runSupportSlaMonitor;
exports.startSupportSlaMonitorWorker = startSupportSlaMonitorWorker;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const notificationService_1 = require("../../notifications-core/application/notificationService");
const supportCache_1 = require("../infrastructure/supportCache");
const supportRealtime_1 = require("../realtime/supportRealtime");
let started = false;
let running = false;
let lastErrorLogAt = 0;
function numberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
function formatTicketLabel(ticket) {
    const ticketNumber = String(ticket.ticketNumber || "").trim();
    const title = String(ticket.title || "").trim();
    return ticketNumber ? `${ticketNumber}${title ? `: ${title}` : ""}` : title || "Support ticket";
}
async function notifyOwner(args) {
    const userId = String(args.userId || "").trim();
    if (!userId)
        return;
    await (0, notificationService_1.createUserNotification)({
        userId,
        type: client_1.NotificationType.support,
        title: "Support SLA overdue",
        body: `${formatTicketLabel(args)} is overdue and has been escalated.`,
        orderId: args.orderId ?? null,
        data: {
            ticketId: args.ticketId,
            ticketNumber: args.ticketNumber ?? null,
            reason: "sla_overdue",
        },
    }).catch((err) => {
        console.error(`[support-sla] notification failed: ${err?.message || "unknown"}`);
    });
}
async function runSupportSlaMonitor(reason = "manual") {
    if (running || process.env.SUPPORT_SLA_MONITOR_ENABLED === "false")
        return 0;
    running = true;
    try {
        const now = new Date();
        const batchSize = Math.min(200, Math.max(1, numberFromEnv("SUPPORT_SLA_MONITOR_BATCH_SIZE", 50)));
        const dueTickets = await prismaClient_1.default.supportTicket.findMany({
            where: {
                archivedAt: null,
                slaDueAt: { lte: now },
                status: {
                    notIn: [
                        client_1.SupportTicketStatus.escalated,
                        client_1.SupportTicketStatus.resolved,
                    ],
                },
            },
            orderBy: [{ slaDueAt: "asc" }, { createdAt: "asc" }],
            take: batchSize,
            select: {
                id: true,
                ticketNumber: true,
                title: true,
                orderId: true,
                ownerId: true,
                slaDueAt: true,
                queue: {
                    select: {
                        defaultOwnerId: true,
                    },
                },
            },
        });
        let escalated = 0;
        for (const ticket of dueTickets) {
            const updated = await prismaClient_1.default.$transaction(async (tx) => {
                const result = await tx.supportTicket.updateMany({
                    where: {
                        id: ticket.id,
                        archivedAt: null,
                        slaDueAt: { lte: now },
                        status: {
                            notIn: [
                                client_1.SupportTicketStatus.escalated,
                                client_1.SupportTicketStatus.resolved,
                            ],
                        },
                    },
                    data: {
                        status: client_1.SupportTicketStatus.escalated,
                        slaPercent: 0,
                        lastActivityAt: now,
                    },
                });
                if (result.count !== 1)
                    return false;
                await tx.supportTicketEvent.create({
                    data: {
                        ticketId: ticket.id,
                        eventType: client_1.SupportTicketEventType.escalated,
                        actorId: null,
                        actorName: "CargoPilot SLA Monitor",
                        body: "Ticket escalated automatically because SLA is overdue",
                        metadata: {
                            reason: "sla_overdue",
                            dueAt: ticket.slaDueAt?.toISOString?.() ?? null,
                            monitorReason: reason,
                        },
                    },
                });
                return true;
            });
            if (!updated)
                continue;
            escalated += 1;
            await notifyOwner({
                userId: ticket.ownerId ?? ticket.queue?.defaultOwnerId ?? null,
                ticketId: ticket.id,
                ticketNumber: ticket.ticketNumber,
                title: ticket.title,
                orderId: ticket.orderId,
            });
            await (0, supportRealtime_1.publishSupportRefresh)("ticket_updated", {
                ticketId: ticket.id,
                keys: ["list", "summary", "detail"],
            });
        }
        if (escalated > 0) {
            await (0, supportCache_1.invalidateSupportCache)();
            console.log(`[support-sla] reason=${reason} escalated=${escalated}`);
        }
        return escalated;
    }
    catch (err) {
        const now = Date.now();
        if (now - lastErrorLogAt >= 30000) {
            lastErrorLogAt = now;
            console.error(`[support-sla] failed: ${err?.message || "unknown"}`);
        }
        return 0;
    }
    finally {
        running = false;
    }
}
function startSupportSlaMonitorWorker() {
    if (started || process.env.SUPPORT_SLA_MONITOR_ENABLED === "false")
        return;
    started = true;
    const intervalMs = Math.max(60000, numberFromEnv("SUPPORT_SLA_MONITOR_INTERVAL_MS", 2 * 60000));
    const timer = setInterval(() => {
        void runSupportSlaMonitor("interval");
    }, intervalMs);
    timer.unref();
    void runSupportSlaMonitor("startup");
}
