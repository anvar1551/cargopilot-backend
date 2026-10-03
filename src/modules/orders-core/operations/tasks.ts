import { committedDispatchNotifications } from "../domain/dispatch-notification";
import { committedDispatchChanges } from "../domain/dispatch-batch";
import { OrderStatus, ReasonCode } from "@prisma/client";
import {
  emitPersistedDriverNotification,
  emitDriverOrderUpdate,
} from "../../../modules/realtime-core/realtimeHub";
import {
  assignDriversBulk as assignDriversBulkDomain,
  updateDriverOrderStatus,
  updateOrdersStatusBulk,
} from "./order-status";
import { normalizeBulkOrderIds, orderError } from "../shared";
import type { OrderActor } from "../shared";

type AssignTaskInput = {
  actor: OrderActor;
  body: {
    driverId?: string;
    type?: "pickup" | "delivery" | "linehaul";
    warehouseId?: string | null;
    note?: string | null;
    region?: string | null;
    orderIds?: unknown;
    expectedStates?: unknown;
  };
  includeFull: boolean;
};

type UpdateStatusBulkInput = {
  actor: OrderActor;
  body: {
    status?: OrderStatus;
    reasonCode?: ReasonCode;
    warehouseId?: string | null;
    note?: string | null;
    region?: string | null;
    orderIds?: unknown;
    expectedStates?: unknown;
  };
  includeFull: boolean;
};

type UpdateDriverStatusInput = {
  actor: OrderActor;
  body: {
    orderId?: string;
    status?: OrderStatus;
    reasonCode?: ReasonCode;
    note?: string | null;
    region?: string | null;
  };
};

export async function assignTasksBulkForActor(input: AssignTaskInput) {
  const { actor, body, includeFull } = input;
  const { driverId, type, warehouseId, note, region } = body;
  const orderIds = normalizeBulkOrderIds(body.orderIds);

  if (!driverId) {
    const err = new Error("Missing driverId") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const orders = await assignDriversBulkDomain({
    orderIds,
    expectedStates: body.expectedStates,
    driverId,
    type,
    warehouseId: warehouseId ?? null,
    note: note ?? null,
    region: region ?? null,
    actor,
    includeFull,
  });

  for (const order of committedDispatchChanges(orders) as any[]) {
    const assignedDriverId = String(order?.assignedDriverId ?? driverId).trim();
    if (!assignedDriverId) continue;
    const eventOrderId = String(order?.id ?? "").trim();
    const orderNumber = String(order?.orderNumber ?? "").trim();
    const nextStatus = String(order?.status ?? "");

    void emitDriverOrderUpdate(assignedDriverId, {
      orderId: eventOrderId,
      orderNumber: orderNumber || null,
      status: nextStatus,
      updatedAt: new Date(order.updatedAt).toISOString(),
    }).catch(() => undefined);

  }

  for (const id of committedDispatchNotifications(orders)) void emitPersistedDriverNotification(id).catch(() => undefined);

  return {
    success: true,
    message: `Assigned driver to ${orders.length} order(s)`,
    count: orders.length,
    orders,
  };
}

export const assignDriversBulkForActor = assignTasksBulkForActor;

export async function updateStatusBulkForActor(input: UpdateStatusBulkInput) {
  const { actor, body, includeFull } = input;
  const { status, reasonCode, warehouseId, note, region } = body;
  const orderIds = normalizeBulkOrderIds(body.orderIds);

  if (!status) {
    const err = new Error("Missing status") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const orders = await updateOrdersStatusBulk({
    orderIds,
    expectedStates: body.expectedStates,
    status,
    reasonCode: reasonCode ?? null,
    warehouseId: warehouseId ?? null,
    note: note ?? null,
    region: region ?? null,
    actor,
    includeFull,
  });

  for (const order of committedDispatchChanges(orders) as any[]) {
    const assignedDriverId = String(order?.assignedDriverId ?? "").trim();
    if (!assignedDriverId) continue;
    const orderId = String(order?.id ?? "").trim();
    const orderNumber = String(order?.orderNumber ?? "").trim();
    const nextStatus = String(order?.status ?? status);

    void emitDriverOrderUpdate(assignedDriverId, {
      orderId,
      orderNumber: orderNumber || null,
      status: nextStatus,
      updatedAt: new Date(order.updatedAt).toISOString(),
    }).catch(() => undefined);

  }

  for (const id of committedDispatchNotifications(orders)) void emitPersistedDriverNotification(id).catch(() => undefined);

  return {
    success: true,
    message: `Updated ${orders.length} order(s)`,
    count: orders.length,
    orders,
  };
}

export async function updateDriverStatusForActor(input: UpdateDriverStatusInput) {
  const { actor, body } = input;
  const { orderId: requestOrderId, status, reasonCode, note, region } = body;

  if (!requestOrderId) {
    const err = new Error("Missing orderId") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  if (!status) {
    const err = new Error("Missing status") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const order = await updateDriverOrderStatus({
    orderId: requestOrderId,
    status,
    reasonCode: reasonCode ?? null,
    note: note ?? null,
    region: region ?? null,
    actor,
  });

  if (!order) throw orderError("Order response unavailable",409);
  const assignedDriverId = String(order.assignedDriverId ?? "").trim();
  const eventOrderId = String(order.id).trim();
  const orderNumber = String(order.orderNumber ?? "").trim();
  const nextStatus = String(order.status);
  if (assignedDriverId) {
    void emitDriverOrderUpdate(assignedDriverId, {
      orderId: eventOrderId,
      orderNumber: orderNumber || null,
      status: nextStatus,
      updatedAt: new Date(order.updatedAt).toISOString(),
    }).catch(() => undefined);
  }

  for (const id of committedDispatchNotifications(order)) void emitPersistedDriverNotification(id).catch(() => undefined);

  return {
    success: true,
    message: "Order status updated",
    order,
  };
}
