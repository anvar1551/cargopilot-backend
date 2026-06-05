import { OrderStatus, SupportTicketPriority, SupportTicketSource } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { subscribeAnalyticsInvalidation } from "../../analytics-core/realtime/analyticsV2Realtime";
import { createSupportTicket } from "./supportService";

let started = false;
let running = false;
let debounceTimer: NodeJS.Timeout | null = null;
const infoLogState = new Map<string, number>();
let lastErrorLogAt = 0;

function numberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function shouldLogInfo(reason: string) {
  const minIntervalMs = Math.max(
    10_000,
    numberFromEnv("SUPPORT_RULES_LOG_MIN_INTERVAL_MS", 5 * 60_000),
  );
  const now = Date.now();
  const last = infoLogState.get(reason) ?? 0;
  if (now - last < minIntervalMs) return false;
  infoLogState.set(reason, now);
  return true;
}

async function createStalePendingTickets() {
  const staleHours = numberFromEnv("SUPPORT_STALE_PENDING_HOURS", 24);
  const urgentHours = numberFromEnv("SUPPORT_URGENT_PENDING_HOURS", 48);
  const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);
  const urgentCutoff = new Date(Date.now() - urgentHours * 60 * 60 * 1000);

  const orders = await prisma.order.findMany({
    where: {
      status: { in: [OrderStatus.pending, OrderStatus.assigned] },
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
    const ageHours = Math.max(1, Math.floor((Date.now() - order.createdAt.getTime()) / 3_600_000));
    const priority =
      order.createdAt < urgentCutoff ? SupportTicketPriority.urgent : SupportTicketPriority.high;
    await createSupportTicket(
      {
        orderId: order.id,
        title: order.status === OrderStatus.pending
          ? "Pending order needs dispatch action"
          : "Assigned order needs movement check",
        summary: `Order #${order.orderNumber} has been ${order.status} for ${ageHours}h. Route: ${order.pickupAddress || "-"} -> ${order.dropoffAddress || "-"}.`,
        priority,
        source: SupportTicketSource.system_alert,
        ownerId: null,
        sourceKey: `order:${order.id}:stale_${order.status}:v1`,
      },
      {
        id: "",
        roleCodes: ["manager"],
        permissionCodes: [],
        name: "CargoPilot Auto Triage",
        email: "system@cargopilot.local",
      },
    );
  }

  return orders.length;
}

export async function runSupportAutoTriage(reason = "manual") {
  if (running) return;
  running = true;
  try {
    const createdOrSeen = await createStalePendingTickets();
    if (createdOrSeen > 0 && shouldLogInfo(reason)) {
      console.log(`[support-rules] reason=${reason} staleOrders=${createdOrSeen}`);
    }
  } catch (err: any) {
    const now = Date.now();
    if (now - lastErrorLogAt >= 30_000) {
      lastErrorLogAt = now;
      console.error(`[support-rules] failed: ${err?.message || "unknown"}`);
    }
  } finally {
    running = false;
  }
}

function scheduleSupportAutoTriage(reason: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSupportAutoTriage(reason);
  }, numberFromEnv("SUPPORT_RULES_DEBOUNCE_MS", 1500));
  debounceTimer.unref();
}

export function startSupportRulesWorker() {
  if (started || process.env.SUPPORT_RULES_ENABLED === "false") return;
  started = true;

  subscribeAnalyticsInvalidation((event) => {
    const includeWorkerRebuild = process.env.SUPPORT_RULES_TRIGGER_ON_WORKER_REBUILD === "true";
    if (
      event.reason === "order_mutation" ||
      (includeWorkerRebuild && event.reason === "worker_rebuild")
    ) {
      scheduleSupportAutoTriage(event.reason);
    }
  });

  const intervalMs = Math.max(
    60_000,
    numberFromEnv("SUPPORT_RULES_INTERVAL_MS", 5 * 60 * 1000),
  );
  const timer = setInterval(() => {
    void runSupportAutoTriage("interval");
  }, intervalMs);
  timer.unref();

  void runSupportAutoTriage("startup");
}
