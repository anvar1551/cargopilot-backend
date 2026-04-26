"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAllDrivers = void 0;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const listAllDrivers = async () => {
    const rows = await prismaClient_1.default.user.findMany({
        where: { role: "driver" },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            warehouseId: true,
            driverType: true,
            warehouseAccesses: {
                select: {
                    warehouseId: true,
                },
            },
        },
    });
    return rows.map((driver) => {
        const warehouseIds = Array.from(new Set([
            driver.warehouseId ?? null,
            ...driver.warehouseAccesses.map((entry) => entry.warehouseId),
        ].filter((value) => Boolean(value))));
        return {
            id: driver.id,
            name: driver.name,
            email: driver.email,
            role: driver.role,
            warehouseId: driver.warehouseId ?? null,
            warehouseIds,
            driverType: driver.driverType === client_1.DriverType.linehaul ? "linehaul" : "local",
        };
    });
};
exports.listAllDrivers = listAllDrivers;
