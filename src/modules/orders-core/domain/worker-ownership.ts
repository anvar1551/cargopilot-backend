import { orderError } from "../shared/actor";

/** Only durable operation executors use this; it conveys no human permissions. */
export async function requireActiveOrderOwnership(db: any, orderId: string, tenantId: string, companyId: string) {
  if (!orderId || !tenantId || !companyId) throw orderError("Durable order ownership required", 403);
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, tenantId: true, ownerOrgId: true,
      tenant: { select: { id: true, status: true } },
      ownerOrg: { select: { id: true, tenantId: true, type: true, isActive: true } } },
  });
  if (!order || order.id !== orderId || order.tenantId !== tenantId || order.ownerOrgId !== companyId ||
      order.tenant?.id !== tenantId || order.tenant.status !== "active" ||
      order.ownerOrg?.id !== companyId || order.ownerOrg.tenantId !== tenantId ||
      order.ownerOrg.type !== "company" || !order.ownerOrg.isActive) {
    throw orderError("Durable order ownership is inactive or inconsistent", 403);
  }
  return order;
}
