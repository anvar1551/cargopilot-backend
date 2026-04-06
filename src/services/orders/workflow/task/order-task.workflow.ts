import prisma from "../../../../config/prismaClient";
import { AppRole, OrderStatus, ReasonCode } from "@prisma/client";
import { OrderActor, orderError } from "../../orderService.shared";

type AssignmentType = "pickup" | "delivery" | "linehaul";

const FINAL_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.delivered,
  OrderStatus.returned,
  OrderStatus.cancelled,
];

const WAREHOUSE_ALLOWED_MANUAL_STATUSES = new Set<OrderStatus>([
  OrderStatus.at_warehouse,
  OrderStatus.in_transit,
  OrderStatus.out_for_delivery,
  OrderStatus.exception,
]);

const ASSIGNABLE_ORDER_STATUSES: Record<AssignmentType, OrderStatus[]> = {
  pickup: [OrderStatus.pending, OrderStatus.assigned, OrderStatus.exception],
  delivery: [
    OrderStatus.at_warehouse,
    OrderStatus.out_for_delivery,
    OrderStatus.exception,
  ],
  linehaul: [
    OrderStatus.at_warehouse,
    OrderStatus.in_transit,
    OrderStatus.exception,
  ],
};

const REASON_REQUIRED_STATUSES = new Set<OrderStatus>([
  OrderStatus.exception,
  OrderStatus.return_in_progress,
  OrderStatus.cancelled,
]);

const PICKUP_REASON_CODES = new Set<ReasonCode>([
  ReasonCode.BAD_SENDER_ADDRESS,
  ReasonCode.SENDER_NOT_AVAILABLE,
  ReasonCode.SENDER_MOBILE_OFF,
  ReasonCode.SENDER_MOBILE_WRONG,
  ReasonCode.SENDER_MOBILE_NO_RESPONSE,
  ReasonCode.OUT_OF_PICKUP_AREA,
  ReasonCode.UNABLE_TO_ACCESS_SENDER_PREMISES,
  ReasonCode.NO_CAPACITY_PICKUP,
  ReasonCode.PROHIBITED_ITEMS,
  ReasonCode.INCORRECT_PACKING,
  ReasonCode.NO_AWB_PRINTED,
  ReasonCode.PICKUP_DELAY_LATE_BOOKING,
  ReasonCode.BAD_WEATHER_PICKUP,
  ReasonCode.SENDER_NAME_MISSING,
  ReasonCode.DOCUMENTS_MISSING,
]);

const DRIVER_ALLOWED_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> =
  {
    [OrderStatus.assigned]: [OrderStatus.pickup_in_progress],
    [OrderStatus.pickup_in_progress]: [
      OrderStatus.picked_up,
      OrderStatus.exception,
    ],
    [OrderStatus.at_warehouse]: [OrderStatus.out_for_delivery],
    [OrderStatus.out_for_delivery]: [
      OrderStatus.delivered,
      OrderStatus.exception,
      OrderStatus.return_in_progress,
    ],
    [OrderStatus.exception]: [
      OrderStatus.pickup_in_progress,
      OrderStatus.out_for_delivery,
      OrderStatus.return_in_progress,
    ],
  };

function isPickupReason(reasonCode?: ReasonCode | null) {
  return !!reasonCode && PICKUP_REASON_CODES.has(reasonCode);
}

function getDriverAllowedTransitionsForOrder(order: {
  status: OrderStatus;
  lastExceptionReason?: ReasonCode | null;
}) {
  if (order.status !== OrderStatus.exception) {
    return DRIVER_ALLOWED_TRANSITIONS[order.status] ?? [];
  }

  if (isPickupReason(order.lastExceptionReason)) {
    return [OrderStatus.pickup_in_progress];
  }

  return [OrderStatus.out_for_delivery, OrderStatus.return_in_progress];
}

function normalizeAssignmentType(input: unknown): AssignmentType {
  if (input === "pickup" || input === "delivery" || input === "linehaul") {
    return input;
  }
  return "pickup";
}

function assertManagerOrWarehouse(actor: OrderActor) {
  if (actor.role !== AppRole.manager && actor.role !== AppRole.warehouse) {
    throw orderError("Only manager or warehouse can perform this action", 403);
  }
}

