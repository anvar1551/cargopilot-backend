"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateDriverProfile = exports.listDrivers = void 0;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const driverRepo_1 = require("./driverRepo");
const listDrivers = async (req, res) => {
    try {
        const drivers = await (0, driverRepo_1.listAllDrivers)();
        res.json(drivers);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch drivers" });
    }
};
exports.listDrivers = listDrivers;
const updateDriverSchema = zod_1.z.object({
    primaryWarehouseId: zod_1.z.string().uuid().nullable().optional(),
    warehouseIds: zod_1.z.array(zod_1.z.string().uuid()).max(100).optional(),
    driverType: zod_1.z.enum(["local", "linehaul"]).optional(),
});
const updateDriverProfile = async (req, res) => {
    try {
        const driverId = String(req.params.id ?? "").trim();
        if (!driverId) {
            return res.status(400).json({ error: "Driver id is required" });
        }
        const input = updateDriverSchema.parse(req.body ?? {});
        const driver = await prismaClient_1.default.user.findUnique({
            where: { id: driverId },
            select: { id: true, role: true },
        });
        if (!driver || driver.role !== "driver") {
            return res.status(404).json({ error: "Driver not found" });
        }
        const dedupedWarehouseIds = Array.from(new Set(input.warehouseIds ?? []));
        const candidateIds = Array.from(new Set([
            ...dedupedWarehouseIds,
            input.primaryWarehouseId ?? null,
        ].filter((value) => Boolean(value))));
        if (candidateIds.length > 0) {
            const existingWarehouses = await prismaClient_1.default.warehouse.findMany({
                where: {
                    id: {
                        in: candidateIds,
                    },
                },
                select: { id: true },
            });
            if (existingWarehouses.length !== candidateIds.length) {
                return res.status(400).json({ error: "One or more warehouseIds are invalid" });
            }
        }
        const updated = await prismaClient_1.default.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: driverId },
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
                    where: { driverId },
                });
                if (dedupedWarehouseIds.length > 0) {
                    await tx.driverWarehouseAccess.createMany({
                        data: dedupedWarehouseIds.map((warehouseId) => ({
                            driverId,
                            warehouseId,
                        })),
                    });
                }
            }
            return tx.user.findUnique({
                where: { id: driverId },
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
        });
        if (!updated) {
            return res.status(404).json({ error: "Driver not found after update" });
        }
        const warehouseIds = Array.from(new Set([
            updated.warehouseId ?? null,
            ...updated.warehouseAccesses.map((entry) => entry.warehouseId),
        ].filter((value) => Boolean(value))));
        return res.json({
            id: updated.id,
            name: updated.name,
            email: updated.email,
            role: updated.role,
            warehouseId: updated.warehouseId ?? null,
            warehouseIds,
            driverType: updated.driverType === client_1.DriverType.linehaul ? "linehaul" : "local",
        });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: "Invalid payload", issues: error.issues });
        }
        console.error(error);
        return res.status(500).json({ error: "Failed to update driver profile" });
    }
};
exports.updateDriverProfile = updateDriverProfile;
