import { CashCollectionKind, CashCollectionStatus, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { OrderActor, orderError } from "../shared";
import { requireCashContext } from "./cash-authority";
export { collectOrderCash, handoffOrderCash, settleOrderCash } from "./custody.service";
function hasPermission(actor: OrderActor, permission: string) {
  return actor.permissionCodes?.includes(permission) ?? false;
}
type CashQueueFilters = {
  page?: number;
  pageSize?: number;
  statuses?: CashCollectionStatus[];
  kinds?: CashCollectionKind[];
  from?: Date;
  to?: Date;
};

function normalizeQueuePaging(filters?: CashQueueFilters) {
  const page = Math.max(1, Number(filters?.page ?? 1) || 1);
  const pageSize = Math.min(Math.max(Number(filters?.pageSize ?? 20) || 20, 5), 100);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

function normalizeQueueStatuses(filters?: CashQueueFilters) {
  const incoming = Array.isArray(filters?.statuses) ? filters?.statuses : [];
  const values = incoming.filter(
    (status) =>
      status === CashCollectionStatus.expected ||
      status === CashCollectionStatus.held ||
      status === CashCollectionStatus.settled,
  );
  if (values.length === 0) {
    return [CashCollectionStatus.expected, CashCollectionStatus.held];
  }
  return Array.from(new Set(values));
}

function normalizeQueueKinds(filters?: CashQueueFilters) {
  const incoming = Array.isArray(filters?.kinds) ? filters?.kinds : [];
  const values = incoming.filter(
    (kind) =>
      kind === CashCollectionKind.cod || kind === CashCollectionKind.service_charge,
  );
  return Array.from(new Set(values));
}

function buildQueueWhere(actor: OrderActor, scope: Prisma.OrderWhereInput, filters?: CashQueueFilters) {
  if (!actor.companyId || !actor.tenantId) throw orderError("Cash queue ownership context required", 403);
  const statuses = normalizeQueueStatuses(filters);
  const kinds = normalizeQueueKinds(filters);
  const and: Prisma.CashCollectionWhereInput[] = [
    { status: { in: statuses } },
    { order: scope },
    { OR: [{ currentHolderWarehouseId: null }, { currentHolderWarehouse: { tenantId: actor.tenantId } }] },
    { OR: [{ currentHolderUserId: null }, { currentHolderUser: { memberships: { some: {
      companyId: actor.companyId, tenantId: actor.tenantId, status: "active",
      tenantMembership: { tenantId: actor.tenantId, status: "active" },
    } } } }] },
  ];

  if (kinds.length > 0) {
    and.push({ kind: { in: kinds } });
  }

  if (filters?.from || filters?.to) {
    and.push({
      updatedAt: {
        ...(filters?.from ? { gte: filters.from } : {}),
        ...(filters?.to ? { lt: filters.to } : {}),
      },
    });
  }

  if (hasPermission(actor, "finance.viewLedger") || hasPermission(actor, "finance.settleCash")) {
    return and.length === 1 ? and[0] : { AND: and };
  }

  if (actor.warehouseId) {
    if (!actor.warehouseId) {
      throw orderError("Warehouse user has no attached location", 403);
    }

    and.push({
      OR: [
        { order: { currentWarehouseId: actor.warehouseId } },
        { currentHolderWarehouseId: actor.warehouseId },
      ],
    });
    return { AND: and };
  }

  throw orderError("Forbidden", 403);
}

function buildQueueScopeSql(actor: OrderActor) {
  if (hasPermission(actor, "finance.viewLedger") || hasPermission(actor, "finance.settleCash")) {
    return Prisma.sql`1=1`;
  }
  if (actor.warehouseId) {
    if (!actor.warehouseId) {
      throw orderError("Warehouse user has no attached location", 403);
    }
    return Prisma.sql`(o."currentWarehouseId" = ${actor.warehouseId} OR cc."currentHolderWarehouseId" = ${actor.warehouseId})`;
  }
  throw orderError("Forbidden", 403);
}

export async function listCashQueueForActor(params: {
  actor: OrderActor;
  filters?: CashQueueFilters;
}) {
  const { actor, scope } = await requireCashContext(params.actor, "shipment.view");
  const filters = params.filters;
  const where = buildQueueWhere(actor, scope, filters);
  const { page, pageSize, offset } = normalizeQueuePaging(filters);

  const [total, rows] = await prisma.$transaction([
    prisma.cashCollection.count({ where }),
    prisma.cashCollection.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: pageSize,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            currentWarehouseId: true,
            pickupAddress: true,
            dropoffAddress: true,
            assignedDriverId: true,
          },
        },
        currentHolderUser: {
          select: { id: true, name: true, email: true, driverType: true },
        },
        currentHolderWarehouse: {
          select: { id: true, name: true, type: true, location: true, region: true },
        },
      },
    }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const nowMs = Date.now();

  const items = rows.map((row) => {
    const amount = Number(row.collectedAmount ?? row.expectedAmount ?? 0);
    const updatedAt = row.updatedAt.toISOString();
    const ageHours = Math.max(
      0,
      Math.round((nowMs - new Date(updatedAt).getTime()) / (1000 * 60 * 60)),
    );

    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order?.orderNumber ?? null,
      orderStatus: row.order?.status ?? null,
      orderPickupAddress: row.order?.pickupAddress ?? null,
      orderDropoffAddress: row.order?.dropoffAddress ?? null,
      kind: row.kind,
      status: row.status,
      expectedAmount: Number(row.expectedAmount ?? 0),
      collectedAmount:
        row.collectedAmount == null ? null : Number(row.collectedAmount),
      amount,
      currency: row.currency ?? null,
      currentHolderType: row.currentHolderType,
      currentHolderLabel: row.currentHolderLabel ?? null,
      currentHolderUser: row.currentHolderUser
        ? {
            id: row.currentHolderUser.id,
            name: row.currentHolderUser.name,
            email: row.currentHolderUser.email,
            role: row.currentHolderUser.driverType ? "driver" : "staff",
          }
        : null,
      currentHolderWarehouse: row.currentHolderWarehouse
        ? {
            id: row.currentHolderWarehouse.id,
            name: row.currentHolderWarehouse.name,
            type: row.currentHolderWarehouse.type,
            location: row.currentHolderWarehouse.location,
            region: row.currentHolderWarehouse.region,
          }
        : null,
      updatedAt,
      ageHours,
      canCollect:
        row.status === CashCollectionStatus.expected &&
        (hasPermission(actor, "shipment.update") || hasPermission(actor, "finance.settleCash")),
      canHandoff:
        row.status === CashCollectionStatus.held &&
        (hasPermission(actor, "shipment.update") || hasPermission(actor, "finance.settleCash")),
      canSettle:
        row.status === CashCollectionStatus.held && hasPermission(actor, "finance.settleCash"),
    };
  });

  return {
    items,
    meta: {
      page: Math.min(page, pageCount),
      pageSize,
      total,
      pageCount,
      hasPrev: page > 1,
      hasNext: page < pageCount,
    },
  };
}

