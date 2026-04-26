"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignDriversBulk = void 0;
exports.assignTasksBulk = assignTasksBulk;
exports.updateStatusBulk = updateStatusBulk;
exports.updateDriverStatus = updateDriverStatus;
const realtimeHub_1 = require("../../../features/realtime/realtimeHub");
const workflow_1 = require("../workflow");
const orderService_shared_1 = require("../orderService.shared");
function humanizeStatus(status) {
    return String(status ?? "")
        .trim()
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
/** Assigns drivers in bulk with assignment type metadata. */
async function assignTasksBulk(req, res) {
    try {
        const includeFull = req.query?.include === "full";
        const { driverId, type, warehouseId, note, region } = req.body;
        const orderIds = (0, orderService_shared_1.normalizeBulkOrderIds)(req.body?.orderIds);
        if (!driverId)
            return res.status(400).json({ error: "Missing driverId" });
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const orders = await (0, workflow_1.assignDriversBulk)({
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
        return res.json({
            success: true,
            message: `Assigned driver to ${orders.length} order(s)`,
            count: orders.length,
            orders,
        });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
/** Explicit endpoint name for direct driver assignment flow. */
exports.assignDriversBulk = assignTasksBulk;
/** Applies bulk order status changes with role-based policy. */
async function updateStatusBulk(req, res) {
    try {
        const includeFull = req.query?.include === "full";
        const { status, reasonCode, warehouseId, note, region } = req.body;
        const orderIds = (0, orderService_shared_1.normalizeBulkOrderIds)(req.body?.orderIds);
        if (!status) {
            return res.status(400).json({ error: "Missing status" });
        }
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const orders = await (0, workflow_1.updateOrdersStatusBulk)({
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
        return res.json({
            success: true,
            message: `Updated ${orders.length} order(s)`,
            count: orders.length,
            orders,
        });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
/** Applies a single status transition initiated by the assigned driver. */
async function updateDriverStatus(req, res) {
    try {
        const { orderId: requestOrderId, status, reasonCode, note, region } = req.body;
        if (!requestOrderId)
            return res.status(400).json({ error: "Missing orderId" });
        if (!status)
            return res.status(400).json({ error: "Missing status" });
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const order = await (0, workflow_1.updateDriverOrderStatus)({
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
        return res.json({
            success: true,
            message: "Order status updated",
            order,
        });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
}
