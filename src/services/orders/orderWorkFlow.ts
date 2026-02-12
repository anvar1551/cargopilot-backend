import prisma from "../../config/prismaClient";
import {
  AppRole,
  OrderStatus,
  TrackingAction,
  ReasonCode,
} from "@prisma/client";

type Actor = {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
};

// ---------- 1) Define “who can do what” ----------

const ROLE_ALLOWED_ACTIONS: Record<AppRole, TrackingAction[]> = {
  customer: [],
  driver: [
    TrackingAction.PICKUP_STARTED,
    TrackingAction.PICKUP_ATTEMPT,
    TrackingAction.PICKUP_CONFIRMED,
    TrackingAction.PICKUP_FAILED,

    TrackingAction.DELIVERY_STARTED,
    TrackingAction.DELIVERY_ATTEMPT,
    TrackingAction.DELIVERED,
    TrackingAction.DELIVERY_FAILED,

    TrackingAction.RETURN_REQUESTED,
    TrackingAction.RETURN_DISPATCHED,
    TrackingAction.RETURN_DELIVERED,
  ],
  warehouse: [
    TrackingAction.ARRIVED_AT_WAREHOUSE,
    TrackingAction.SORTED,
    TrackingAction.DISPATCHED,
    TrackingAction.ON_HOLD,
  ],
  manager: [
    // NOTE: keep DRIVER_ASSIGNED here only if you really want to log it via workflow
    // but actual assignment should happen through assignOrdersToDriver().
    TrackingAction.DRIVER_ASSIGNED,
    TrackingAction.DRIVER_REJECTED,

    TrackingAction.PICKUP_STARTED,
    TrackingAction.PICKUP_ATTEMPT,
    TrackingAction.PICKUP_CONFIRMED,
    TrackingAction.PICKUP_FAILED,

    TrackingAction.ARRIVED_AT_WAREHOUSE,
    TrackingAction.SORTED,
    TrackingAction.DISPATCHED,

    TrackingAction.DELIVERY_STARTED,
    TrackingAction.DELIVERY_ATTEMPT,
    TrackingAction.DELIVERED,
    TrackingAction.DELIVERY_FAILED,

    TrackingAction.ON_HOLD,
    TrackingAction.CANCELLED,

    TrackingAction.RETURN_REQUESTED,
    TrackingAction.RETURN_DISPATCHED,
    TrackingAction.RETURN_DELIVERED,
  ],
};

// ---------- 2) Map action -> resulting order status ----------

function statusFromAction(action: TrackingAction): OrderStatus | null {
  switch (action) {
    case TrackingAction.DRIVER_ASSIGNED:
      return OrderStatus.assigned;

    case TrackingAction.PICKUP_STARTED:
      return OrderStatus.pickup_in_progress;

    case TrackingAction.PICKUP_CONFIRMED:
      return OrderStatus.picked_up;

    case TrackingAction.ARRIVED_AT_WAREHOUSE:
      return OrderStatus.at_warehouse;

    case TrackingAction.DISPATCHED:
      return OrderStatus.in_transit;

    case TrackingAction.DELIVERY_STARTED:
      return OrderStatus.out_for_delivery;

    case TrackingAction.DELIVERED:
      return OrderStatus.delivered;

    case TrackingAction.PICKUP_FAILED:
    case TrackingAction.DELIVERY_FAILED:
    case TrackingAction.ON_HOLD:
      return OrderStatus.exception;

    case TrackingAction.CANCELLED:
      return OrderStatus.cancelled;

    case TrackingAction.RETURN_REQUESTED:
    case TrackingAction.RETURN_DISPATCHED:
      return OrderStatus.return_in_progress;

    case TrackingAction.RETURN_DELIVERED:
      return OrderStatus.returned;

    // Attempt / info actions don't need to change status
    case TrackingAction.PICKUP_ATTEMPT:
    case TrackingAction.DELIVERY_ATTEMPT:
    case TrackingAction.SORTED:
    case TrackingAction.DRIVER_REJECTED:
    case TrackingAction.ORDER_CREATED:
    default:
      return null;
  }
}

// ---------- 3) Allowed status transitions ----------

const ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.pending]: [
    OrderStatus.assigned,
    OrderStatus.pickup_in_progress,
    OrderStatus.cancelled,
    OrderStatus.exception,
  ],

  [OrderStatus.assigned]: [
    OrderStatus.pickup_in_progress,
    OrderStatus.cancelled,
    OrderStatus.exception,
  ],

  [OrderStatus.pickup_in_progress]: [
    OrderStatus.picked_up,
    OrderStatus.exception,
    OrderStatus.cancelled,
  ],

  [OrderStatus.picked_up]: [
    OrderStatus.at_warehouse,
    OrderStatus.in_transit,
    OrderStatus.exception,
  ],

  [OrderStatus.at_warehouse]: [OrderStatus.in_transit, OrderStatus.exception],

  [OrderStatus.in_transit]: [
    OrderStatus.out_for_delivery,
    OrderStatus.exception,
  ],

  [OrderStatus.out_for_delivery]: [
    OrderStatus.delivered,
    OrderStatus.exception,
    OrderStatus.return_in_progress,
  ],

  [OrderStatus.exception]: [
    OrderStatus.pickup_in_progress,
    OrderStatus.in_transit,
    OrderStatus.out_for_delivery,
    OrderStatus.return_in_progress,
    OrderStatus.cancelled,
  ],

  [OrderStatus.return_in_progress]: [
    OrderStatus.returned,
    OrderStatus.exception,
  ],

  [OrderStatus.returned]: [],
  [OrderStatus.delivered]: [],
  [OrderStatus.cancelled]: [],
};

