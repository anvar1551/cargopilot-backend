"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOrderDocuments = listOrderDocuments;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const shared_1 = require("./shared");
async function listOrderDocuments(orderId, args) {
    await (0, shared_1.ensureOrderExists)(orderId);
    const limit = Math.min(Math.max(args?.limit ?? 100, 1), 500);
    return prismaClient_1.default.orderDocument.findMany({
        where: {
            orderId,
            ...(args?.type ? { type: args.type } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: limit,
    });
}
