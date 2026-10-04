import type { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { loadAccessSnapshot, buildMembershipOrderScopeWhere } from "../../identity-access/access-control";
import { orderError, type OrderActor } from "../shared";
import type { AppUser } from "../../../types/app-user";

export async function requireCustodyActor(requested: OrderActor, permission: string): Promise<OrderActor> {
  if (!requested?.id || !requested.companyMembershipId || requested.membershipId !== requested.companyMembershipId ||
      !requested.companyId || !requested.tenantId || !requested.tenantMembershipId) throw orderError("Tenant-bound membership context required", 403);
  const snapshot = await loadAccessSnapshot({ userId: requested.id, membershipId: requested.companyMembershipId,
    companyMembershipId: requested.companyMembershipId, companyId: requested.companyId, tenantId: requested.tenantId,
    tenantMembershipId: requested.tenantMembershipId, requireFresh: true, explicitScopesOnly: true });
  if (!snapshot?.permissionCodes.includes(permission)) throw orderError("Custody permission required", 403);
  return { ...snapshot, id: snapshot.userId, warehouseId: null, customerEntityId: null };
}

export const ownedCustodyWhere = (actor: OrderActor, orderId: string): Prisma.OrderWhereInput => ({
  id: orderId, tenantId: actor.tenantId!, ownerOrgId: actor.companyId!,
  OR: [{ assignedOrgId: null }, { assignedOrgId: actor.companyId! }],
});

export async function loadCustodySource(tx: Prisma.TransactionClient, actor: OrderActor, orderId: string) {
  const order = await tx.order.findFirst({ where: ownedCustodyWhere(actor, orderId), select: {
    id: true, tenantId: true, ownerOrgId: true, assignedDriverId: true, currentWarehouseId: true, status: true, updatedAt: true,
  } });
  if (!order) throw orderError("Selected owning operating company required", 403);
  const latest = await tx.orderCustodyAction.findFirst({ where: { orderId, tenantId: actor.tenantId!, companyId: actor.companyId! }, orderBy: { sequence: "desc" } });
  return { order, latest };
}
type Source = Awaited<ReturnType<typeof loadCustodySource>>;

/** Receiving authority belongs to staff, not the outgoing actor's continuing login/permissions. */
export async function observeOutgoingCustody(tx: Prisma.TransactionClient, actor: OrderActor, source: Source, reason?: string) {
  const prior = source.latest;
  if (!prior || !["pickup-offered", "transport"].includes(prior.phase) || !prior.driverMembershipId || !prior.driverUserId ||
      prior.actorUserId !== prior.driverUserId || prior.companyMembershipId !== prior.driverMembershipId) throw orderError("Accepted outgoing custody identity required", 409);
  const member = await tx.companyMembership.findFirst({ where: { id: prior.driverMembershipId, userId: prior.driverUserId,
    tenantId: actor.tenantId!, companyId: actor.companyId!, tenantMembershipId: prior.tenantMembershipId },
    select: { status: true, tenantMembership: { select: { id: true, userId: true, tenantId: true, status: true } } } });
  const tm = member?.tenantMembership;
  if (!member || !tm || tm.id !== prior.tenantMembershipId || tm.userId !== prior.driverUserId || tm.tenantId !== actor.tenantId ||
      !["active", "suspended"].includes(member.status) || !["active", "suspended"].includes(tm.status)) throw orderError("Consistent recorded outgoing membership required", 409);
  const suspended = member.status === "suspended" || tm.status === "suspended";
  if (suspended && !reason) throw orderError("Outgoing-driver suspension receipt reason required", 400);
  return { predecessorEventId: prior.id, userId: prior.driverUserId, companyMembershipId: prior.driverMembershipId,
    tenantMembershipId: prior.tenantMembershipId, membershipStatus: member.status, tenantMembershipStatus: tm.status, suspended, reason: reason ?? null };
}

export async function requireCustodyDriver(tx: Prisma.TransactionClient, actor: OrderActor, id: string, type: "local" | "linehaul", permission: string) {
  const member = await tx.companyMembership.findFirst({ where: { id, tenantId: actor.tenantId!, companyId: actor.companyId!, status: "active",
    company: { isActive: true, tenantId: actor.tenantId! }, tenant: { status: "active" },
    tenantMembership: { status: "active", tenantId: actor.tenantId! }, user: { driverType: type },
    OR: [{ branchId: null }, { branch: { isActive: true, tenantId: actor.tenantId! } }] },
    select: { id: true, userId: true, tenantMembership: { select: { userId: true } }, roles: { select: { role: { select: {
      companyId: true, isSystem: true, rolePermissions: { select: { permission: { select: { key: true } } } } } } } } } });
  const keys = member?.roles.flatMap(r => r.role.companyId === actor.companyId || (!r.role.companyId && r.role.isSystem)
    ? r.role.rolePermissions.map(p => p.permission.key) : []) ?? [];
  if (!member || member.tenantMembership?.userId !== member.userId || !keys.includes("drivers.telemetry") || !keys.includes(permission)) throw orderError("Eligible exact driver membership required", 403);
  return member;
}

/** Only the operation-specific durable relationship grants custody access. No request scope/ID is authority. */
export async function authorizeCustodyAction(tx: Prisma.TransactionClient, actor: OrderActor, source: Source, action: string) {
  const { order, latest } = source;
  const permission = `shipment.custody.${action}`;
  if (!actor.permissionCodes?.includes(permission)) throw orderError("Custody permission required", 403);
  if (["intake", "receive", "dispatch", "last-mile-offer"].includes(action)) {
    const incoming = action === "intake" || action === "receive";
    const phase = action === "intake" ? "pickup-offered" : action === "receive" ? "transport" : "warehouse";
    const id = incoming ? latest?.destinationWarehouseId : latest?.warehouseId;
    if (latest?.phase !== phase || !id || (!incoming && order.currentWarehouseId !== id) ||
        !actor.scopes?.some(s => s.scopeType === "warehouse" && s.scopeRefId === id) ||
        !await tx.warehouse.findFirst({ where: { id, tenantId: actor.tenantId! }, select: { id: true } })) throw orderError("Exact custody warehouse scope required", 403);
    return;
  }
  const pickup = action === "pickup-offer";
  const phase = action === "transport-accept" ? "transport-offered" : action === "last-mile-accept" ? "last-mile-offered" : "last-mile";
  if (pickup ? (!!latest || order.status !== "picked_up" || order.assignedDriverId !== actor.id) :
      (latest?.phase !== phase || latest.driverUserId !== actor.id || latest.driverMembershipId !== actor.companyMembershipId)) {
    throw orderError("Exact custody driver membership required", 403);
  }
  await requireCustodyDriver(tx, actor, actor.companyMembershipId!, action === "transport-accept" ? "linehaul" : "local", permission);
}

/** Confirmed receipts expose only that actor's original result; they never grant current order access. */
export async function authorizeCustodyRetry(tx: Prisma.TransactionClient, actor: OrderActor, receipt: NonNullable<Source["latest"]>) {
  if (receipt.actorUserId !== actor.id || receipt.companyMembershipId !== actor.companyMembershipId ||
      receipt.tenantMembershipId !== actor.tenantMembershipId || receipt.tenantId !== actor.tenantId || receipt.companyId !== actor.companyId ||
      !actor.permissionCodes?.includes(`shipment.custody.${receipt.action}`)) throw orderError("Custody receipt context required", 403);
  if (["intake", "receive", "dispatch", "last-mile-offer"].includes(receipt.action)) {
    if (!receipt.warehouseId || !actor.scopes?.some(s => s.scopeType === "warehouse" && s.scopeRefId === receipt.warehouseId) ||
        !await tx.warehouse.findFirst({ where: { id: receipt.warehouseId, tenantId: actor.tenantId! }, select: { id: true } })) throw orderError("Original custody warehouse scope required", 403);
  } else await requireCustodyDriver(tx, actor, actor.companyMembershipId!, receipt.action === "transport-accept" ? "linehaul" : "local", `shipment.custody.${receipt.action}`);
}

export async function authorizeCustodyRead(tx: Prisma.TransactionClient, actor: OrderActor, source: Source) {
  if (source.latest?.driverUserId === actor.id && source.latest.driverMembershipId === actor.companyMembershipId) {
    const action = source.latest.phase === "pickup-offered" ? "pickup-offer" :
      ["transport-offered", "transport"].includes(source.latest.phase) ? "transport-accept" :
      source.latest.phase === "last-mile-offered" ? "last-mile-accept" :
      ["last-mile", "delivered"].includes(source.latest.phase) ? "deliver" : null;
    if (action && actor.permissionCodes?.includes(`shipment.custody.${action}`)) {
      await requireCustodyDriver(tx, actor, actor.companyMembershipId!, action === "transport-accept" ? "linehaul" : "local", `shipment.custody.${action}`);
      return;
    }
  }
  const actions = source.latest?.phase === "pickup-offered" ? ["intake"] : source.latest?.phase === "transport" ? ["receive"] :
    source.latest?.phase === "warehouse" ? ["dispatch", "last-mile-offer"] : source.latest?.phase === "transport-offered" ? ["transport-accept"] :
    source.latest?.phase === "last-mile-offered" ? ["last-mile-accept"] : source.latest?.phase === "last-mile" ? ["deliver"] : !source.latest ? ["pickup-offer"] : [];
  for (const action of actions) {
    if (!actor.permissionCodes?.includes(`shipment.custody.${action}`)) continue;
    try { await authorizeCustodyAction(tx, actor, source, action); return; }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 403) throw error; }
  }
  // Existing scoped readers retain their existing visibility. This is not a company/global fallback.
  const scope = await buildMembershipOrderScopeWhere(actor as AppUser, "shipment.view");
  if (!scope || !await tx.order.findFirst({ where: { AND: [ownedCustodyWhere(actor, source.order.id), scope] }, select: { id: true } })) throw orderError("Custody read scope required", 403);
}

/** Specific proof preflight/submit alternative; unrelated order APIs and proof reads are unchanged. */
export async function requireCustodyProofOrder(requested: OrderActor, orderId: string) {
  const actor = await requireCustodyActor(requested, "shipment.update");
  const source = await loadCustodySource(prisma, actor, orderId);
  if (source.order.assignedDriverId !== actor.id) throw orderError("Assigned proof driver required", 403);
  if (!source.latest) await authorizeCustodyAction(prisma, actor, source, "pickup-offer");
  else {
    if (!["last-mile", "delivered"].includes(source.latest.phase) || source.latest.driverUserId !== actor.id || source.latest.driverMembershipId !== actor.companyMembershipId) throw orderError("Accepted proof driver membership required", 403);
    await requireCustodyDriver(prisma, actor, actor.companyMembershipId!, "local", "shipment.custody.deliver");
  }
  return source.order;
}
