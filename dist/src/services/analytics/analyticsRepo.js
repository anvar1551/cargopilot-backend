"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManagerOverview = getManagerOverview;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
async function getManagerOverview() {
    // 1️⃣ Total orders
    const totalOrders = await prismaClient_1.default.order.count();
    // 2️⃣ Pending orders
    const pendingOrders = await prismaClient_1.default.order.count({
        where: { status: "pending" },
    });
    // 3️⃣ Active drivers (drivers who have assigned orders)
    const activeDrivers = await prismaClient_1.default.user.count({
        where: {
            role: "driver",
            driverOrders: { some: {} },
        },
    });
    // 4️⃣ Total revenue (sum of paid invoices)
    const paidInvoices = await prismaClient_1.default.invoice.aggregate({
        _sum: { amount: true },
        where: { status: "paid" },
    });
    const totalRevenue = paidInvoices._sum.amount || 0;
    // 5️⃣ Pending invoices
    const pendingInvoices = await prismaClient_1.default.invoice.count({
        where: { status: "pending" },
    });
    return {
        totalOrders,
        pendingOrders,
        activeDrivers,
        totalRevenue,
        pendingInvoices,
    };
}