// ---------- Helpers ----------

function err(message: string, statusCode = 400) {
  const e: any = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function assertRoleAllowed(actor: Actor, action: TrackingAction) {
  const allowed = ROLE_ALLOWED_ACTIONS[actor.role] ?? [];
  if (!allowed.includes(action)) {
    throw err(`Role ${actor.role} cannot perform action ${action}`, 403);
  }
}

function assertTransition(current: OrderStatus, next: OrderStatus) {
  const allowed = ALLOWED_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw err(`Invalid transition: ${current} -> ${next}`, 400);
  }
}

function requiresReason(action: TrackingAction) {
  return (
    action === TrackingAction.PICKUP_FAILED ||
    action === TrackingAction.DELIVERY_FAILED ||
    action === TrackingAction.ON_HOLD ||
    action === TrackingAction.CANCELLED ||
    action === TrackingAction.RETURN_REQUESTED
  );
}

const FINAL_STATUSES: OrderStatus[] = [
  OrderStatus.delivered,
  OrderStatus.returned,
  OrderStatus.cancelled,
];

// ✅ assignment should only happen in certain states
const ASSIGNABLE_STATUSES: OrderStatus[] = [
  OrderStatus.pending,
  OrderStatus.exception,
];

const WAREHOUSE_ACTIONS: TrackingAction[] = [
  TrackingAction.ARRIVED_AT_WAREHOUSE,
  TrackingAction.SORTED,
  TrackingAction.DISPATCHED,
];

// ---------- 4) Single + Bulk unified core ----------

type UpdateArgs = {
  orderIds: string[];
  action: TrackingAction;
  reasonCode?: ReasonCode | null;
  note?: string | null;
  region?: string | null;
  warehouseId?: string | null;
  parcelId?: string | null;
  actor: Actor;
};