function assertWarehouseScope(
  actor: OrderActor,
  orders: Array<{ id: string; currentWarehouseId: string | null }>,
) {
  if (actor.role !== AppRole.warehouse) return;
  if (!actor.warehouseId) {
    throw orderError("Warehouse user has no warehouse assigned", 403);
  }
  const wrong = orders.filter(
    (o) => o.currentWarehouseId && o.currentWarehouseId !== actor.warehouseId,
  );
  if (wrong.length) {
    throw orderError(
      `Orders not in your warehouse: ${wrong.map((x) => x.id).join(", ")}`,
      403,
    );
  }
}

function resolveWarehouseId(actor: OrderActor, provided?: string | null) {
  if (actor.role === AppRole.warehouse) return actor.warehouseId ?? null;
  return provided ?? null;
}

function formatStatus(status: OrderStatus) {
  return status.replace(/_/g, " ");
}

async function loadAssignedOrdersForResponse(
  orderIds: string[],
  includeFull?: boolean,
) {
  if (includeFull) {
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

  return prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      assignedDriverId: true,
      currentWarehouseId: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Assigns driver to orders directly and records assignment history. */
export async function assignDriversBulk(args: {
  orderIds: string[];
  driverId: string;
  type?: AssignmentType | string;
  warehouseId?: string | null;
  note?: string | null;
  region?: string | null;
  actor: OrderActor;
  includeFull?: boolean;
}) {
  const { orderIds, driverId, warehouseId, note, region, actor, includeFull } =
    args;
  const type = normalizeAssignmentType(args.type);

  assertManagerOrWarehouse(actor);

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw orderError("orderIds must be a non-empty array", 400);
  }
  if (!driverId) throw orderError("Missing driverId", 400);

  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { id: true, role: true },
  });
  if (!driver || driver.role !== AppRole.driver) {
    throw orderError("Driver not found or invalid role", 400);
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      status: true,
      currentWarehouseId: true,
    },
  });
  if (orders.length !== orderIds.length) {
    throw orderError("Some orders were not found", 400);
  }

  const final = orders.filter((o) => FINAL_ORDER_STATUSES.includes(o.status));
  if (final.length) {
    throw orderError(
      `Cannot assign driver for final orders: ${final
        .map((o) => `${o.id}(${o.status})`)
        .join(", ")}`,
      400,
    );
  }

  assertWarehouseScope(actor, orders);

  const blocked = orders.filter(
    (o) => !ASSIGNABLE_ORDER_STATUSES[type].includes(o.status),
  );
  if (blocked.length) {
    const blockedStages = Array.from(
      new Set(blocked.map((o) => formatStatus(o.status))),
    ).join(", ");
    const allowedStages = ASSIGNABLE_ORDER_STATUSES[type]
      .map(formatStatus)
      .join(", ");
    throw orderError(
      `Assignment is not possible at the current stage for ${type}. Current stages: ${blockedStages}. Allowed stages for ${type}: ${allowedStages}.`,
      400,
    );
  }

  const effectiveWarehouseId = resolveWarehouseId(actor, warehouseId);
  await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({
      where: { id: { in: orderIds } },
      data: { assignedDriverId: driverId },
    });

    if (type === "pickup") {
      await tx.order.updateMany({
        where: {
          id: { in: orderIds },
          status: { in: [OrderStatus.pending, OrderStatus.exception] },
        },
        data: { status: OrderStatus.assigned },
      });
    }

    await tx.tracking.createMany({
      data: orderIds.map((orderId) => ({
        orderId,
        status: type === "pickup" ? OrderStatus.assigned : null,
        reasonCode: null,
        note: note ?? `Driver assigned (${type}) to ${driverId}`,
        region: region ?? null,
        warehouseId: effectiveWarehouseId,
        actorId: actor.id,
        actorRole: actor.role,
        parcelId: null,
      })),
    });
  });

  return loadAssignedOrdersForResponse(orderIds, includeFull);
}

/** Backward-compatible alias for older controller names. */
export async function assignOrderTasksBulk(args: {
  orderIds: string[];
  driverId: string;
  type?: AssignmentType | string;
  warehouseId?: string | null;
  note?: string | null;
  region?: string | null;
  actor: OrderActor;
  includeFull?: boolean;
}) {
  return assignDriversBulk(args);
}

