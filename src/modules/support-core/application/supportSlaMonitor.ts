import {
  NotificationType,
  SupportTicketEventType,
  SupportTicketStatus,
} from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { createUserNotification } from "../../notifications-core/application/notificationService";
import { invalidateSupportCache } from "../infrastructure/supportCache";
import { publishSupportRefresh } from "../realtime/supportRealtime";

let started = false;
let running = false;
let lastErrorLogAt = 0;

function numberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatTicketLabel(ticket: { ticketNumber?: string | null; title?: string | null }) {
  const ticketNumber = String(ticket.ticketNumber || "").trim();
  const title = String(ticket.title || "").trim();
  return ticketNumber ? `${ticketNumber}${title ? `: ${title}` : ""}` : title || "Support ticket";
}

async function notifyOwner(args: {
  userId?: string | null;
  ticketId: string;
  ticketNumber?: string | null;
  title: string;
  orderId?: string | null;
}) {
  const userId = String(args.userId || "").trim();
  if (!userId) return;
  await createUserNotification({
    userId,
    type: NotificationType.support,
    title: "Support SLA overdue",
    body: `${formatTicketLabel(args)} is overdue and has been escalated.`,
    orderId: args.orderId ?? null,
    data: {
      ticketId: args.ticketId,
      ticketNumber: args.ticketNumber ?? null,
      reason: "sla_overdue",
    },
  }).catch((err: any) => {
    console.error(`[support-sla] notification failed: ${err?.message || "unknown"}`);
  });
}

export async function runSupportSlaMonitor(reason = "manual") {
  if (running || process.env.SUPPORT_SLA_MONITOR_ENABLED === "false") return 0;
  running = true;
  try {
    const now = new Date();
    const batchSize = Math.min(200, Math.max(1, numberFromEnv("SUPPORT_SLA_MONITOR_BATCH_SIZE", 50)));
    const dueTickets = await prisma.supportTicket.findMany({
      where: {
        archivedAt: null,
        slaDueAt: { lte: now },
        status: {
          notIn: [
            SupportTicketStatus.escalated,
            SupportTicketStatus.resolved,
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
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.supportTicket.updateMany({
          where: {
            id: ticket.id,
            archivedAt: null,
            slaDueAt: { lte: now },
            status: {
              notIn: [
                SupportTicketStatus.escalated,
                SupportTicketStatus.resolved,
              ],
            },
          },
          data: {
            status: SupportTicketStatus.escalated,
            slaPercent: 0,
            lastActivityAt: now,
          },
        });
        if (result.count !== 1) return false;

        await tx.supportTicketEvent.create({
          data: {
            ticketId: ticket.id,
            eventType: SupportTicketEventType.escalated,
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

      if (!updated) continue;
      escalated += 1;
      await notifyOwner({
        userId: ticket.ownerId ?? ticket.queue?.defaultOwnerId ?? null,
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        title: ticket.title,
        orderId: ticket.orderId,
      });
      await publishSupportRefresh("ticket_updated", {
        ticketId: ticket.id,
        keys: ["list", "summary", "detail"],
      });
    }

    if (escalated > 0) {
      await invalidateSupportCache();
      console.log(`[support-sla] reason=${reason} escalated=${escalated}`);
    }

    return escalated;
  } catch (err: any) {
    const now = Date.now();
    if (now - lastErrorLogAt >= 30_000) {
      lastErrorLogAt = now;
      console.error(`[support-sla] failed: ${err?.message || "unknown"}`);
    }
    return 0;
  } finally {
    running = false;
  }
}

export function startSupportSlaMonitorWorker() {
  if (started || process.env.SUPPORT_SLA_MONITOR_ENABLED === "false") return;
  started = true;

  const intervalMs = Math.max(
    60_000,
    numberFromEnv("SUPPORT_SLA_MONITOR_INTERVAL_MS", 2 * 60_000),
  );
  const timer = setInterval(() => {
    void runSupportSlaMonitor("interval");
  }, intervalMs);
  timer.unref();

  void runSupportSlaMonitor("startup");
}
