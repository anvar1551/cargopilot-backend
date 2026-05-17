"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignDriversBulkForActor = void 0;
exports.assignTasksBulkForActor = assignTasksBulkForActor;
exports.updateStatusBulkForActor = updateStatusBulkForActor;
exports.updateDriverStatusForActor = updateDriverStatusForActor;
const realtimeHub_1 = require("../../../modules/realtime-core/realtimeHub");
const order_status_1 = require("./order-status");
const shared_1 = require("../shared");
function humanizeStatus(status) {
    return String(status ?? "")
        .trim()
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
async function assignTasksBulkForActor(input) {
    const { actor, body, includeFull } = input;
    const { driverId, type, warehouseId, note, region } = body;
    const orderIds = (0, shared_1.normalizeBulkOrderIds)(body.orderIds);
    if (!driverId) {
        const err = new Error("Missing driverId");
        err.statusCode = 400;
        throw err;
    }
    const orders = await (0, order_status_1.assignDriversBulk)({
        orderIds,
        driverId,
        type,
        warehouseId: warehouseId ?? null,
        note: note ?? null,
        region: region ?? null,
        actor,
        includeFull,
    });
    for (const order of orders) {
        const assignedDriverId = String(order?.assignedDriverId ?? driverId).trim();
        if (!assignedDriverId)
            continue;
        const eventOrderId = String(order?.id ?? "").trim();
        const orderNumber = String(order?.orderNumber ?? "").trim();
        const nextStatus = String(order?.status ?? "");
        (0, realtimeHub_1.emitDriverOrderUpdate)(assignedDriverId, {
            orderId: eventOrderId,
            orderNumber: orderNumber || null,
            status: nextStatus,
            updatedAt: new Date().toISOString(),
        });
        void (0, realtimeHub_1.emitDriverNotification)(assignedDriverId, {
            type: "order",
            orderId: eventOrderId,
            title: `Order ${orderNumber || eventOrderId} assigned`,
            body: `Current status: ${humanizeStatus(nextStatus || "assigned")}`,
        }).catch(() => undefined);
    }
    return {
        success: true,
        message: `Assigned driver to ${orders.length} order(s)`,
        count: orders.length,
        orders,
    };
}
exports.assignDriversBulkForActor = assignTasksBulkForActor;
async function updateStatusBulkForActor(input) {
    const { actor, body, includeFull } = input;
    const { status, reasonCode, warehouseId, note, region } = body;
    const orderIds = (0, shared_1.normalizeBulkOrderIds)(body.orderIds);
    if (!status) {
        const err = new Error("Missing status");
        err.statusCode = 400;
        throw err;
    }
    const orders = await (0, order_status_1.updateOrdersStatusBulk)({
        orderIds,
        status,
        reasonCode: reasonCode ?? null,
        warehouseId: warehouseId ?? null,
        note: note ?? null,
        region: region ?? null,
        actor,
        includeFull,
    });
    for (const order of orders) {
        const assignedDriverId = String(order?.assignedDriverId ?? "").trim();
        if (!assignedDriverId)
            continue;
        const orderId = String(order?.id ?? "").trim();
        const orderNumber = String(order?.orderNumber ?? "").trim();
        const nextStatus = String(order?.status ?? status);
        (0, realtimeHub_1.emitDriverOrderUpdate)(assignedDriverId, {
            orderId,
            orderNumber: orderNumber || null,
            status: nextStatus,
            updatedAt: new Date().toISOString(),
        });
        void (0, realtimeHub_1.emitDriverNotification)(assignedDriverId, {
            type: "order",
            orderId,
            title: `Order ${orderNumber || orderId} status updated`,
            body: `New status: ${humanizeStatus(nextStatus)}`,
        }).catch(() => undefined);
    }
    return {
        success: true,
        message: `Updated ${orders.length} order(s)`,
        count: orders.length,
        orders,
    };
}
async function updateDriverStatusForActor(input) {
    const { actor, body } = input;
    const { orderId: requestOrderId, status, reasonCode, note, region } = body;
    if (!requestOrderId) {
        const err = new Error("Missing orderId");
        err.statusCode = 400;
        throw err;
    }
    if (!status) {
        const err = new Error("Missing status");
        err.statusCode = 400;
        throw err;
    }
    const order = await (0, order_status_1.updateDriverOrderStatus)({
        orderId: requestOrderId,
        status,
        reasonCode: reasonCode ?? null,
        note: note ?? null,
        region: region ?? null,
        actor,
    });
    const assignedDriverId = String(order?.assignedDriverId ?? actor.id ?? "").trim();
    const eventOrderId = String(order?.id ?? requestOrderId ?? "").trim();
    const orderNumber = String(order?.orderNumber ?? "").trim();
    const nextStatus = String(order?.status ?? status);
    if (assignedDriverId) {
        (0, realtimeHub_1.emitDriverOrderUpdate)(assignedDriverId, {
            orderId: eventOrderId,
            orderNumber: orderNumber || null,
            status: nextStatus,
            updatedAt: new Date().toISOString(),
        });
    }
    return {
        success: true,
        message: "Order status updated",
        order,
    };
}
