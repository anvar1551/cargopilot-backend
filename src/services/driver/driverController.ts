import { Request, Response } from "express";
import { DriverType } from "@prisma/client";
import { z } from "zod";
import prisma from "../../config/prismaClient";
import { listAllDrivers } from "./driverRepo";

export const listDrivers = async (req: Request, res: Response) => {
  try {
    const drivers = await listAllDrivers();
    res.json(drivers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch drivers" });
  }
};

const updateDriverSchema = z.object({
  primaryWarehouseId: z.string().uuid().nullable().optional(),
  warehouseIds: z.array(z.string().uuid()).max(100).optional(),
  driverType: z.enum(["local", "linehaul"]).optional(),
});

export const updateDriverProfile = async (req: Request, res: Response) => {
  try {
    const driverId = String(req.params.id ?? "").trim();
    if (!driverId) {
      return res.status(400).json({ error: "Driver id is required" });
    }

    const input = updateDriverSchema.parse(req.body ?? {});

    const driver = await prisma.user.findUnique({
      where: { id: driverId },
      select: { id: true, role: true },
    });
    if (!driver || driver.role !== "driver") {
      return res.status(404).json({ error: "Driver not found" });
    }

    const dedupedWarehouseIds = Array.from(new Set(input.warehouseIds ?? []));

    const candidateIds = Array.from(
      new Set(
        [
          ...dedupedWarehouseIds,
          input.primaryWarehouseId ?? null,
        ].filter((value): value is string => Boolean(value)),
      ),
    );

    if (candidateIds.length > 0) {
      const existingWarehouses = await prisma.warehouse.findMany({
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

    const updated = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: driverId },
        data: {
          ...(input.driverType
            ? {
                driverType:
                  input.driverType === "linehaul"
                    ? DriverType.linehaul
                    : DriverType.local,
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

    const warehouseIds = Array.from(
      new Set(
        [
          updated.warehouseId ?? null,
          ...updated.warehouseAccesses.map((entry) => entry.warehouseId),
        ].filter((value): value is string => Boolean(value)),
      ),
    );

    return res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      warehouseId: updated.warehouseId ?? null,
      warehouseIds,
      driverType: updated.driverType === DriverType.linehaul ? "linehaul" : "local",
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid payload", issues: error.issues });
    }
    console.error(error);
    return res.status(500).json({ error: "Failed to update driver profile" });
  }
};
