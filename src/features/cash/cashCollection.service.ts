import {
  AppRole,
  CashCollectionEventType,
  CashCollectionKind,
  CashCollectionStatus,
  CashHolderType,
  PaidBy,
  PaidStatus,
  Prisma,
  WarehouseType,
} from "@prisma/client";

import prisma from "../../config/prismaClient";
import { getOrderById } from "../../services/orders/repo";
import { OrderActor, orderError } from "../../services/orders/orderService.shared";

type WarehouseContext = {
  id: string;
  name: string;
  type: WarehouseType;
};

type DriverContext = {
  id: string;
  name: string | null;
};

type CollectionWithContext = Prisma.CashCollectionGetPayload<{
  include: {
    currentHolderUser: { select: { id: true; name: true; email: true; role: true } };
    currentHolderWarehouse: true;
    events: {
      include: {
        actor: { select: { id: true; name: true; email: true; role: true } };
      };
      orderBy: { createdAt: "asc" };
    };
  };
}>;

async function loadOrderContext(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      assignedDriverId: true,
      currentWarehouseId: true,
      codAmount: true,
      codPaidStatus: true,
      serviceCharge: true,
      serviceChargePaidStatus: true,
      deliveryChargePaidBy: true,
      currency: true,
    },
  });

  if (!order) {
    throw orderError("Order not found", 404);
  }

  return order;
}

