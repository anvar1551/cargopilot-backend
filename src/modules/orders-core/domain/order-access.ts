import prisma from "../../../config/prismaClient";
import { buildOrderScopeWhere, loadAccessSnapshot } from "../../identity-access/access-control";
import type { AppUser } from "../../../types/app-user";
import type { OrderActor } from "../shared/actor";
import { orderError } from "../shared/actor";

/** Uses the established fresh membership and object-scope policy at service boundaries. */
export async function requireAuthorizedOrder(
  actor: OrderActor | null | undefined,
  orderId: string,
  permission: string,
) {
  if (!actor?.id || !actor.tenantId || !actor.tenantMembershipId ||
      !actor.companyId || !actor.companyMembershipId ||
      actor.membershipId !== actor.companyMembershipId) {
    throw orderError("Tenant-bound membership context required", 403);
  }
  const scope = await buildOrderScopeWhere(actor as AppUser, permission);
  if (!scope || scope.id === "__no_access__") {
    throw orderError("Order permission and scope required", 403);
  }
  const order = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, scope ?? { id: "__no_access__" }] },
    select: { id: true, tenantId: true, ownerOrgId: true, assignedDriverId: true, currentWarehouseId: true },
  });
  if (!order || !order.tenantId || order.tenantId !== actor.tenantId) {
    throw orderError("Order not found", 404);
  }
  return order;
}

export async function requireOrderWarehouseReference(actor: OrderActor, warehouseId: string) {
  const snapshot = await loadAccessSnapshot({
    userId: actor.id, membershipId: actor.membershipId ?? "",
    companyMembershipId: actor.companyMembershipId ?? "", companyId: actor.companyId ?? "",
    tenantId: actor.tenantId ?? "", tenantMembershipId: actor.tenantMembershipId ?? "",
    requireFresh: true,
  });
  if (!snapshot || !snapshot.permissionCodes.includes("shipment.update") ||
      !snapshot.scopes.some(scope => scope.scopeType === "warehouse" && scope.scopeRefId === warehouseId)) {
    throw orderError("Warehouse scope required", 403);
  }
  const warehouse = await prisma.warehouse.findFirst({
    where: { id: warehouseId, tenantId: snapshot.tenantId }, select: { id: true },
  });
  if (!warehouse) throw orderError("Warehouse not found in selected tenant", 403);
}