export async function getCashQueueSummaryForActor(params: {
  actor: OrderActor;
  filters?: Omit<CashQueueFilters, "page" | "pageSize">;
}) {
  const { actor, scope } = await requireCashContext(params.actor, "shipment.view");
  const filters = params.filters;
  const statuses = normalizeQueueStatuses(filters);
  const kinds = normalizeQueueKinds(filters);
  // Select only authorized parent IDs; no raw-SQL global fallback can widen object scope.
  const orders = await prisma.order.findMany({ where: scope, select: { id: true }, take: 1001 });
  if (orders.length > 1000) throw orderError("Cash summary scope exceeds bounded query capacity", 409);
  if (!orders.length) return { expectedCount: 0, expectedAmount: 0, heldCount: 0, heldAmount: 0, settledCount: 0, settledAmount: 0, totalCount: 0, totalAmount: 0 };
  const scopeSql = Prisma.sql`o."id" IN (${Prisma.join(orders.map(row => row.id))}) AND o."tenantId" = ${actor.tenantId}::uuid AND o."ownerOrgId" = ${actor.companyId}::uuid
    AND (cc."currentHolderWarehouseId" IS NULL OR EXISTS (SELECT 1 FROM "Warehouse" w WHERE w."id" = cc."currentHolderWarehouseId" AND w."tenantId" = ${actor.tenantId}::uuid))
    AND (cc."currentHolderUserId" IS NULL OR EXISTS (SELECT 1 FROM "CompanyMembership" cm JOIN "TenantMembership" tm ON tm."id" = cm."tenantMembershipId" AND tm."tenantId" = cm."tenantId" AND tm."userId" = cm."userId"
      WHERE cm."userId" = cc."currentHolderUserId" AND cm."tenantId" = ${actor.tenantId}::uuid AND cm."companyId" = ${actor.companyId}::uuid AND cm."status" = 'active' AND tm."status" = 'active'))
    AND ${buildQueueScopeSql(actor)}`;
  const whereParts: Prisma.Sql[] = [
    scopeSql,
    Prisma.sql`cc.status::text IN (${Prisma.join(statuses.map((s) => String(s)))})`,
  ];

  if (kinds.length > 0) {
    whereParts.push(
      Prisma.sql`cc.kind::text IN (${Prisma.join(kinds.map((k) => String(k)))})`,
    );
  }

  if (filters?.from) {
    whereParts.push(Prisma.sql`cc."updatedAt" >= ${filters.from}`);
  }
  if (filters?.to) {
    whereParts.push(Prisma.sql`cc."updatedAt" < ${filters.to}`);
  }

  const rows = await prisma.$queryRaw<
    Array<{
      expectedCount: bigint;
      expectedAmount: number | null;
      heldCount: bigint;
      heldAmount: number | null;
      settledCount: bigint;
      settledAmount: number | null;
      totalCount: bigint;
      totalAmount: number | null;
    }>
  >(
    Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE cc.status = 'expected')::bigint AS "expectedCount",
        COALESCE(SUM(CASE WHEN cc.status = 'expected' THEN COALESCE(cc."collectedAmount", cc."expectedAmount") ELSE 0 END), 0)::double precision AS "expectedAmount",
        COUNT(*) FILTER (WHERE cc.status = 'held')::bigint AS "heldCount",
        COALESCE(SUM(CASE WHEN cc.status = 'held' THEN COALESCE(cc."collectedAmount", cc."expectedAmount") ELSE 0 END), 0)::double precision AS "heldAmount",
        COUNT(*) FILTER (WHERE cc.status = 'settled')::bigint AS "settledCount",
        COALESCE(SUM(CASE WHEN cc.status = 'settled' THEN COALESCE(cc."collectedAmount", cc."expectedAmount") ELSE 0 END), 0)::double precision AS "settledAmount",
        COUNT(*)::bigint AS "totalCount",
        COALESCE(SUM(COALESCE(cc."collectedAmount", cc."expectedAmount")), 0)::double precision AS "totalAmount"
      FROM "CashCollection" cc
      INNER JOIN "Order" o ON o.id = cc."orderId"
      WHERE ${Prisma.join(whereParts, " AND ")}
    `,
  );

  const summary = rows[0] ?? {
    expectedCount: BigInt(0),
    expectedAmount: 0,
    heldCount: BigInt(0),
    heldAmount: 0,
    settledCount: BigInt(0),
    settledAmount: 0,
    totalCount: BigInt(0),
    totalAmount: 0,
  };

  return {
    expectedCount: Number(summary.expectedCount ?? 0),
    expectedAmount: Number(summary.expectedAmount ?? 0),
    heldCount: Number(summary.heldCount ?? 0),
    heldAmount: Number(summary.heldAmount ?? 0),
    settledCount: Number(summary.settledCount ?? 0),
    settledAmount: Number(summary.settledAmount ?? 0),
    totalCount: Number(summary.totalCount ?? 0),
    totalAmount: Number(summary.totalAmount ?? 0),
  };
}