async function findCollection(
  tx: Prisma.TransactionClient,
  orderId: string,
  kind: CashCollectionKind,
) {
  return tx.cashCollection.findUnique({
    where: {
      orderId_kind: {
        orderId,
        kind,
      },
    },
    include: {
      currentHolderUser: {
        select: { id: true, name: true, email: true, role: true },
      },
      currentHolderWarehouse: true,
      events: {
        include: {
          actor: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

function isPositiveNumber(value: unknown): value is number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0;
}

function isPendingPaidStatus(value: PaidStatus | null | undefined) {
  return value !== PaidStatus.PAID;
}

function resolveExpectedAmountForKind(
  order: Awaited<ReturnType<typeof loadOrderContext>>,
  kind: CashCollectionKind,
) {
  if (
    kind === CashCollectionKind.cod &&
    isPositiveNumber(order.codAmount) &&
    isPendingPaidStatus(order.codPaidStatus)
  ) {
    return Number(order.codAmount);
  }

  if (
    kind === CashCollectionKind.service_charge &&
    isPositiveNumber(order.serviceCharge) &&
    isPendingPaidStatus(order.serviceChargePaidStatus) &&
    (order.deliveryChargePaidBy === PaidBy.SENDER ||
      order.deliveryChargePaidBy === PaidBy.RECIPIENT)
  ) {
    return Number(order.serviceCharge);
  }

  return null;
}

async function ensureCollectionForCollect(
  tx: Prisma.TransactionClient,
  order: Awaited<ReturnType<typeof loadOrderContext>>,
  kind: CashCollectionKind,
  actor: OrderActor,
) {
  const existing = await findCollection(tx, order.id, kind);
  if (existing) return existing;

  const expectedAmount = resolveExpectedAmountForKind(order, kind);
  if (!isPositiveNumber(expectedAmount)) {
    throw orderError(
      "Cash collection record not found for this order and no collectible amount is configured",
      404,
    );
  }

  await tx.cashCollection.create({
    data: {
      orderId: order.id,
      kind,
      status: CashCollectionStatus.expected,
      expectedAmount,
      currency: order.currency ?? null,
      events: {
        create: {
          eventType: CashCollectionEventType.expected,
          amount: expectedAmount,
          note:
            kind === CashCollectionKind.cod
              ? "COD expected for this order"
              : "Service charge expected for this order",
          actorId: actor.id,
          actorRole: actor.role,
          toHolderType: CashHolderType.none,
          toHolderName: "Not collected yet",
        },
      },
    },
  });

  const created = await findCollection(tx, order.id, kind);
  if (!created) {
    throw orderError("Failed to initialize cash collection record", 500);
  }
  return created;
}

async function loadCollection(
  tx: Prisma.TransactionClient,
  orderId: string,
  kind: CashCollectionKind,
) {
  const collection = await findCollection(tx, orderId, kind);

  if (!collection) {
    throw orderError("Cash collection record not found for this order", 404);
  }

  return collection;
}

function assertActorCanAccessOrder(
  order: Awaited<ReturnType<typeof loadOrderContext>>,
  actor: OrderActor,
) {
  if (actor.role === AppRole.manager) return;

  if (actor.role === AppRole.driver) {
    if (order.assignedDriverId === actor.id) return;
    throw orderError("Only the assigned driver can update cash for this order", 403);
  }

  if (actor.role === AppRole.warehouse) {
    if (actor.warehouseId && order.currentWarehouseId === actor.warehouseId) return;
    throw orderError("Warehouse user can only update cash for orders at their location", 403);
  }

  throw orderError("Forbidden", 403);
}

function assertCollectionMutable(collection: { status: CashCollectionStatus }) {
  if (collection.status === CashCollectionStatus.cancelled) {
    throw orderError("Cancelled cash collection cannot be changed", 400);
  }

  if (collection.status === CashCollectionStatus.settled) {
    throw orderError("Settled cash collection cannot be changed", 400);
  }
}

async function resolveActorWarehouse(
  tx: Prisma.TransactionClient,
  actor: OrderActor,
): Promise<WarehouseContext> {
  if (!actor.warehouseId) {
    throw orderError("Warehouse context is required for this action", 400);
  }

  const warehouse = await tx.warehouse.findUnique({
    where: { id: actor.warehouseId },
    select: { id: true, name: true, type: true },
  });

  if (!warehouse) {
    throw orderError("Warehouse not found", 404);
  }

  return warehouse;
}

async function resolveDriver(
  tx: Prisma.TransactionClient,
  driverId: string,
): Promise<DriverContext> {
  const driver = await tx.user.findUnique({
    where: { id: driverId },
    select: { id: true, name: true, role: true },
  });

  if (!driver || driver.role !== AppRole.driver) {
    throw orderError("Driver not found", 404);
  }

  return { id: driver.id, name: driver.name };
}

function warehouseToHolderType(type: WarehouseType) {
  return type === WarehouseType.pickup_point
    ? CashHolderType.pickup_point
    : CashHolderType.warehouse;
}

function eventHolderName(
  holderType: CashHolderType | null | undefined,
  label?: string | null,
) {
  if (label) return label;
  if (!holderType || holderType === CashHolderType.none) return "Not collected yet";
  return holderType.replace("_", " ");
}

function resolvePaidStatusFromCollection(
  expectedAmount: number | null | undefined,
  collectedAmount: number,
): PaidStatus {
  const expected = Number(expectedAmount ?? 0);
  if (!Number.isFinite(expected) || expected <= 0) {
    return PaidStatus.PAID;
  }
  return collectedAmount >= expected ? PaidStatus.PAID : PaidStatus.PARTIAL;
}

export async function collectOrderCash(params: {
  orderId: string;
  kind: CashCollectionKind;
  amount?: number | null;
  note?: string | null;
  actor: OrderActor;
}) {
  const { orderId, kind, actor } = params;

  await prisma.$transaction(async (tx) => {
    const order = await loadOrderContext(tx, orderId);
    assertActorCanAccessOrder(order, actor);
    const collection = await ensureCollectionForCollect(tx, order, kind, actor);
    assertCollectionMutable(collection);

    let holderType: CashHolderType = CashHolderType.none;
    let holderUserId: string | null = null;
    let holderWarehouseId: string | null = null;
    let holderLabel: string | null = null;

    if (actor.role === AppRole.driver) {
      if (
        collection.status === CashCollectionStatus.held &&
        collection.currentHolderType !== CashHolderType.driver
      ) {
        throw orderError(
          "Driver cannot collect cash already held by another location or person",
          403,
        );
      }

      if (
        collection.status === CashCollectionStatus.held &&
        collection.currentHolderUserId &&
        collection.currentHolderUserId !== actor.id
      ) {
        throw orderError(
          "Driver can only update cash currently held by them",
          403,
        );
      }

      holderType = CashHolderType.driver;
      holderUserId = actor.id;
      holderLabel = collection.currentHolderUser?.name ?? "Driver";
    } else if (actor.role === AppRole.warehouse) {
      if (
        collection.status === CashCollectionStatus.held &&
        collection.currentHolderType === CashHolderType.driver
      ) {
        throw orderError(
          "Warehouse must accept driver cash through handoff, not direct collection",
          400,
        );
      }

      if (
        collection.status === CashCollectionStatus.held &&
        collection.currentHolderType !== CashHolderType.warehouse &&
        collection.currentHolderType !== CashHolderType.pickup_point
      ) {
        throw orderError(
          "Warehouse cannot overwrite cash already held elsewhere",
          403,
        );
      }

      const warehouse = await resolveActorWarehouse(tx, actor);
      holderType = warehouseToHolderType(warehouse.type);
      holderWarehouseId = warehouse.id;
      holderLabel = warehouse.name;
    } else {
      throw orderError(
        "Manager collection requires a specific target holder and is not enabled in this phase",
        400,
      );
    }

    const nextAmount =
      params.amount != null
        ? Number(params.amount)
        : collection.collectedAmount ?? collection.expectedAmount;

    if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
      throw orderError("Collected amount must be greater than zero", 400);
    }

    const nextEventType =
      collection.status === CashCollectionStatus.expected
        ? CashCollectionEventType.collected
        : CashCollectionEventType.handoff;
    const nextPaidStatus = resolvePaidStatusFromCollection(
      collection.expectedAmount,
      nextAmount,
    );

    await tx.cashCollection.update({
      where: { id: collection.id },
      data: {
        status: CashCollectionStatus.held,
        collectedAmount: nextAmount,
        currentHolderType: holderType,
        currentHolderUserId: holderUserId,
        currentHolderWarehouseId: holderWarehouseId,
        currentHolderLabel: holderLabel,
        collectedAt: collection.collectedAt ?? new Date(),
        note: params.note ?? collection.note ?? null,
        events: {
          create: {
            eventType: nextEventType,
            amount: nextAmount,
            note: params.note ?? null,
            fromHolderType: collection.currentHolderType,
            fromHolderId:
              collection.currentHolderUserId ??
              collection.currentHolderWarehouseId ??
              null,
            fromHolderName: eventHolderName(
              collection.currentHolderType,
              collection.currentHolderLabel,
            ),
            toHolderType: holderType,
            toHolderId: holderUserId ?? holderWarehouseId,
            toHolderName: holderLabel,
            actorId: actor.id,
            actorRole: actor.role,
          },
        },
      },
    });

    await tx.order.update({
      where: { id: order.id },
      data:
        kind === CashCollectionKind.cod
          ? { codPaidStatus: nextPaidStatus }
          : { serviceChargePaidStatus: nextPaidStatus },
    });
  });

  return getOrderById(orderId);
}

export async function handoffOrderCash(params: {
  orderId: string;
  kind: CashCollectionKind;
  toHolderType: "driver" | "warehouse" | "pickup_point";
  toDriverId?: string | null;
  toWarehouseId?: string | null;
  note?: string | null;
  actor: OrderActor;
}) {
  const { orderId, kind, actor, toHolderType } = params;

  await prisma.$transaction(async (tx) => {
    const order = await loadOrderContext(tx, orderId);
    const collection = await loadCollection(tx, orderId, kind);

    assertActorCanAccessOrder(order, actor);
    assertCollectionMutable(collection);

    if (collection.status !== CashCollectionStatus.held) {
      throw orderError("Only held cash can be handed off", 400);
    }

    if (actor.role === AppRole.driver) {
      if (
        collection.currentHolderType !== CashHolderType.driver ||
        collection.currentHolderUserId !== actor.id
      ) {
        throw orderError("Driver can only hand off cash currently held by them", 403);
      }
    }

    if (actor.role === AppRole.warehouse) {
      if (
        !actor.warehouseId ||
        collection.currentHolderWarehouseId !== actor.warehouseId
      ) {
        throw orderError("Warehouse can only hand off cash currently held at their location", 403);
      }
    }

    let nextHolderType: CashHolderType = CashHolderType.none;
    let nextHolderUserId: string | null = null;
    let nextHolderWarehouseId: string | null = null;
    let nextHolderLabel: string | null = null;

    if (toHolderType === "driver") {
      if (!params.toDriverId) {
        throw orderError("toDriverId is required when handing off to a driver", 400);
      }
      const driver = await resolveDriver(tx, params.toDriverId);
      nextHolderType = CashHolderType.driver;
      nextHolderUserId = driver.id;
      nextHolderLabel = driver.name ?? "Driver";
    } else {
      const warehouseId =
        params.toWarehouseId ??
        (actor.role === AppRole.warehouse ? actor.warehouseId ?? null : null);

      if (!warehouseId) {
        throw orderError("toWarehouseId is required when handing off to a location", 400);
      }

      const warehouse = await tx.warehouse.findUnique({
        where: { id: warehouseId },
        select: { id: true, name: true, type: true },
      });

      if (!warehouse) {
        throw orderError("Target warehouse not found", 404);
      }

      const actualHolderType = warehouseToHolderType(warehouse.type);
      nextHolderType = actualHolderType;
      nextHolderWarehouseId = warehouse.id;
      nextHolderLabel = warehouse.name;
    }

    await tx.cashCollection.update({
      where: { id: collection.id },
      data: {
        status: CashCollectionStatus.held,
        currentHolderType: nextHolderType,
        currentHolderUserId: nextHolderUserId,
        currentHolderWarehouseId: nextHolderWarehouseId,
        currentHolderLabel: nextHolderLabel,
        note: params.note ?? collection.note ?? null,
        events: {
          create: {
            eventType: CashCollectionEventType.handoff,
            amount: collection.collectedAmount ?? collection.expectedAmount,
            note: params.note ?? null,
            fromHolderType: collection.currentHolderType,
            fromHolderId:
              collection.currentHolderUserId ??
              collection.currentHolderWarehouseId ??
              null,
            fromHolderName: eventHolderName(
              collection.currentHolderType,
              collection.currentHolderLabel,
            ),
            toHolderType: nextHolderType,
            toHolderId: nextHolderUserId ?? nextHolderWarehouseId,
            toHolderName: nextHolderLabel,
            actorId: actor.id,
            actorRole: actor.role,
          },
        },
      },
    });
  });

  return getOrderById(orderId);
}

export async function settleOrderCash(params: {
  orderId: string;
  kind: CashCollectionKind;
  note?: string | null;
  actor: OrderActor;
}) {
  const { orderId, kind, actor } = params;

  if (actor.role !== AppRole.manager) {
    throw orderError("Only managers can settle cash to finance", 403);
  }

  await prisma.$transaction(async (tx) => {
    const order = await loadOrderContext(tx, orderId);
    const collection = await loadCollection(tx, orderId, kind);

    assertActorCanAccessOrder(order, actor);
    assertCollectionMutable(collection);

    if (collection.status !== CashCollectionStatus.held) {
      throw orderError("Only held cash can be settled", 400);
    }

    await tx.cashCollection.update({
      where: { id: collection.id },
      data: {
        status: CashCollectionStatus.settled,
        currentHolderType: CashHolderType.finance,
        currentHolderUserId: null,
        currentHolderWarehouseId: null,
        currentHolderLabel: "Finance",
        settledAt: new Date(),
        note: params.note ?? collection.note ?? null,
        events: {
          create: {
            eventType: CashCollectionEventType.settled,
            amount: collection.collectedAmount ?? collection.expectedAmount,
            note: params.note ?? null,
            fromHolderType: collection.currentHolderType,
            fromHolderId:
              collection.currentHolderUserId ??
              collection.currentHolderWarehouseId ??
              null,
            fromHolderName: eventHolderName(
              collection.currentHolderType,
              collection.currentHolderLabel,
            ),
            toHolderType: CashHolderType.finance,
            toHolderName: "Finance",
            actorId: actor.id,
            actorRole: actor.role,
          },
        },
      },
    });
  });

  return getOrderById(orderId);
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

function buildQueueWhere(actor: OrderActor, filters?: CashQueueFilters) {
  const statuses = normalizeQueueStatuses(filters);
  const kinds = normalizeQueueKinds(filters);
  const and: Prisma.CashCollectionWhereInput[] = [
    { status: { in: statuses } },
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

  if (actor.role === AppRole.manager) {
    return and.length === 1 ? and[0] : { AND: and };
  }

  if (actor.role === AppRole.warehouse) {
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
  if (actor.role === AppRole.manager) {
    return Prisma.sql`1=1`;
  }
  if (actor.role === AppRole.warehouse) {
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
  const { actor, filters } = params;
  const where = buildQueueWhere(actor, filters);
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
          select: { id: true, name: true, email: true, role: true },
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
            role: row.currentHolderUser.role,
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
        (actor.role === AppRole.manager || actor.role === AppRole.warehouse),
      canHandoff:
        row.status === CashCollectionStatus.held &&
        (actor.role === AppRole.manager || actor.role === AppRole.warehouse),
      canSettle:
        row.status === CashCollectionStatus.held && actor.role === AppRole.manager,
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
  const { actor, filters } = params;
  const statuses = normalizeQueueStatuses(filters);
  const kinds = normalizeQueueKinds(filters);
  const scopeSql = buildQueueScopeSql(actor);
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
