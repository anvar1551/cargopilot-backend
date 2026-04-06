"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTracking = getTracking;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const client_1 = require("@prisma/client");
const trackingRepo_1 = require("./trackingRepo");
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
async function getTracking(req, res) {
    try {
        const orderId = req.params.id;
        if (!isUuid(orderId)) {
            return res.status(400).json({ error: "Invalid orderId" });
        }
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        // 1) Load order minimal for authorization
        const order = await prismaClient_1.default.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                customerId: true,
                assignedDriverId: true,
            },
        });
        if (!order)
            return res.status(404).json({ error: "Order not found" });
        // 2) Access control
        const userId = req.user.id;
        const role = req.user.role;
        const allowed = role === client_1.AppRole.manager ||
            role === client_1.AppRole.warehouse ||
            (role === client_1.AppRole.customer && order.customerId === userId) ||
            (role === client_1.AppRole.driver && order.assignedDriverId === userId);
        if (!allowed)
            return res.status(403).json({ error: "Forbidden" });
        // 3) Fetch tracking (reuse repo)
        const tracking = await (0, trackingRepo_1.getTrackingByOrderId)(orderId);
        return res.json(tracking);
    }
    catch (err) {
        console.error("getTracking error:", err?.message || err);
        return res.status(500).json({ error: err?.message || "Server error" });
    }
}
