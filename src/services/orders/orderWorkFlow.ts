import prisma from "../../config/prismaClient";
import { AppRole, OrderStatus } from "@prisma/client";

const allowedForDriver: OrderStatus[] = [
  "in_transit",
  "out_for_delivery",
  "delivered",
];
const allowedForWarehouse: OrderStatus[] = ["arrived_at_warehouse"];

const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
  pending: ["in_transit", "assigned"],
  assigned: ["in_transit"],
  in_transit: ["arrived_at_warehouse", "out_for_delivery", "delivered"],
  arrived_at_warehouse: ["out_for_delivery"],
  out_for_delivery: ["delivered"],
  delivered: [],
};

type Actor = {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
};

export async function updateOrderStatusMany(args: {
  orderIds: string[];
  status: OrderStatus;
  region?: string | null;
  warehouseId?: string | null;
  note?: string | null;
  actor: Actor;
}) {
  const { orderIds, status, region, warehouseId, note, actor } = args;

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    const e: any = new Error("orderIds must be a non-empty array");
    e.statusCode = 400;
    throw e;
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
    const e: any = new Error(`Some orders not found: ${missing.join(", ")}`);
    e.statusCode = 404;
    throw e;
  }

  // permissions by role
  if (actor.role === "driver" && !allowedForDriver.includes(status)) {
    const e: any = new Error("Drivers cannot set this status");
    e.statusCode = 403;
    throw e;
  }
  if (actor.role === "warehouse" && !allowedForWarehouse.includes(status)) {
    const e: any = new Error("Warehouse cannot set this status");
    e.statusCode = 403;
    throw e;
  }

  const invalid: string[] = [];

  for (const o of orders) {
    const possibleNext = allowedTransitions[o.status] ?? [];
    if (!possibleNext.includes(status)) {
      invalid.push(`${o.id} (${o.status} -> ${status})`);
      continue;
    }

    // driver must be assigned
    if (actor.role === "driver" && o.assignedDriverId !== actor.id) {
      invalid.push(`${o.id} (driver not assigned)`);
      continue;
    }

    // warehouse constraint
    if (
      actor.role === "warehouse" &&
      actor.warehouseId &&
      o.currentWarehouseId &&
      o.currentWarehouseId !== actor.warehouseId
    ) {
      invalid.push(`${o.id} (wrong warehouse)`);
      continue;
    }

    // ✅ cannot set "assigned" unless a driver exists
    if (status === "assigned" && !o.assignedDriverId) {
      invalid.push(`${o.id} (cannot set assigned without driver)`);
      continue;
    }
  }

  if (invalid.length) {
    const e: any = new Error(`Bulk update blocked: ${invalid.join("; ")}`);
    e.statusCode = 400;
    throw e;
  }

  const effectiveWarehouseId = warehouseId ?? actor.warehouseId ?? null;

  // ✅ keep tracking clean: only attach warehouseId if this event is warehouse-related
  const trackingWarehouseId =
    status === "arrived_at_warehouse" ? effectiveWarehouseId : null;

  await prisma.$transaction([
    prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: {
        status,
        ...(status === "arrived_at_warehouse"
          ? { currentWarehouseId: effectiveWarehouseId }
          : {}),
      },
    }),

    prisma.tracking.createMany({
      data: orderIds.map((orderId) => ({
        orderId,
        event: "status_changed",
        status,
        note: note ?? null,
        region: region ?? null,
        warehouseId: trackingWarehouseId,
        actorId: actor.id,
        actorRole: actor.role,
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
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateOrderStatus(args: {
  orderId: string;
  status: OrderStatus;
  region?: string | null;
  warehouseId?: string | null;
  note?: string | null;
  actor: Actor;
}) {
  const orders = await updateOrderStatusMany({
    orderIds: [args.orderId],
    status: args.status,
    region: args.region,
    warehouseId: args.warehouseId,
    note: args.note,
    actor: args.actor,
  });

  return orders[0];
}

// ------- Bulk assign workflow (moved out of controller) -------
export async function assignOrdersToDriver(args: {
  orderIds: string[];
  driverId: string;
  actor?: Actor; // manager user (optional but recommended)
}) {
  const { orderIds, driverId, actor } = args;

  const driver = await prisma.user.findUnique({
    where: { id: driverId },
    select: { id: true, role: true },
  });

  if (!driver || driver.role !== "driver") {
    const e: any = new Error("Driver not found or invalid role");
    e.statusCode = 400;
    throw e;
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, status: true },
  });

  if (orders.length !== orderIds.length) {
    const e: any = new Error("Some orders were not found");
    e.statusCode = 400;
    throw e;
  }

  const delivered = orders.filter((o) => o.status === "delivered");
  if (delivered.length) {
    const e: any = new Error(
      `Cannot assign delivered orders: ${delivered.map((d) => d.id).join(", ")}`,
    );
    e.statusCode = 400;
    throw e;
  }

  await prisma.$transaction([
    prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { assignedDriverId: driverId, status: "assigned" },
    }),

    prisma.tracking.createMany({
      data: orderIds.map((orderId) => ({
        orderId,
        event: "assigned_driver",
        status: "assigned",
        note: `Assigned to driver ${driverId}`,
        region: null,
        warehouseId: null,
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
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
      trackingEvents: { orderBy: { timestamp: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });
}
