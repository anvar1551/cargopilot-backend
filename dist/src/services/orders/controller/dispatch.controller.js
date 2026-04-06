"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateStatusBulk = exports.updateStatusManager = void 0;
exports.assign = assign;
exports.assignBulk = assignBulk;
exports.dispatchBulk = dispatchBulk;
exports.updateStatus = updateStatus;
const workflow_1 = require("../workflow");
const orderService_shared_1 = require("../orderService.shared");
/** Assigns a single order to a driver using legacy assignment flow. */
async function assign(req, res) {
    try {
        const { driverId, cycle } = req.body;
        if (!driverId)
            return res.status(400).json({ error: "Missing driverId" });
        if (!req.user?.id)
            return res.status(401).json({ error: "Unauthorized" });
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const orderId = req.params.id;
        const updatedOrders = await (0, workflow_1.assignOrdersToDriver)({
            orderIds: [orderId],
            driverId,
            cycle,
            actor,
            includeFull: true,
        });
        return res.json({
            success: true,
            message: "Driver assigned successfully",
            order: updatedOrders[0],
        });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message });
    }
}
/** Assigns multiple orders to a driver using legacy assignment flow. */
async function assignBulk(req, res) {
    try {
        const includeFull = req.query?.include === "full";
        const { driverId, cycle } = req.body;
        const orderIds = (0, orderService_shared_1.normalizeBulkOrderIds)(req.body?.orderIds);
        if (!driverId)
            return res.status(400).json({ error: "Missing driverId" });
        if (!req.user?.id)
            return res.status(401).json({ error: "Unauthorized" });
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const updatedOrders = await (0, workflow_1.assignOrdersToDriver)({
            orderIds,
            driverId,
            cycle,
            actor,
            includeFull,
        });
        return res.json({
            success: true,
            message: `Assigned ${updatedOrders.length} orders to driver`,
            count: updatedOrders.length,
            orders: updatedOrders,
        });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message });
    }
}
/** Dispatches multiple orders by cycle using legacy dispatch flow. */
async function dispatchBulk(req, res) {
    try {
        const includeFull = req.query?.include === "full";
        const { cycle, warehouseId, note, region } = req.body;
        const orderIds = (0, orderService_shared_1.normalizeBulkOrderIds)(req.body?.orderIds);
        if (!cycle)
            return res.status(400).json({ error: "Missing cycle" });
        if (!req.user?.id)
            return res.status(401).json({ error: "Unauthorized" });
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const updatedOrders = await (0, workflow_1.dispatchOrdersByCycle)({
            orderIds,
            cycle,
            warehouseId: warehouseId ?? null,
            note: note ?? null,
            region: region ?? null,
            actor,
            includeFull,
        });
        return res.json({
            success: true,
            message: `Dispatched ${updatedOrders.length} orders`,
            count: updatedOrders.length,
            orders: updatedOrders,
        });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message });
    }
}
/** Applies one action/status transition to a single order. */
async function updateStatus(req, res) {
    try {
        const orderId = req.params.id;
        const { action, reasonCode, note, region, warehouseId, parcelId, } = req.body;
        if (!action)
            return res.status(400).json({ error: "Missing action" });
        const user = req.user;
        if (!user)
            return res.status(401).json({ error: "Unauthorized" });
        const actor = (0, orderService_shared_1.requireOrderActor)(user);
        const updatedOrder = await (0, workflow_1.updateOrderStatus)({
            orderId,
            action,
            reasonCode,
            note,
            region,
            warehouseId,
            parcelId,
            actor,
            includeFull: true,
        });
        return res.json({
            success: true,
            message: "Order updated successfully",
            order: updatedOrder,
        });
    }
    catch (err) {
        const code = err.statusCode ?? 500;
        return res.status(code).json({ error: err.message });
    }
}
/** Legacy manager-specific single-order action endpoint. */
const updateStatusManager = async (req, res) => {
    try {
        const { id: orderId } = req.params;
        const { action, reasonCode, note, region, warehouseId, parcelId } = req.body;
        if (!action)
            return res.status(400).json({ error: "Missing action" });
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const updatedOrder = await (0, workflow_1.updateOrderStatus)({
            orderId,
            action,
            reasonCode,
            note,
            region,
            warehouseId,
            parcelId,
            actor,
            includeFull: true,
        });
        return res.json({ success: true, order: updatedOrder });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message });
    }
};
exports.updateStatusManager = updateStatusManager;
/** Applies one action/status transition to many orders at once. */
const updateStatusBulk = async (req, res) => {
    try {
        const includeFull = req.query?.include === "full";
        const { action, reasonCode, note, region, warehouseId, parcelId } = req.body;
        const orderIds = (0, orderService_shared_1.normalizeBulkOrderIds)(req.body?.orderIds);
        if (!action)
            return res.status(400).json({ error: "Missing action" });
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const actor = (0, orderService_shared_1.requireOrderActor)(req.user);
        const orders = await (0, workflow_1.updateOrderStatusMany)({
            orderIds,
            action,
            reasonCode,
            note,
            region,
            warehouseId,
            parcelId,
            actor,
            includeFull,
        });
        return res.json({
            success: true,
            message: `Updated ${orders.length} orders`,
            count: orders.length,
            orders,
        });
    }
    catch (err) {
        const code = err.statusCode ?? 400;
        return res.status(code).json({ error: err.message ?? "Failed" });
    }
};
exports.updateStatusBulk = updateStatusBulk;
