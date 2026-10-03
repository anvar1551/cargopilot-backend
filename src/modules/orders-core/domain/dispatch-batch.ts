import { Prisma, OrderStatus } from "@prisma/client";
import { orderError, normalizeBulkOrderIds } from "../shared";
import { dispatchOrderWhere, type DispatchAuthority } from "./dispatch-authority";

export const dispatchTransactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2000, timeout: 10000 };
export type DispatchState = { id: string; updatedAt: Date; status: OrderStatus; assignedDriverId: string | null; currentWarehouseId: string | null };
export type ExpectedDispatchState = { orderId: string; updatedAt: string; status: OrderStatus; assignedDriverId: string | null; currentWarehouseId: string | null };
export function parseDispatchBatch(ids: unknown, input: unknown) {
  const orderIds = normalizeBulkOrderIds(ids).sort();
  if (orderIds.length > 100) throw orderError("Maximum dispatch batch is 100 orders",400);
  if (!Array.isArray(input) || input.length !== orderIds.length) throw orderError("Complete expectedStates required", 400);
  const expected = new Map<string, ExpectedDispatchState>();
  for (const item of input) {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "assignedDriverId,currentWarehouseId,orderId,status,updatedAt" ||
        !orderIds.includes(item.orderId) || expected.has(item.orderId) || typeof item.updatedAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.updatedAt) || !Number.isFinite(Date.parse(item.updatedAt)) ||
        new Date(item.updatedAt).toISOString() !== item.updatedAt || !Object.values(OrderStatus).includes(item.status) ||
        (item.assignedDriverId !== null && typeof item.assignedDriverId !== "string") ||
        (item.currentWarehouseId !== null && typeof item.currentWarehouseId !== "string")) throw orderError("Invalid expectedStates", 400);
    expected.set(item.orderId, item);
  }
  return { orderIds, expected };
}
export function requireExpectedDispatchState(rows: DispatchState[], expected: Map<string, ExpectedDispatchState>) {
  for (const row of rows) {
    const old = expected.get(row.id);
    if (!old || old.updatedAt !== row.updatedAt.toISOString() || old.status !== row.status ||
        old.assignedDriverId !== row.assignedDriverId || old.currentWarehouseId !== row.currentWarehouseId) {
      throw orderError("Stale dispatch state; refresh before a new action", 409);
    }
  }
}
export async function lockDispatchBatch(tx: Prisma.TransactionClient, authority: DispatchAuthority, ids: string[]) {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
  const preliminary = await tx.order.findMany({ where: dispatchOrderWhere(authority, ids), select: { id: true } });
  if (preliminary.length !== ids.length) throw orderError("Some orders were not found or out of scope", 403);
  const locked = await tx.$queryRaw<Array<{id:string}>>`SELECT "id" FROM "Order" WHERE
    "id" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}) AND "tenantId" = ${authority.actor.tenantId}::uuid
    AND ("ownerOrgId" = ${authority.actor.companyId}::uuid OR "assignedOrgId" = ${authority.actor.companyId}::uuid)
    ORDER BY "id" FOR UPDATE`;
  if (locked.length !== ids.length) throw orderError("Some orders are no longer in scope", 409);
}
export function nextDispatchTime(previous: Date) { return new Date(Math.max(Date.now(), previous.getTime() + 1)); }
const changedRows = Symbol("committedDispatchChanges");
export function withDispatchChanges<T extends {id:string}>(rows:T[], ids:string[]):T[] {
  Object.defineProperty(rows, changedRows, { value: new Set(ids) }); return rows;
}
/** Delivery bookkeeping only, not authority or a durable idempotency receipt. Missing evidence suppresses effects. */
export function committedDispatchChanges<T extends {id:string}>(rows:T[]):T[] {
  const ids: Set<string> | undefined = (rows as any)[changedRows]; return ids ? rows.filter(row => ids.has(row.id)) : [];
}