/** Applies bulk status updates for manager/warehouse operations. */
export async function updateOrdersStatusBulk(args: {
  orderIds: string[];
  status: OrderStatus;
  reasonCode?: ReasonCode | null;
  warehouseId?: string | null;
  note?: string | null;
  region?: string | null;
  actor: OrderActor;
  includeFull?: boolean;
}) {
  const {
    orderIds,
    status,
    reasonCode,
    warehouseId,
    note,
    region,
    actor,
    includeFull,
  } = args;

  assertManagerOrWarehouse(actor);

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw orderError("orderIds must be a non-empty array", 400);
  }

  if (actor.role === AppRole.warehouse) {
    if (!WAREHOUSE_ALLOWED_MANUAL_STATUSES.has(status)) {
      throw orderError(
        `Warehouse role can set only: ${Array.from(WAREHOUSE_ALLOWED_MANUAL_STATUSES).join(", ")}`,
        403,
      );
    }
  }

  if (REASON_REQUIRED_STATUSES.has(status) && !reasonCode) {
    throw orderError(`reasonCode is required when status is ${status}`, 400);
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, status: true, currentWarehouseId: true },
  });
  if (orders.length !== orderIds.length) {
    throw orderError("Some orders were not found", 400);
  }

  assertWarehouseScope(actor, orders);

  const effectiveWarehouseId = resolveWarehouseId(actor, warehouseId);
  const requiresWarehouseContext =
    status === OrderStatus.at_warehouse ||
    status === OrderStatus.in_transit ||
    status === OrderStatus.out_for_delivery;

  if (requiresWarehouseContext && !effectiveWarehouseId) {
    throw orderError("warehouseId is required for this update", 400);
  }

  const updateData: any = { status };
  if (status === OrderStatus.at_warehouse && effectiveWarehouseId) {
    updateData.currentWarehouseId = effectiveWarehouseId;
    // Once the shipment is received into a warehouse, the active driver assignment ends.
    updateData.assignedDriverId = null;
  }
  if (status === OrderStatus.exception) {
    updateData.lastExceptionReason = reasonCode ?? null;
    updateData.lastExceptionAt = new Date();
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({
      where: { id: { in: orderIds } },
      data: updateData,
    });

    await tx.tracking.createMany({
      data: orderIds.map((orderId) => ({
        orderId,
        status,
        reasonCode: reasonCode ?? null,
        note: note ?? null,
        region: region ?? null,
        warehouseId: effectiveWarehouseId,
        actorId: actor.id,
        actorRole: actor.role,
        parcelId: null,
      })),
    });
  });

  if (includeFull) {
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

  return prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      assignedDriverId: true,
      currentWarehouseId: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Applies a single order status transition allowed for a driver on their assigned order. */
export async function updateDriverOrderStatus(args: {
  orderId: string;
  status: OrderStatus;
  reasonCode?: ReasonCode | null;
  note?: string | null;
  region?: string | null;
  actor: OrderActor;
}) {
  const { orderId, status, reasonCode, note, region, actor } = args;

  if (actor.role !== AppRole.driver) {
    throw orderError("Only driver can perform this action", 403);
  }
  if (!orderId) {
    throw orderError("orderId is required", 400);
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      lastExceptionReason: true,
      assignedDriverId: true,
      currentWarehouseId: true,
    },
  });
  if (!order) {
    throw orderError("Order not found", 404);
  }
  if (order.assignedDriverId !== actor.id) {
    throw orderError("You are not assigned to this order", 403);
  }
  if (FINAL_ORDER_STATUSES.includes(order.status)) {
    throw orderError("Order is already in final state", 400);
  }

  const allowedNext = getDriverAllowedTransitionsForOrder(order);
  if (!allowedNext.includes(status)) {
    const currentStage = formatStatus(order.status);
    const targetStage = formatStatus(status);
    const allowedStages = allowedNext.map(formatStatus).join(", ");
    throw orderError(
      `Driver cannot move order from ${currentStage} to ${targetStage}. Allowed next stages: ${allowedStages || "none"}.`,
      400,
    );
  }

  if (REASON_REQUIRED_STATUSES.has(status) && !reasonCode) {
    throw orderError(`reasonCode is required when status is ${status}`, 400);
  }

  const updateData: any = { status };
  if (status === OrderStatus.at_warehouse) {
    // A driver handing over to warehouse should release ownership until the next assignment.
    updateData.assignedDriverId = null;
  }
  if (status === OrderStatus.exception) {
    updateData.lastExceptionReason = reasonCode ?? null;
    updateData.lastExceptionAt = new Date();
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: updateData,
    });

    await tx.tracking.create({
      data: {
        orderId,
        status,
        reasonCode: reasonCode ?? null,
        note: note ?? null,
        region: region ?? null,
        warehouseId: order.currentWarehouseId ?? null,
        actorId: actor.id,
        actorRole: actor.role,
        parcelId: null,
      },
    });
  });

  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      assignedDriverId: true,
      currentWarehouseId: true,
      updatedAt: true,
    },
  });
}
