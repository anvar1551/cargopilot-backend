"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDriversView = listDriversView;
exports.updateDriverProfileById = updateDriverProfileById;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const driverRepo_1 = require("./driverRepo");
const updateDriverSchema = zod_1.z.object({
    primaryWarehouseId: zod_1.z.string().uuid().nullable().optional(),
    warehouseIds: zod_1.z.array(zod_1.z.string().uuid()).max(100).optional(),
    driverType: zod_1.z.enum(["local", "linehaul"]).optional(),
});
async function listDriversView() {
    return (0, driverRepo_1.listAllDrivers)();
}
async function updateDriverProfileById(driverId, body) {
    const normalizedDriverId = String(driverId ?? "").trim();
    if (!normalizedDriverId) {
        const err = new Error("Driver id is required");
        err.statusCode = 400;
        throw err;
    }
    const input = updateDriverSchema.parse(body ?? {});
    const driver = await prismaClient_1.default.user.findUnique({
        where: { id: normalizedDriverId },
        select: { id: true, role: true },
    });
    if (!driver || driver.role !== "driver") {
        const err = new Error("Driver not found");
        err.statusCode = 404;
        throw err;
    }
    const dedupedWarehouseIds = Array.from(new Set(input.warehouseIds ?? []));
    const candidateIds = Array.from(new Set([...dedupedWarehouseIds, input.primaryWarehouseId ?? null].filter((value) => Boolean(value))));
    if (candidateIds.length > 0) {
        const existingWarehouses = await prismaClient_1.default.warehouse.findMany({
            where: { id: { in: candidateIds } },
            select: { id: true },
        });
        if (existingWarehouses.length !== candidateIds.length) {
            const err = new Error("One or more warehouseIds are invalid");
            err.statusCode = 400;
            throw err;
        }
    }
    const updated = await prismaClient_1.default.$transaction(async (tx) => {
        await tx.user.update({
            where: { id: normalizedDriverId },
            data: {
                ...(input.driverType
                    ? {
                        driverType: input.driverType === "linehaul"
                            ? client_1.DriverType.linehaul
                            : client_1.DriverType.local,
                    }
                    : {}),
                ...(input.primaryWarehouseId !== undefined
                    ? { warehouseId: input.primaryWarehouseId ?? null }
                    : {}),
            },
        });
        if (input.warehouseIds) {
            await tx.driverWarehouseAccess.deleteMany({
                where: { driverId: normalizedDriverId },
            });
            if (dedupedWarehouseIds.length > 0) {
                await tx.driverWarehouseAccess.createMany({
                    data: dedupedWarehouseIds.map((warehouseId) => ({
                        driverId: normalizedDriverId,
                        warehouseId,
                    })),
                });
            }
        }
        return tx.user.findUnique({
            where: { id: normalizedDriverId },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                warehouseId: true,
                driverType: true,
                warehouseAccesses: {
                    select: { warehouseId: true },
                },
            },
        });
    });
    if (!updated) {
        const err = new Error("Driver not found after update");
        err.statusCode = 404;
        throw err;
    }
    const warehouseIds = Array.from(new Set([updated.warehouseId ?? null, ...updated.warehouseAccesses.map((entry) => entry.warehouseId)].filter((value) => Boolean(value))));
    return {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        warehouseId: updated.warehouseId ?? null,
        warehouseIds,
        driverType: updated.driverType === client_1.DriverType.linehaul ? "linehaul" : "local",
    };
}
