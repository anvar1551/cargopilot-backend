import { createHash } from "crypto";
import { z } from "zod";
import prisma from "../../../config/prismaClient";
import { requireAcceptedDriver } from "../../identity-access/application/driver-eligibility";
import { authorizeCustodyAction, authorizeCustodyRead, initialPickupWhere, loadCustodySource, ownedCustodyWhere, requireCustodyActor, requireCustodyReadActor, requireCustodyProofOrder } from "../domain/custody-access";
import { readWarehouseCustody } from "../operations/warehouse-custody";
import { orderError, type OrderActor } from "../shared";

const uuid = z.string().uuid();
/** Action hints are current preflight, never execution authority. Mutations reauthorize under their existing locks. */
export async function readDriverWork(requested: OrderActor, orderId: string) {
  if (!uuid.safeParse(orderId).success) throw orderError("Valid order identifier required", 400);
  const a = await requireCustodyReadActor(requested);
  await requireAcceptedDriver(prisma, { tenantId: a.tenantId!, companyId: a.companyId! }, a.companyMembershipId!);
  const source = await loadCustodySource(prisma, a, orderId);
  await authorizeCustodyRead(prisma, a, source);
  const detail = await readWarehouseCustody(a, orderId);
  if (detail.updatedAt !== source.order.updatedAt.toISOString() || (detail.custody?.id ?? null) !== (source.latest?.id ?? null)) throw orderError("Work changed during preflight; reload", 409);
  const driverActions: string[] = [];
  if (!source.latest && a.permissionCodes?.includes("shipment.changeStatus") &&
      await prisma.order.findFirst({ where: { AND: [initialPickupWhere(a), { id: orderId }] }, select: { id: true } })) {
    if (source.order.status === "assigned") driverActions.push("pickup_in_progress");
    if (source.order.status === "pickup_in_progress") driverActions.push("picked_up");
  }
  for (const action of ["pickup-offer", "transport-accept", "last-mile-accept", "deliver"]) {
    const status = action === "pickup-offer" ? "picked_up" : action === "deliver" ? "out_for_delivery" : "at_warehouse";
    if (source.order.status !== status) continue;
    try { await authorizeCustodyAction(prisma, a, source, action); driverActions.push(action); }
    catch (e) { if ((e as { statusCode?: number }).statusCode !== 403) throw e; }
  }
  const proofStages: string[] = [];
  for (const stage of ["pickup", "delivery"] as const) {
    try { await requireCustodyProofOrder(a, orderId, stage); proofStages.push(stage); }
    catch (e) { if (![403, 409].includes((e as { statusCode?: number }).statusCode ?? 0)) throw e; }
  }
  const operational = await prisma.order.findFirst({ where: ownedCustodyWhere(a, orderId), select: {
    senderName: true, senderPhone: true, pickupAddress: true, receiverName: true, receiverPhone: true, dropoffAddress: true,
  } });
  if (!operational) throw orderError("Owned driver work required", 403);
  return { ...detail, driverActions, proofStages, operational };
}

const page = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20), cursor: z.string().max(1024).optional() }).strict();
const cursor = z.object({ context: z.string().regex(/^[a-f0-9]{64}$/), after: uuid }).strict();
/** Pickup-offer already permits an owned tenant destination. This read does not grant warehouse access. */
export async function readPickupDestinations(requested: OrderActor, orderId: string, raw: unknown) {
  const p = page.safeParse(raw);
  if (!p.success || !uuid.safeParse(orderId).success) throw orderError("Invalid pickup destinations page", 400);
  const a = await requireCustodyActor(requested, "shipment.custody.pickup-offer");
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
    const source = await loadCustodySource(tx, a, orderId);
    await authorizeCustodyAction(tx, a, source, "pickup-offer");
    const context = createHash("sha256").update(JSON.stringify([a.id, a.tenantId, a.tenantMembershipId, a.companyId, a.companyMembershipId, orderId, source.order.updatedAt, p.data.limit])).digest("hex");
    let after: string | undefined;
    if (p.data.cursor) {
      try {
        const c = cursor.parse(JSON.parse(Buffer.from(p.data.cursor, "base64url").toString()));
        if (c.context !== context || Buffer.from(JSON.stringify(c)).toString("base64url") !== p.data.cursor) throw Error();
        after = c.after;
      } catch { throw orderError("Invalid or changed-context pickup destinations cursor", 400); }
    }
    const rows = await tx.warehouse.findMany({ where: { tenantId: a.tenantId!, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, name: true, location: true }, orderBy: { id: "asc" }, take: p.data.limit + 1 });
    const items = rows.slice(0, p.data.limit);
    return { items, nextCursor: rows.length > p.data.limit && items.length ? Buffer.from(JSON.stringify({ context, after: items[items.length - 1].id })).toString("base64url") : null };
  }, { timeout: 10000 });
}
