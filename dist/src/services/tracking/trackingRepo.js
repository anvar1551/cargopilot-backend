"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTrackingByOrderId = void 0;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const userLiteSelect = {
    id: true,
    name: true,
    email: true,
    role: true,
};
const getTrackingByOrderId = async (orderId) => {
    return prismaClient_1.default.tracking.findMany({
        where: { orderId },
        include: {
            warehouse: true,
            parcel: true,
            actor: { select: userLiteSelect },
        },
        orderBy: { timestamp: "asc" },
    });
};
exports.getTrackingByOrderId = getTrackingByOrderId;
