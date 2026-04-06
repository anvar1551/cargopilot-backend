"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISPATCHABLE_BY_CYCLE = exports.ASSIGNABLE_BY_CYCLE = exports.FINAL_STATUSES = void 0;
exports.assertTransition = assertTransition;
exports.updateOrderStatusMany = updateOrderStatusMany;
exports.updateOrderStatus = updateOrderStatus;
const prismaClient_1 = __importDefault(require("../../../../config/prismaClient"));
const client_1 = require("@prisma/client");
const orderService_shared_1 = require("../../orderService.shared");
// ---------- 1) Define “who can do what” ----------
const ROLE_ALLOWED_ACTIONS = {
    customer: [],
    driver: [
        client_1.TrackingAction.PICKUP_STARTED,
        client_1.TrackingAction.PICKUP_ATTEMPT,
        client_1.TrackingAction.PICKUP_CONFIRMED,
        client_1.TrackingAction.PICKUP_FAILED,
        client_1.TrackingAction.DELIVERY_STARTED,
        client_1.TrackingAction.DELIVERY_ATTEMPT,
        client_1.TrackingAction.DELIVERED,
        client_1.TrackingAction.DELIVERY_FAILED,
        client_1.TrackingAction.RETURN_REQUESTED,
        client_1.TrackingAction.RETURN_DISPATCHED,
        client_1.TrackingAction.RETURN_DELIVERED,
    ],
    warehouse: [
        client_1.TrackingAction.ARRIVED_AT_WAREHOUSE,
        client_1.TrackingAction.SORTED,
        client_1.TrackingAction.DISPATCHED,
        client_1.TrackingAction.ON_HOLD,
    ],
    manager: [
        // NOTE: keep DRIVER_ASSIGNED here only if you really want to log it via workflow
        // but actual assignment should happen through assignOrdersToDriver().
        client_1.TrackingAction.DRIVER_ASSIGNED,
        client_1.TrackingAction.DRIVER_REJECTED,
        client_1.TrackingAction.PICKUP_STARTED,
        client_1.TrackingAction.PICKUP_ATTEMPT,
        client_1.TrackingAction.PICKUP_CONFIRMED,
        client_1.TrackingAction.PICKUP_FAILED,
        client_1.TrackingAction.ARRIVED_AT_WAREHOUSE,
        client_1.TrackingAction.SORTED,
        client_1.TrackingAction.DISPATCHED,
        client_1.TrackingAction.DELIVERY_STARTED,
        client_1.TrackingAction.DELIVERY_ATTEMPT,
        client_1.TrackingAction.DELIVERED,
        client_1.TrackingAction.DELIVERY_FAILED,
        client_1.TrackingAction.ON_HOLD,
        client_1.TrackingAction.CANCELLED,
        client_1.TrackingAction.RETURN_REQUESTED,
        client_1.TrackingAction.RETURN_DISPATCHED,
        client_1.TrackingAction.RETURN_DELIVERED,
    ],
};
// ---------- 2) Map action -> resulting order status ----------
function statusFromAction(action) {
    switch (action) {
        case client_1.TrackingAction.DRIVER_ASSIGNED:
            return client_1.OrderStatus.assigned;
        case client_1.TrackingAction.PICKUP_STARTED:
            return client_1.OrderStatus.pickup_in_progress;
        case client_1.TrackingAction.PICKUP_CONFIRMED:
            return client_1.OrderStatus.picked_up;
        case client_1.TrackingAction.ARRIVED_AT_WAREHOUSE:
            return client_1.OrderStatus.at_warehouse;
        case client_1.TrackingAction.DISPATCHED:
            return client_1.OrderStatus.in_transit;
        case client_1.TrackingAction.DELIVERY_STARTED:
            return client_1.OrderStatus.out_for_delivery;
        case client_1.TrackingAction.DELIVERED:
            return client_1.OrderStatus.delivered;
        case client_1.TrackingAction.PICKUP_FAILED:
        case client_1.TrackingAction.DELIVERY_FAILED:
        case client_1.TrackingAction.ON_HOLD:
            return client_1.OrderStatus.exception;
        case client_1.TrackingAction.CANCELLED:
            return client_1.OrderStatus.cancelled;
        case client_1.TrackingAction.RETURN_REQUESTED:
        case client_1.TrackingAction.RETURN_DISPATCHED:
            return client_1.OrderStatus.return_in_progress;
        case client_1.TrackingAction.RETURN_DELIVERED:
            return client_1.OrderStatus.returned;
        // Attempt / info actions don't need to change status
        case client_1.TrackingAction.PICKUP_ATTEMPT:
        case client_1.TrackingAction.DELIVERY_ATTEMPT:
        case client_1.TrackingAction.SORTED:
        case client_1.TrackingAction.DRIVER_REJECTED:
        case client_1.TrackingAction.ORDER_CREATED:
        default:
            return null;
    }
}
// ---------- 3) Allowed status transitions ----------
const ALLOWED_TRANSITIONS = {
    [client_1.OrderStatus.pending]: [
        client_1.OrderStatus.assigned,
        client_1.OrderStatus.pickup_in_progress,
        client_1.OrderStatus.cancelled,
        client_1.OrderStatus.exception,
    ],
    [client_1.OrderStatus.assigned]: [
        client_1.OrderStatus.pickup_in_progress,
        client_1.OrderStatus.cancelled,
        client_1.OrderStatus.exception,
    ],
    [client_1.OrderStatus.pickup_in_progress]: [
        client_1.OrderStatus.picked_up,
        client_1.OrderStatus.exception,
        client_1.OrderStatus.cancelled,
    ],
    [client_1.OrderStatus.picked_up]: [
        client_1.OrderStatus.at_warehouse,
        client_1.OrderStatus.in_transit,
        client_1.OrderStatus.exception,
    ],
    [client_1.OrderStatus.at_warehouse]: [client_1.OrderStatus.in_transit, client_1.OrderStatus.out_for_delivery, client_1.OrderStatus.exception],
    [client_1.OrderStatus.in_transit]: [
        client_1.OrderStatus.out_for_delivery,
        client_1.OrderStatus.exception,
    ],
    [client_1.OrderStatus.out_for_delivery]: [
        client_1.OrderStatus.delivered,
        client_1.OrderStatus.exception,
        client_1.OrderStatus.return_in_progress,
    ],
    [client_1.OrderStatus.exception]: [
        client_1.OrderStatus.pickup_in_progress,
        client_1.OrderStatus.in_transit,
        client_1.OrderStatus.out_for_delivery,
        client_1.OrderStatus.return_in_progress,
        client_1.OrderStatus.cancelled,
    ],
    [client_1.OrderStatus.return_in_progress]: [
        client_1.OrderStatus.returned,
        client_1.OrderStatus.exception,
    ],
    [client_1.OrderStatus.returned]: [],
    [client_1.OrderStatus.delivered]: [],
    [client_1.OrderStatus.cancelled]: [],
};
// ---------- Helpers ----------
function assertRoleAllowed(actor, action) {
    const allowed = ROLE_ALLOWED_ACTIONS[actor.role] ?? [];
    if (!allowed.includes(action)) {
        throw (0, orderService_shared_1.orderError)(`Role ${actor.role} cannot perform action ${action}`, 403);
    }
}
function assertTransition(current, next) {
    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
        throw (0, orderService_shared_1.orderError)(`Invalid transition: ${current} -> ${next}`, 400);
    }
}
function requiresReason(action) {
    return (action === client_1.TrackingAction.PICKUP_FAILED ||
        action === client_1.TrackingAction.DELIVERY_FAILED ||
        action === client_1.TrackingAction.ON_HOLD ||
        action === client_1.TrackingAction.CANCELLED ||
        action === client_1.TrackingAction.RETURN_REQUESTED);
}
exports.FINAL_STATUSES = [
    client_1.OrderStatus.delivered,
    client_1.OrderStatus.returned,
    client_1.OrderStatus.cancelled,
];
exports.ASSIGNABLE_BY_CYCLE = {
    pickup: [client_1.OrderStatus.pending, client_1.OrderStatus.assigned, client_1.OrderStatus.exception],
    delivery: [
        client_1.OrderStatus.at_warehouse,
        client_1.OrderStatus.out_for_delivery,
        client_1.OrderStatus.exception,
    ],
    linehaul: [client_1.OrderStatus.at_warehouse, client_1.OrderStatus.in_transit, client_1.OrderStatus.exception],
};
exports.DISPATCHABLE_BY_CYCLE = {
    pickup: [client_1.OrderStatus.assigned],
    delivery: [client_1.OrderStatus.at_warehouse, client_1.OrderStatus.out_for_delivery, client_1.OrderStatus.exception],
    linehaul: [client_1.OrderStatus.at_warehouse, client_1.OrderStatus.in_transit, client_1.OrderStatus.exception],
};
const WAREHOUSE_ACTIONS = [
    client_1.TrackingAction.ARRIVED_AT_WAREHOUSE,
    client_1.TrackingAction.SORTED,
    client_1.TrackingAction.DISPATCHED,
];
const ORDER_BULK_SUMMARY_SELECT = {
    id: true,
    orderNumber: true,
    status: true,
    assignedDriverId: true,
    currentWarehouseId: true,
    updatedAt: true,
};
async function loadOrdersForResponse(orderIds, includeFull) {
    if (includeFull) {
        return prismaClient_1.default.order.findMany({
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
    return prismaClient_1.default.order.findMany({
        where: { id: { in: orderIds } },
        select: ORDER_BULK_SUMMARY_SELECT,
        orderBy: { createdAt: "desc" },
    });
}
/** Applies one workflow action to many orders with shared validation rules. */
async function updateOrderStatusMany(args) {
    const { orderIds, action, reasonCode, note, region, warehouseId, parcelId, actor, includeFull, } = args;
    if (!Array.isArray(orderIds) || orderIds.length === 0)
        throw (0, orderService_shared_1.orderError)("orderIds must be a non-empty array", 400);
    if (!action)
        throw (0, orderService_shared_1.orderError)("Missing action", 400);
    assertRoleAllowed(actor, action);
    if (requiresReason(action) && !reasonCode) {
        throw (0, orderService_shared_1.orderError)(`reasonCode is required for action ${action}`, 400);
    }
    const orders = await prismaClient_1.default.order.findMany({
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
        throw (0, orderService_shared_1.orderError)(`Some orders not found: ${missing.join(", ")}`, 404);
    }
    // ✅ block actions on final orders (except manager can still add info? keep strict for now)
    const final = orders.filter((o) => exports.FINAL_STATUSES.includes(o.status));
    if (final.length) {
        throw (0, orderService_shared_1.orderError)(`Cannot update final orders: ${final.map((x) => `${x.id}(${x.status})`).join(", ")}`, 400);
    }
    // Driver must be assigned
    if (actor.role === client_1.AppRole.driver) {
        const notAssigned = orders.filter((o) => o.assignedDriverId !== actor.id);
        if (notAssigned.length) {
            throw (0, orderService_shared_1.orderError)(`Driver not assigned to orders: ${notAssigned.map((x) => x.id).join(", ")}`, 403);
        }
    }
    // Warehouse constraint (if order already has warehouse)
    if (actor.role === client_1.AppRole.warehouse && actor.warehouseId) {
        const wrong = orders.filter((o) => o.currentWarehouseId && o.currentWarehouseId !== actor.warehouseId);
        if (wrong.length) {
            throw (0, orderService_shared_1.orderError)(`Orders not in your warehouse: ${wrong.map((x) => x.id).join(", ")}`, 403);
        }
    }
    const nextStatus = statusFromAction(action);
    // ✅ IMPORTANT: don’t allow DRIVER_ASSIGNED in workflow because it can’t set assignedDriverId
    // Force using assignOrdersToDriver() endpoint.
    if (action === client_1.TrackingAction.DRIVER_ASSIGNED) {
        throw (0, orderService_shared_1.orderError)("Use assignOrdersToDriver() to assign a driver (action alone is not enough).", 400);
    }
    if (nextStatus) {
        const invalid = [];
        for (const o of orders) {
            try {
                assertTransition(o.status, nextStatus);
            }
            catch {
                invalid.push(`${o.id} (${o.status} -> ${nextStatus})`);
            }
        }
        if (invalid.length)
            throw (0, orderService_shared_1.orderError)(`Bulk update blocked: ${invalid.join("; ")}`, 400);
    }
    const effectiveWarehouseId = warehouseId ?? actor.warehouseId ?? null;
    // ✅ warehouse actions must have a warehouse id
    if (WAREHOUSE_ACTIONS.includes(action) && !effectiveWarehouseId) {
        throw (0, orderService_shared_1.orderError)(`warehouseId is required for action ${action}`, 400);
    }
    const trackingWarehouseId = warehouseId != null
        ? warehouseId
        : WAREHOUSE_ACTIONS.includes(action) || actor.role === client_1.AppRole.warehouse
            ? effectiveWarehouseId
            : null;
    const orderUpdateData = {};
    if (nextStatus)
        orderUpdateData.status = nextStatus;
    if (action === client_1.TrackingAction.ARRIVED_AT_WAREHOUSE) {
        orderUpdateData.currentWarehouseId = effectiveWarehouseId;
    }
    if (action === client_1.TrackingAction.PICKUP_ATTEMPT) {
        orderUpdateData.pickupAttemptCount = { increment: 1 };
    }
    if (action === client_1.TrackingAction.DELIVERY_ATTEMPT) {
        orderUpdateData.deliveryAttemptCount = { increment: 1 };
    }
    const isExceptionAction = action === client_1.TrackingAction.PICKUP_FAILED ||
        action === client_1.TrackingAction.DELIVERY_FAILED ||
        action === client_1.TrackingAction.ON_HOLD ||
        action === client_1.TrackingAction.CANCELLED ||
        action === client_1.TrackingAction.RETURN_REQUESTED;
    if (isExceptionAction) {
        orderUpdateData.lastExceptionReason = reasonCode ?? null;
        orderUpdateData.lastExceptionAt = new Date();
    }
    await prismaClient_1.default.$transaction([
        prismaClient_1.default.order.updateMany({
            where: { id: { in: orderIds } },
            data: Object.keys(orderUpdateData).length ? orderUpdateData : {},
        }),
        prismaClient_1.default.tracking.createMany({
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
    return loadOrdersForResponse(orderIds, includeFull);
}
/** Convenience wrapper for applying one action to a single order. */
async function updateOrderStatus(args) {
    const list = await updateOrderStatusMany({
        orderIds: [args.orderId],
        action: args.action,
        reasonCode: args.reasonCode ?? null,
        note: args.note ?? null,
        region: args.region ?? null,
        warehouseId: args.warehouseId ?? null,
        parcelId: args.parcelId ?? null,
        actor: args.actor,
        includeFull: args.includeFull ?? true,
    });
    return list[0];
}
