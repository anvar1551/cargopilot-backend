import prisma from "../../../config/prismaClient";
import { Prisma } from "@prisma/client";
import { buildOrderScopeWhere, loadAccessSnapshot } from "../../identity-access/access-control";
import type { AppUser } from "../../../types/app-user";
import type { OrderActor } from "../shared/actor";
import { orderError } from "../shared/actor";

export async function requireCashContext(actor: OrderActor, permission: string) {
  if (!actor?.id || !actor.tenantId || !actor.tenantMembershipId || !actor.companyId ||
      !actor.companyMembershipId || actor.membershipId !== actor.companyMembershipId) {
    throw orderError("Tenant-bound selected membership required", 403);
  }
  const snapshot = await loadAccessSnapshot({ userId: actor.id, membershipId: actor.companyMembershipId,
    companyMembershipId: actor.companyMembershipId, companyId: actor.companyId,
    tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId, requireFresh: true });
  if (!snapshot || !snapshot.permissionCodes.includes(permission)) throw orderError("Cash permission required", 403);
  const verified: OrderActor = { ...snapshot, id: snapshot.userId };
  const scope = await buildOrderScopeWhere(verified as AppUser, permission);
  if (!scope || scope.id === "__no_access__") throw orderError("Order scope required", 403);
  return { actor: verified, scope: { AND: [scope, { tenantId: snapshot.tenantId, ownerOrgId: snapshot.companyId }] } as Prisma.OrderWhereInput };
}

/** No rounding or currency default. Legacy float storage remains a release limitation. */
export function exactCashAmount(value: unknown) {
  const text = String(value ?? "");
  if (!/^\d{1,16}(?:\.\d{1,4})?$/.test(text)) throw orderError("Cash obligation has unsupported monetary precision", 409);
  const amount = new Prisma.Decimal(text);
  if (!amount.isPositive() || amount.toNumber().toString() !== amount.toString()) {
    throw orderError("Cash obligation cannot be represented by the compatibility mirror", 409);
  }
  return amount;
}

export async function cashWarehouse(tx: any, actor: OrderActor, id: string) {
  if (!actor.scopes?.some(s => s.scopeType === "warehouse" && s.scopeRefId === id)) {
    throw orderError("Cash warehouse scope required", 403);
  }
  const row = await tx.warehouse.findFirst({ where: { id, tenantId: actor.tenantId },
    select: { id: true, name: true, type: true } });
  if (!row) throw orderError("Cash warehouse ownership missing", 403);
  return row;
}

export const cashDatabase = prisma as any;

/** Called inside verified online-payment reconciliation, not a public cash authorization bypass. */
export async function lockOnlineCashReconciliation(tx: any, orderId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CashCollection" WHERE "orderId" = ${orderId}::uuid AND "kind" = 'service_charge' FOR UPDATE`;
  const row = await tx.cashCollection.findUnique({ where: { orderId_kind: { orderId, kind: "service_charge" } }, select: { status: true } });
  if (row && !["expected", "settled"].includes(row.status)) throw orderError("Online reconciliation conflicts with cash custody", 409);
}
