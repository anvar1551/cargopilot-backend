import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../../../config/prismaClient";
import { requireCustodyActor, requireCustodyDriver } from "../domain/custody-access";
import { orderError, type OrderActor } from "../shared";

const pageSchema = z.object({ kind: z.enum(["warehouse", "driver"]), limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(1024).optional() }).strict();
const cursorSchema = z.object({ v: z.literal(1), context: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().uuid() }).strict();
type WorkRow = { orderId: string; orderNumber: string; status: string; expectedUpdatedAt: Date; expectedEventId: string | null;
  phase: string; currentWarehouseId: string | null; destinationWarehouseId: string | null; legId: string | null };

export async function listCustodyWork(requested: OrderActor, raw: unknown) {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) throw orderError("Invalid custody work page", 400);
  const page = parsed.data, actor = await requireCustodyActor(requested, "shipment.view");
  const permissions = actor.permissionCodes ?? [];
  const allowed = (action: string) => permissions.includes(`shipment.custody.${action}`);
  const warehouses = [...new Set((actor.scopes ?? []).filter(s => s.scopeType === "warehouse").map(s => s.scopeRefId))].sort();
  if (warehouses.length > 100) throw orderError("Custody warehouse scope limit exceeded", 409);
  const context = createHash("sha256").update(JSON.stringify({ user: actor.id, tenant: actor.tenantId, tm: actor.tenantMembershipId,
    company: actor.companyId, cm: actor.companyMembershipId, kind: page.kind, limit: page.limit,
    warehouses, permissions: [...permissions].sort() })).digest("hex");
  let after: string | null = null;
  if (page.cursor) {
    try {
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8")));
      if (Buffer.from(JSON.stringify(cursor)).toString("base64url") !== page.cursor || cursor.context !== context) throw Error("Context changed");
      after = cursor.after;
    } catch { throw orderError("Invalid or changed-context custody cursor", 400); }
  }
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
    const conditions: Prisma.Sql[] = [];
    if (page.kind === "warehouse") {
      if (!warehouses.length) throw orderError("Explicit custody warehouse scope required", 403);
      const owned = await tx.warehouse.findMany({ where: { tenantId: actor.tenantId!, id: { in: warehouses } }, select: { id: true }, take: 101 });
      const ids = owned.map(w => Prisma.sql`${w.id}::uuid`);
      if (!ids.length) throw orderError("Owned custody warehouse scope required", 403);
      const destination = Prisma.sql`c."destinationWarehouseId" IN (${Prisma.join(ids)})`;
      const current = Prisma.sql`c."warehouseId" IN (${Prisma.join(ids)}) AND o."currentWarehouseId"=c."warehouseId" AND o.status='at_warehouse'`;
      if (allowed("intake")) conditions.push(Prisma.sql`(c.phase='pickup-offered' AND o.status='picked_up' AND o."currentWarehouseId" IS NULL AND o."assignedDriverId"=c."driverUserId" AND ${destination})`);
      if (allowed("receive")) conditions.push(Prisma.sql`(c.phase='transport' AND o.status='in_transit' AND o."currentWarehouseId" IS NULL AND ${destination})`);
      if (allowed("dispatch") || allowed("last-mile-offer")) conditions.push(Prisma.sql`(c.phase='warehouse' AND ${current})`);
    } else {
      // No company/global order scope substitutes for the exact eligible driver membership.
      const user = await tx.user.findUnique({ where: { id: actor.id }, select: { driverType: true } });
      if (user?.driverType === "local" && permissions.includes("shipment.changeStatus")) {
        await requireCustodyDriver(tx, actor, actor.companyMembershipId!, "local", "shipment.changeStatus");
        conditions.push(Prisma.sql`(c.id IS NULL AND NOT EXISTS (SELECT 1 FROM "OrderCustodyAction" history WHERE history."orderId"=o.id) AND o.status IN ('assigned','pickup_in_progress','picked_up') AND o."currentWarehouseId" IS NULL AND o."assignedDriverId"=${actor.id}::uuid)`);
      }
      const actions = user?.driverType === "linehaul" ? ["transport-accept"] : user?.driverType === "local" ? ["pickup-offer", "last-mile-accept", "deliver"] : [];
      for (const action of actions.filter(allowed)) {
        await requireCustodyDriver(tx, actor, actor.companyMembershipId!, user!.driverType as "local" | "linehaul", `shipment.custody.${action}`);
        if (action === "transport-accept") conditions.push(Prisma.sql`((c.phase='transport-offered' AND o.status='at_warehouse' AND o."currentWarehouseId"=c."warehouseId") OR (c.phase='transport' AND o.status='in_transit' AND o."currentWarehouseId" IS NULL))`);
        if (action === "pickup-offer") conditions.push(Prisma.sql`(c.phase='pickup-offered' AND o.status='picked_up' AND o."currentWarehouseId" IS NULL AND o."assignedDriverId"=${actor.id}::uuid)`);
        if (action === "last-mile-accept") conditions.push(Prisma.sql`(c.phase='last-mile-offered' AND o.status='at_warehouse' AND o."currentWarehouseId"=c."warehouseId" AND o."assignedDriverId"=${actor.id}::uuid)`);
        if (action === "deliver") conditions.push(Prisma.sql`(c.phase='last-mile' AND o.status='out_for_delivery' AND o."currentWarehouseId" IS NULL AND o."assignedDriverId"=${actor.id}::uuid)`);
      }
    }
    if (!conditions.length) throw orderError("Custody work action permission required", 403);
    const rows = await tx.$queryRaw<WorkRow[]>`SELECT o.id AS "orderId", o."orderNumber", o.status, o."updatedAt" AS "expectedUpdatedAt",
      c.id AS "expectedEventId", COALESCE(c.phase, 'pickup-assigned') AS phase, o."currentWarehouseId", c."destinationWarehouseId", c."legId"
      FROM "Order" o LEFT JOIN LATERAL (SELECT a.id, a.phase, a."warehouseId", a."destinationWarehouseId", a."driverUserId", a."driverMembershipId",
        a."legId", a."actorUserId", a."companyMembershipId" FROM "OrderCustodyAction" a
        WHERE a."orderId"=o.id AND a."tenantId"=${actor.tenantId}::uuid AND a."companyId"=${actor.companyId}::uuid ORDER BY a.sequence DESC LIMIT 1) c ON true
      WHERE o."tenantId"=${actor.tenantId}::uuid AND o."ownerOrgId"=${actor.companyId}::uuid
        AND (o."assignedOrgId" IS NULL OR o."assignedOrgId"=${actor.companyId}::uuid)
        AND (${after}::uuid IS NULL OR o.id>${after}::uuid)
        AND (${Prisma.join(conditions, " OR ")})
        AND (c.id IS NULL OR c.phase NOT IN ('pickup-offered','transport') OR (c."actorUserId"=c."driverUserId" AND c."companyMembershipId"=c."driverMembershipId"))
        AND (c.id IS NULL OR c.phase NOT IN ('transport-offered','transport') OR EXISTS (SELECT 1 FROM "OrderLeg" l WHERE l.id=c."legId" AND l."orderId"=o.id
          AND l."fromWarehouseId"=c."warehouseId" AND l."toWarehouseId"=c."destinationWarehouseId" AND l."carrierProviderId" IS NULL AND l."carrierBookingStatus"='not_requested'
          AND ((c.phase='transport-offered' AND l.status='planned') OR (c.phase='transport' AND l.status IN ('departed','in_transit','arrived')))))
        AND ${page.kind === "driver" ? Prisma.sql`(c.id IS NULL OR (c."driverUserId"=${actor.id}::uuid AND c."driverMembershipId"=${actor.companyMembershipId}::uuid))` : Prisma.sql`true`}
      ORDER BY o.id ASC LIMIT ${page.limit + 1}`;
    const items = rows.slice(0, page.limit).map(row => ({ ...row, expectedUpdatedAt: row.expectedUpdatedAt.toISOString() }));
    const nextCursor = rows.length > page.limit ? Buffer.from(JSON.stringify({ v: 1, context, after: items[items.length - 1].orderId })).toString("base64url") : null;
    return { items, nextCursor };
  }, { maxWait: 2000, timeout: 10000 });
}
