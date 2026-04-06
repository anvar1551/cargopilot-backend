"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManagerOverview = getManagerOverview;
exports.listDrivers = listDrivers;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
async function getManagerOverview(req, res) {
    try {
        // Total orders
        const totalOrders = await prismaClient_1.default.order.count();
        // By status
        const [pending, inTransit, delivered] = await Promise.all([
            prismaClient_1.default.order.count({ where: { status: "pending" } }),
            prismaClient_1.default.order.count({ where: { status: "in_transit" } }),
            prismaClient_1.default.order.count({ where: { status: "delivered" } }),
        ]);
        // Revenue from paid invoices
        const paidInvoices = await prismaClient_1.default.invoice.aggregate({
            _sum: { amount: true },
            where: { status: "paid" },
        });
        res.json({
            totalOrders,
            pending,
            inTransit,
            delivered,
            totalRevenue: paidInvoices._sum.amount || 0,
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
async function listDrivers(req, res) {
    try {
        const drivers = await prismaClient_1.default.user.findMany({
            where: { role: "driver" },
            select: { id: true, name: true, email: true, warehouseId: true },
            orderBy: { createdAt: "desc" },
        });
        res.json(drivers);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
