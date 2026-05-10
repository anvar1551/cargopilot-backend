"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSupportAutoTriage = runSupportAutoTriage;
exports.startSupportRulesWorker = startSupportRulesWorker;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const analyticsV2Realtime_1 = require("../manager/analyticsV2Realtime");
const supportService_1 = require("./supportService");
let started = false;
let running = false;
let debounceTimer = null;
function numberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
async function createStalePendingTickets() {
    const staleHours = numberFromEnv("SUPPORT_STALE_PENDING_HOURS", 24);
    const urgentHours = numberFromEnv("SUPPORT_URGENT_PENDING_HOURS", 48);
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);
    const urgentCutoff = new Date(Date.now() - urgentHours * 60 * 60 * 1000);
    const orders = await prismaClient_1.default.order.findMany({
        where: {
            status: { in: [client_1.OrderStatus.pending, client_1.OrderStatus.assigned] },
            createdAt: { lt: cutoff },
        },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            orderNumber: true,
            createdAt: true,
            status: true,
            pickupAddress: true,
            dropoffAddress: true,
        },
        take: numberFromEnv("SUPPORT_RULES_BATCH_SIZE", 50),
    });
    for (const order of orders) {
        const ageHours = Math.max(1, Math.floor((Date.now() - order.createdAt.getTime()) / 3600000));
        const priority = order.createdAt < urgentCutoff ? client_1.SupportTicketPriority.urgent : client_1.SupportTicketPriority.high;
        await (0, supportService_1.createSupportTicket)({
            orderId: order.id,
            title: order.status === client_1.OrderStatus.pending
                ? "Pending order needs dispatch action"
                : "Assigned order needs movement check",
            summary: `Order #${order.orderNumber} has been ${order.status} for ${ageHours}h. Route: ${order.pickupAddress || "-"} -> ${order.dropoffAddress || "-"}.`,
            priority,
            source: client_1.SupportTicketSource.system_alert,
            ownerId: null,
            sourceKey: `order:${order.id}:stale_${order.status}:v1`,
        }, {
            id: "",
            role: "manager",
            name: "CargoPilot Auto Triage",
            email: "system@cargopilot.local",
        });
    }
    return orders.length;
}
async function runSupportAutoTriage(reason = "manual") {
    if (running)
        return;
    running = true;
    try {
        const createdOrSeen = await createStalePendingTickets();
        if (createdOrSeen > 0) {
            console.log(`[support-rules] reason=${reason} staleOrders=${createdOrSeen}`);
        }
    }
    catch (err) {
        console.error(`[support-rules] failed: ${err?.message || "unknown"}`);
    }
    finally {
        running = false;
    }
}
function scheduleSupportAutoTriage(reason) {
    if (debounceTimer)
        clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void runSupportAutoTriage(reason);
    }, numberFromEnv("SUPPORT_RULES_DEBOUNCE_MS", 1500));
    debounceTimer.unref();
}
function startSupportRulesWorker() {
    if (started || process.env.SUPPORT_RULES_ENABLED === "false")
        return;
    started = true;
    (0, analyticsV2Realtime_1.subscribeAnalyticsInvalidation)((event) => {
        if (event.reason === "order_mutation" || event.reason === "worker_rebuild") {
            scheduleSupportAutoTriage(event.reason);
        }
    });
    const intervalMs = Math.max(60000, numberFromEnv("SUPPORT_RULES_INTERVAL_MS", 5 * 60 * 1000));
    const timer = setInterval(() => {
        void runSupportAutoTriage("interval");
    }, intervalMs);
    timer.unref();
    void runSupportAutoTriage("startup");
}
