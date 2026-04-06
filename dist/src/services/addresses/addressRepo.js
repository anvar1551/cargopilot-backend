"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAddresses = listAddresses;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
async function listAddresses(params) {
    const take = Math.min(params.take ?? 20, 50);
    const q = params.q?.trim();
    return prismaClient_1.default.address.findMany({
        where: {
            ...(params.customerEntityId
                ? { customerEntityId: params.customerEntityId }
                : {}),
            ...(q
                ? {
                    OR: [
                        { city: { contains: q, mode: "insensitive" } },
                        { street: { contains: q, mode: "insensitive" } },
                        { addressLine1: { contains: q, mode: "insensitive" } },
                        { neighborhood: { contains: q, mode: "insensitive" } },
                        { postalCode: { contains: q, mode: "insensitive" } },
                        { landmark: { contains: q, mode: "insensitive" } },
                    ],
                }
                : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        take,
    });
}
