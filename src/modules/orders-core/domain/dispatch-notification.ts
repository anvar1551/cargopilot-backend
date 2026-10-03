import { Prisma } from "@prisma/client";

/** Specific accepted dispatch source; ownership and recipient are reloaded inside the business transaction. */
export async function persistDispatchNotification(tx: Prisma.TransactionClient, trackingId: string, kind: "assignment" | "status") {
  const source = await tx.tracking.findUnique({ where: { id: trackingId }, select: {
    id: true, orderId: true, order: { select: { id: true, tenantId: true, ownerOrgId: true, assignedDriverId: true, orderNumber: true, status: true } },
  } });
  const order = source?.order;
  if (!source || !order?.tenantId || !order.ownerOrgId || !order.assignedDriverId) return null;
  const member = await tx.companyMembership.findUnique({
    where: { userId_companyId: { userId: order.assignedDriverId, companyId: order.ownerOrgId } },
    select: { id: true, userId: true, companyId: true, tenantId: true, tenantMembershipId: true, status: true,
      tenant: { select: { id: true, status: true } },
      tenantMembership: { select: { id: true, userId: true, tenantId: true, status: true } },
      company: { select: { id: true, tenantId: true, isActive: true } },
      branch: { select: { tenantId: true, isActive: true } },
      roles: { select: { role: { select: { companyId: true, isSystem: true, rolePermissions: { select: { permission: { select: { key: true } } } } } } } },
    },
  });
  if (!member || member.userId !== order.assignedDriverId || member.companyId !== order.ownerOrgId
    || member.tenantId !== order.tenantId || !member.tenantMembershipId || member.status !== "active"
    || member.tenant?.id !== order.tenantId || member.tenant.status !== "active"
    || member.company.id !== order.ownerOrgId || member.company.tenantId !== order.tenantId || !member.company.isActive
    || member.tenantMembership?.id !== member.tenantMembershipId || member.tenantMembership.userId !== member.userId
    || member.tenantMembership.tenantId !== order.tenantId || member.tenantMembership.status !== "active"
    || (member.branch && (member.branch.tenantId !== order.tenantId || !member.branch.isActive))
    || !member.roles.some(({ role }) => (role.companyId === order.ownerOrgId || (role.companyId === null && role.isSystem))
      && role.rolePermissions.some(({ permission }) => permission.key === "drivers.telemetry"))) return null;
  const existing = await tx.userNotification.findUnique({ where: {
    dispatchTrackingId_companyMembershipId: { dispatchTrackingId: source.id, companyMembershipId: member.id },
  }, select: { id: true } });
  if (existing) return existing.id;
  const status = order.status.replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase());
  const created = await tx.userNotification.create({ data: {
    dispatchTrackingId: source.id, orderId: order.id, tenantId: order.tenantId, companyId: order.ownerOrgId,
    companyMembershipId: member.id, userId: member.userId, type: "order",
    title: `Order ${order.orderNumber} ${kind === "assignment" ? "assigned" : "status updated"}`,
    body: `${kind === "assignment" ? "Current status" : "New status"}: ${status}`,
  }, select: { id: true } });
  return created.id;
}

const notificationIds = Symbol("committedDispatchNotificationIds");
export function withDispatchNotifications<T extends object>(result: T, ids: string[]): T {
  Object.defineProperty(result, notificationIds, { value: [...ids] });
  return result;
}
/** Internal post-commit bookkeeping. IDs never establish delivery authority. */
export function committedDispatchNotifications(result: object): string[] {
  return (result as any)[notificationIds] ?? [];
}