export async function updateOrderStatusMany(args: UpdateArgs) {
  const {
    orderIds,
    action,
    reasonCode,
    note,
    region,
    warehouseId,
    parcelId,
    actor,
  } = args;

  if (!Array.isArray(orderIds) || orderIds.length === 0)
    throw err("orderIds must be a non-empty array", 400);
  if (!action) throw err("Missing action", 400);

  assertRoleAllowed(actor, action);

  if (requiresReason(action) && !reasonCode) {
    throw err(`reasonCode is required for action ${action}`, 400);
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      status: true,
      assignedDriverId: true,
      currentWarehouseId: true,
    },
  });

  if (orders.length !== orderIds.length) {
    const missing = orderIds.filter((id) => !orders.some((o) => o.id === id));
    throw err(`Some orders not found: ${missing.join(", ")}`, 404);
  }

  // ✅ block actions on final orders (except manager can still add info? keep strict for now)
  const final = orders.filter((o) => FINAL_STATUSES.includes(o.status));
  if (final.length) {
    throw err(
      `Cannot update final orders: ${final.map((x) => `${x.id}(${x.status})`).join(", ")}`,
      400,
    );
  }

  // Driver must be assigned
  if (actor.role === AppRole.driver) {
    const notAssigned = orders.filter((o) => o.assignedDriverId !== actor.id);
    if (notAssigned.length) {
      throw err(
        `Driver not assigned to orders: ${notAssigned.map((x) => x.id).join(", ")}`,
        403,
      );
    }
  }

  // Warehouse constraint (if order already has warehouse)
  if (actor.role === AppRole.warehouse && actor.warehouseId) {
    const wrong = orders.filter(
      (o) => o.currentWarehouseId && o.currentWarehouseId !== actor.warehouseId,
    );
    if (wrong.length) {
      throw err(
        `Orders not in your warehouse: ${wrong.map((x) => x.id).join(", ")}`,
        403,
      );
    }
  }

  const nextStatus = statusFromAction(action);

  // ✅ IMPORTANT: don’t allow DRIVER_ASSIGNED in workflow because it can’t set assignedDriverId
  // Force using assignOrdersToDriver() endpoint.
  if (action === TrackingAction.DRIVER_ASSIGNED) {
    throw err(
      "Use assignOrdersToDriver() to assign a driver (action alone is not enough).",
      400,
    );
  }

  if (nextStatus) {
    const invalid: string[] = [];
    for (const o of orders) {
      try {
        assertTransition(o.status as OrderStatus, nextStatus);
      } catch {
        invalid.push(`${o.id} (${o.status} -> ${nextStatus})`);
      }
    }
    if (invalid.length)
      throw err(`Bulk update blocked: ${invalid.join("; ")}`, 400);
  }

  const effectiveWarehouseId = warehouseId ?? actor.warehouseId ?? null;

  // ✅ warehouse actions must have a warehouse id
  if (WAREHOUSE_ACTIONS.includes(action) && !effectiveWarehouseId) {
    throw err(`warehouseId is required for action ${action}`, 400);
  }

  const trackingWarehouseId =
    warehouseId != null
      ? warehouseId
      : WAREHOUSE_ACTIONS.includes(action) || actor.role === AppRole.warehouse
        ? effectiveWarehouseId
        : null;

  const orderUpdateData: any = {};

  if (nextStatus) orderUpdateData.status = nextStatus;

  if (action === TrackingAction.ARRIVED_AT_WAREHOUSE) {
    orderUpdateData.currentWarehouseId = effectiveWarehouseId;
  }

  if (action === TrackingAction.PICKUP_ATTEMPT) {
    orderUpdateData.pickupAttemptCount = { increment: 1 };
  }
  if (action === TrackingAction.DELIVERY_ATTEMPT) {
    orderUpdateData.deliveryAttemptCount = { increment: 1 };
  }

  const isExceptionAction =
    action === TrackingAction.PICKUP_FAILED ||
    action === TrackingAction.DELIVERY_FAILED ||
    action === TrackingAction.ON_HOLD ||
    action === TrackingAction.CANCELLED ||
    action === TrackingAction.RETURN_REQUESTED;

  if (isExceptionAction) {
    orderUpdateData.lastExceptionReason = reasonCode ?? null;
    orderUpdateData.lastExceptionAt = new Date();
  }

  await prisma.$transaction([
    prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: Object.keys(orderUpdateData).length ? orderUpdateData : {},
    }),

    prisma.tracking.createMany({
      data: orderIds.map((orderId) => ({
        orderId,
        action,
        status: nextStatus ?? null,
        reasonCode: reasonCode ?? null,
        note: note ?? null,
        region: region ?? null,
        warehouseId: trackingWarehouseId,
        actorId: actor.id,
        actorRole: actor.role,
        parcelId: parcelId ?? null,
      })),
    }),
  ]);

  return prisma.order.findMany({
    where: { id: { in: orderIds } },
    include: {
      customer: true,
      assignedDriver: true,
      currentWarehouse: true,
      parcels: true,
      trackingEvents: {
        include: { actor: true, warehouse: true, parcel: true },
        orderBy: { timestamp: "asc" },
      },
      invoice: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateOrderStatus(
  args: Omit<UpdateArgs, "orderIds"> & { orderId: string },
) {
  const list = await updateOrderStatusMany({
    orderIds: [args.orderId],
    action: args.action,
    reasonCode: args.reasonCode ?? null,
    note: args.note ?? null,
    region: args.region ?? null,
    warehouseId: args.warehouseId ?? null,
    parcelId: args.parcelId ?? null,
    actor: args.actor,
  });

  return list[0];
}

// ---------- 5) Assign driver workflow ----------

export async function assignOrdersToDriver(args: {
  orderIds: string[];
  driverId: string;
  actor?: Actor;
}) {
  const { orderIds, driverId, actor } = args;

  if (!Array.isArray(orderIds) || orderIds.length === 0)
    throw err("orderIds must be a non-empty array", 400);

  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { id: true, role: true },
  });

  if (!driver || driver.role !== AppRole.driver)
    throw err("Driver not found or invalid role", 400);

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, status: true },
  });

  if (orders.length !== orderIds.length)
    throw err("Some orders were not found", 400);

  const blocked = orders.filter((o) => !ASSIGNABLE_STATUSES.includes(o.status));
  if (blocked.length) {
    throw err(
      `Cannot assign driver in these states: ${blocked
        .map((x) => `${x.id}(${x.status})`)
        .join(", ")}`,
      400,
    );
  }

  await prisma.$transaction([
    prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { assignedDriverId: driverId, status: OrderStatus.assigned },
    }),

    prisma.tracking.createMany({
      data: orderIds.map((orderId) => ({
        orderId,
        action: TrackingAction.DRIVER_ASSIGNED,
        status: OrderStatus.assigned,
        reasonCode: null,
        note: `Assigned to driver ${driverId}`,
        region: null,
        warehouseId: null,
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        parcelId: null,
      })),
    }),
  ]);

  return prisma.order.findMany({
    where: { id: { in: orderIds } },
    include: {
      customer: true,
      assignedDriver: true,
      currentWarehouse: true,
      parcels: true,
      trackingEvents: {
        include: { actor: true, warehouse: true, parcel: true },
        orderBy: { timestamp: "asc" },
      },
      invoice: true,
    },
    orderBy: { createdAt: "desc" },
  });
}
