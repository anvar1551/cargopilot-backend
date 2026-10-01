import prisma from "../../../config/prismaClient";
import { enqueueCargoPilotDomainEventTx } from "../../analytics-core/infrastructure/analyticsOutbox";

// Private, fixed operation capabilities derived only from committed ticket/workflow state.
const owned = { tenantId: { not: null }, ownerOrgId: { not: null }, tenant: { is: { status: "active" as const } },
  ownerOrg: { is: { isActive: true } } };
export async function maintainOwnedSupportTickets(operation: "sla" | "archive", days = 30) {
  if (!["sla", "archive"].includes(operation) || !Number.isFinite(days) || days < 1 || days > 3650) throw new Error("Invalid support maintenance capability");
  const now = new Date();
  const workflow = operation === "sla" ? { archivedAt: null, slaDueAt: { lte: now }, status: { notIn: ["escalated" as const, "resolved" as const] } }
    : { archivedAt: null, status: "resolved" as const, resolvedAt: { lt: new Date(now.getTime() - Math.max(1, days) * 86400000) } };
  const tickets = await prisma.supportTicket.findMany({ where: { ...owned, ...workflow }, select: { id: true, tenantId: true, ownerOrgId: true }, take: 50, orderBy: { id: "asc" } });
  let changed = 0;
  for (const target of tickets) {
    const accepted = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SupportTicket" WHERE "id" = ${target.id}::uuid AND "tenantId" = ${target.tenantId}::uuid AND "ownerOrgId" = ${target.ownerOrgId}::uuid FOR UPDATE`;
      const ticket = await tx.supportTicket.findFirst({ where: { ...owned, ...workflow, id: target.id, tenantId: target.tenantId, ownerOrgId: target.ownerOrgId } });
      if (!ticket?.tenantId || !ticket.ownerOrgId) return false;
      const company = await tx.organization.findFirst({ where: { id: ticket.ownerOrgId, tenantId: ticket.tenantId, isActive: true }, select: { id: true } });
      if (!company) return false;
      if (ticket.orderId && !await tx.order.findFirst({ where: { id: ticket.orderId, tenantId: ticket.tenantId, ownerOrgId: ticket.ownerOrgId }, select: { id: true } })) return false;
      const result = await tx.supportTicket.updateMany({ where: { ...owned, ...workflow, id: ticket.id, tenantId: ticket.tenantId, ownerOrgId: ticket.ownerOrgId },
        data: operation === "sla" ? { status: "escalated", slaPercent: 0, lastActivityAt: now } : { archivedAt: now } });
      if (result.count !== 1) return false;
      await tx.supportTicketEvent.create({ data: { ticketId: ticket.id, eventType: operation === "sla" ? "escalated" : "archived",
        actorId: null, actorName: operation === "sla" ? "CargoPilot SLA Monitor" : "CargoPilot Retention",
        body: operation === "sla" ? "Persisted support SLA overdue" : "Resolved ticket archived", metadata: { capability: operation === "sla" ? "support.sla.escalate" : "support.retention.archive" } } });
      await enqueueCargoPilotDomainEventTx(tx, { type: "support_ticket_changed", tenantScope: `tenant:${ticket.tenantId}:company:${ticket.ownerOrgId}`,
        entityId: ticket.id, payload: { reason: operation === "sla" ? "ticket_updated" : "ticket_archived" } });
      // Recipient authority is the stored bridge, never a queue default/global user fallback.
      if (operation === "sla" && ticket.ownerId && ticket.ownerCompanyMembershipId) {
        const membership = await tx.companyMembership.findFirst({ where: { id: ticket.ownerCompanyMembershipId, userId: ticket.ownerId,
          tenantId: ticket.tenantId, companyId: ticket.ownerOrgId, status: "active", tenant: { is: { status: "active" } },
          tenantMembership: { is: { userId: ticket.ownerId, tenantId: ticket.tenantId, status: "active" } },
          company: { is: { tenantId: ticket.tenantId, isActive: true } },
          scopes: { some: { scopeType: "company", scopeRefId: ticket.ownerOrgId } },
          roles: { some: { role: { rolePermissions: { some: { permission: { key: "support.update" } } } } } } }, select: { id: true } });
        if (membership) await tx.userNotification.create({ data: { userId: ticket.ownerId, tenantId: ticket.tenantId, companyId: ticket.ownerOrgId,
          companyMembershipId: membership.id, type: "support", title: "Support SLA overdue", body: ticket.title, orderId: ticket.orderId, data: { ticketId: ticket.id, reason: "sla_overdue" } } });
      }
      return true;
    });
    if (accepted) changed++;
  }
  return changed;
}
