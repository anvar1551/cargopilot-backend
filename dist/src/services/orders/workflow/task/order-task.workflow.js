"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignDriversBulk = assignDriversBulk;
exports.assignOrderTasksBulk = assignOrderTasksBulk;
exports.updateOrdersStatusBulk = updateOrdersStatusBulk;
exports.updateDriverOrderStatus = updateDriverOrderStatus;
const prismaClient_1 = __importDefault(require("../../../../config/prismaClient"));
const client_1 = require("@prisma/client");
const orderService_shared_1 = require("../../orderService.shared");
const FINAL_ORDER_STATUSES = [
    client_1.OrderStatus.delivered,
    client_1.OrderStatus.returned,
    client_1.OrderStatus.cancelled,
];
const WAREHOUSE_ALLOWED_MANUAL_STATUSES = new Set([
    client_1.OrderStatus.at_warehouse,
    client_1.OrderStatus.in_transit,
    client_1.OrderStatus.out_for_delivery,
    client_1.OrderStatus.exception,
]);
const ASSIGNABLE_ORDER_STATUSES = {
    pickup: [client_1.OrderStatus.pending, client_1.OrderStatus.assigned, client_1.OrderStatus.exception],
    delivery: [
        client_1.OrderStatus.at_warehouse,
        client_1.OrderStatus.out_for_delivery,
        client_1.OrderStatus.exception,
    ],
    linehaul: [
        client_1.OrderStatus.at_warehouse,
        client_1.OrderStatus.in_transit,
        client_1.OrderStatus.exception,
    ],
};
const REASON_REQUIRED_STATUSES = new Set([
    client_1.OrderStatus.exception,
    client_1.OrderStatus.return_in_progress,
    client_1.OrderStatus.cancelled,
]);
const PICKUP_REASON_CODES = new Set([
    client_1.ReasonCode.BAD_SENDER_ADDRESS,
    client_1.ReasonCode.SENDER_NOT_AVAILABLE,
    client_1.ReasonCode.SENDER_MOBILE_OFF,
    client_1.ReasonCode.SENDER_MOBILE_WRONG,
    client_1.ReasonCode.SENDER_MOBILE_NO_RESPONSE,
    client_1.ReasonCode.OUT_OF_PICKUP_AREA,
    client_1.ReasonCode.UNABLE_TO_ACCESS_SENDER_PREMISES,
    client_1.ReasonCode.NO_CAPACITY_PICKUP,
    client_1.ReasonCode.PROHIBITED_ITEMS,
    client_1.ReasonCode.INCORRECT_PACKING,
    client_1.ReasonCode.NO_AWB_PRINTED,
    client_1.ReasonCode.PICKUP_DELAY_LATE_BOOKING,
    client_1.ReasonCode.BAD_WEATHER_PICKUP,
    client_1.ReasonCode.SENDER_NAME_MISSING,
    client_1.ReasonCode.DOCUMENTS_MISSING,
]);
const DRIVER_ALLOWED_TRANSITIONS = {
    [client_1.OrderStatus.assigned]: [client_1.OrderStatus.pickup_in_progress],
    [client_1.OrderStatus.pickup_in_progress]: [
        client_1.OrderStatus.picked_up,
        client_1.OrderStatus.exception,
    ],
    [client_1.OrderStatus.at_warehouse]: [client_1.OrderStatus.out_for_delivery],
    [client_1.OrderStatus.out_for_delivery]: [
        client_1.OrderStatus.delivered,
        client_1.OrderStatus.exception,
        client_1.OrderStatus.return_in_progress,
    ],
    [client_1.OrderStatus.exception]: [
        client_1.OrderStatus.pickup_in_progress,
        client_1.OrderStatus.out_for_delivery,
        client_1.OrderStatus.return_in_progress,
    ],
};
function isPickupReason(reasonCode) {
    return !!reasonCode && PICKUP_REASON_CODES.has(reasonCode);
}
function getDriverAllowedTransitionsForOrder(order) {
    if (order.status !== client_1.OrderStatus.exception) {
        return DRIVER_ALLOWED_TRANSITIONS[order.status] ?? [];
    }
    if (isPickupReason(order.lastExceptionReason)) {
        return [client_1.OrderStatus.pickup_in_progress];
    }
    return [client_1.OrderStatus.out_for_delivery, client_1.OrderStatus.return_in_progress];
}
function normalizeAssignmentType(input) {
    if (input === "pickup" || input === "delivery" || input === "linehaul") {
        return input;
    }
    return "pickup";
}
function assertManagerOrWarehouse(actor) {
    if (actor.role !== client_1.AppRole.manager && actor.role !== client_1.AppRole.warehouse) {
        throw (0, orderService_shared_1.orderError)("Only manager or warehouse can perform this action", 403);
    }
}
function assertWarehouseScope(actor, orders) {
    if (actor.role !== client_1.AppRole.warehouse)
        return;
    if (!actor.warehouseId) {
        throw (0, orderService_shared_1.orderError)("Warehouse user has no warehouse assigned", 403);
    }
    const wrong = orders.filter((o) => o.currentWarehouseId && o.currentWarehouseId !== actor.warehouseId);
    if (wrong.length) {
        throw (0, orderService_shared_1.orderError)(`Orders not in your warehouse: ${wrong.map((x) => x.id).join(", ")}`, 403);
    }
}
function resolveWarehouseId(actor, provided) {
    if (actor.role === client_1.AppRole.warehouse)
        return actor.warehouseId ?? null;
    return provided ?? null;
}
function formatStatus(status) {
    return status.replace(/_/g, " ");
}
async function loadAssignedOrdersForResponse(orderIds, includeFull) {
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
async function assignDriversBulk(args) {
    const { orderIds, driverId, warehouseId, note, region, actor, includeFull } = args;
    const type = normalizeAssignmentType(args.type);
    assertManagerOrWarehouse(actor);
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        throw (0, orderService_shared_1.orderError)("orderIds must be a non-empty array", 400);
    }
    if (!driverId)
        throw (0, orderService_shared_1.orderError)("Missing driverId", 400);
    const driver = await prismaClient_1.default.user.findUnique({
        where: { id: driverId },
        select: { id: true, role: true },
    });
    if (!driver || driver.role !== client_1.AppRole.driver) {
        throw (0, orderService_shared_1.orderError)("Driver not found or invalid role", 400);
    }
    const orders = await prismaClient_1.default.order.findMany({
        where: { id: { in: orderIds } },
        select: {
            id: true,
            status: true,
            currentWarehouseId: true,
        },
    });
    if (orders.length !== orderIds.length) {
        throw (0, orderService_shared_1.orderError)("Some orders were not found", 400);
    }
    const final = orders.filter((o) => FINAL_ORDER_STATUSES.includes(o.status));
    if (final.length) {
        throw (0, orderService_shared_1.orderError)(`Cannot assign driver for final orders: ${final
            .map((o) => `${o.id}(${o.status})`)
            .join(", ")}`, 400);
    }
    assertWarehouseScope(actor, orders);
    const blocked = orders.filter((o) => !ASSIGNABLE_ORDER_STATUSES[type].includes(o.status));
    if (blocked.length) {
        const blockedStages = Array.from(new Set(blocked.map((o) => formatStatus(o.status)))).join(", ");
        const allowedStages = ASSIGNABLE_ORDER_STATUSES[type]
            .map(formatStatus)
            .join(", ");
        throw (0, orderService_shared_1.orderError)(`Assignment is not possible at the current stage for ${type}. Current stages: ${blockedStages}. Allowed stages for ${type}: ${allowedStages}.`, 400);
    }
    const effectiveWarehouseId = resolveWarehouseId(actor, warehouseId);
    await prismaClient_1.default.$transaction(async (tx) => {
        await tx.order.updateMany({
            where: { id: { in: orderIds } },
            data: { assignedDriverId: driverId },
        });
        if (type === "pickup") {
            await tx.order.updateMany({
                where: {
                    id: { in: orderIds },
                    status: { in: [client_1.OrderStatus.pending, client_1.OrderStatus.exception] },
                },
                data: { status: client_1.OrderStatus.assigned },
            });
        }
        await tx.tracking.createMany({
            data: orderIds.map((orderId) => ({
                orderId,
                status: type === "pickup" ? client_1.OrderStatus.assigned : null,
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
async function assignOrderTasksBulk(args) {
    return assignDriversBulk(args);
}
/** Applies bulk status updates for manager/warehouse operations. */
async function updateOrdersStatusBulk(args) {
    const { orderIds, status, reasonCode, warehouseId, note, region, actor, includeFull, } = args;
    assertManagerOrWarehouse(actor);
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        throw (0, orderService_shared_1.orderError)("orderIds must be a non-empty array", 400);
    }
    if (actor.role === client_1.AppRole.warehouse) {
        if (!WAREHOUSE_ALLOWED_MANUAL_STATUSES.has(status)) {
            throw (0, orderService_shared_1.orderError)(`Warehouse role can set only: ${Array.from(WAREHOUSE_ALLOWED_MANUAL_STATUSES).join(", ")}`, 403);
        }
    }
    if (REASON_REQUIRED_STATUSES.has(status) && !reasonCode) {
        throw (0, orderService_shared_1.orderError)(`reasonCode is required when status is ${status}`, 400);
    }
    const orders = await prismaClient_1.default.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, status: true, currentWarehouseId: true },
    });
    if (orders.length !== orderIds.length) {
        throw (0, orderService_shared_1.orderError)("Some orders were not found", 400);
    }
    assertWarehouseScope(actor, orders);
    const effectiveWarehouseId = resolveWarehouseId(actor, warehouseId);
    const requiresWarehouseContext = status === client_1.OrderStatus.at_warehouse ||
        status === client_1.OrderStatus.in_transit ||
        status === client_1.OrderStatus.out_for_delivery;
    if (requiresWarehouseContext && !effectiveWarehouseId) {
        throw (0, orderService_shared_1.orderError)("warehouseId is required for this update", 400);
    }
    const updateData = { status };
    if (status === client_1.OrderStatus.at_warehouse && effectiveWarehouseId) {
        updateData.currentWarehouseId = effectiveWarehouseId;
        // Once the shipment is received into a warehouse, the active driver assignment ends.
        updateData.assignedDriverId = null;
    }
    if (status === client_1.OrderStatus.exception) {
        updateData.lastExceptionReason = reasonCode ?? null;
        updateData.lastExceptionAt = new Date();
    }
    await prismaClient_1.default.$transaction(async (tx) => {
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
async function updateDriverOrderStatus(args) {
    const { orderId, status, reasonCode, note, region, actor } = args;
    if (actor.role !== client_1.AppRole.driver) {
        throw (0, orderService_shared_1.orderError)("Only driver can perform this action", 403);
    }
    if (!orderId) {
        throw (0, orderService_shared_1.orderError)("orderId is required", 400);
    }
    const order = await prismaClient_1.default.order.findUnique({
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
        throw (0, orderService_shared_1.orderError)("Order not found", 404);
    }
    if (order.assignedDriverId !== actor.id) {
        throw (0, orderService_shared_1.orderError)("You are not assigned to this order", 403);
    }
    if (FINAL_ORDER_STATUSES.includes(order.status)) {
        throw (0, orderService_shared_1.orderError)("Order is already in final state", 400);
    }
    const allowedNext = getDriverAllowedTransitionsForOrder(order);
    if (!allowedNext.includes(status)) {
        const currentStage = formatStatus(order.status);
        const targetStage = formatStatus(status);
        const allowedStages = allowedNext.map(formatStatus).join(", ");
        throw (0, orderService_shared_1.orderError)(`Driver cannot move order from ${currentStage} to ${targetStage}. Allowed next stages: ${allowedStages || "none"}.`, 400);
    }
    if (REASON_REQUIRED_STATUSES.has(status) && !reasonCode) {
        throw (0, orderService_shared_1.orderError)(`reasonCode is required when status is ${status}`, 400);
    }
    const updateData = { status };
    if (status === client_1.OrderStatus.at_warehouse) {
        // A driver handing over to warehouse should release ownership until the next assignment.
        updateData.assignedDriverId = null;
    }
    if (status === client_1.OrderStatus.exception) {
        updateData.lastExceptionReason = reasonCode ?? null;
        updateData.lastExceptionAt = new Date();
    }
    await prismaClient_1.default.$transaction(async (tx) => {
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
    return prismaClient_1.default.order.findUnique({
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
