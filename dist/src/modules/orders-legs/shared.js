"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toDate = toDate;
exports.resolveActorTenantScope = resolveActorTenantScope;
exports.ensureOrderExists = ensureOrderExists;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const shared_1 = require("../orders-core/shared");
function toDate(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw (0, shared_1.orderError)(`Invalid date: ${value}`, 400);
    }
    return parsed;
}
function resolveActorTenantScope(actor) {
    if (actor?.tenantScope) {
        return actor.tenantScope;
    }
    if (actor?.warehouseId) {
        return `warehouse:${actor.warehouseId}`;
    }
    if (actor?.id) {
        return `user:${actor.id}`;
    }
    return "system";
}
async function ensureOrderExists(orderId) {
    const exists = await prismaClient_1.default.order.findUnique({
        where: { id: orderId },
        select: { id: true },
    });
    if (!exists) {
        throw (0, shared_1.orderError)("Order not found", 404);
    }
}
