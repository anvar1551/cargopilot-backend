"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignDriversBulk = void 0;
exports.assignTasksBulk = assignTasksBulk;
exports.updateStatusBulk = updateStatusBulk;
exports.updateDriverStatus = updateDriverStatus;
const workflow_1 = require("../workflow");
const orderService_shared_1 = require("../orderService.shared");
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
        const { orderId, status, reasonCode, note, region } = req.body;
        if (!orderId)
            return res.status(400).json({ error: "Missing orderId" });
        if (!status)
            return res.status(400).json({ error: "Missing status" });
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const order = await (0, workflow_1.updateDriverOrderStatus)({
            orderId,
            status,
            reasonCode: reasonCode ?? null,
            note: note ?? null,
            region: region ?? null,
            actor,
        });
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
