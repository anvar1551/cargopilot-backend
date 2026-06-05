import { DriverType } from "@prisma/client";
import { z } from "zod";
import prisma from "../../../config/prismaClient";
import { listAllDrivers } from "./driverRepo";

const updateDriverSchema = z.object({
  primaryWarehouseId: z.string().uuid().nullable().optional(),
  warehouseIds: z.array(z.string().uuid()).max(100).optional(),
  driverType: z.enum(["local", "linehaul"]).optional(),
});

export async function listDriversView() {
  return listAllDrivers();
}

export async function updateDriverProfileById(driverId: string, body: unknown) {
  const normalizedDriverId = String(driverId ?? "").trim();
  if (!normalizedDriverId) {
    const err = new Error("Driver id is required") as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  const input = updateDriverSchema.parse(body ?? {});
  const driver = await prisma.user.findUnique({
    where: { id: normalizedDriverId },
    select: { id: true, driverType: true },
  });
  if (!driver || !driver.driverType) {
    const err = new Error("Driver not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }

  const dedupedWarehouseIds = Array.from(new Set(input.warehouseIds ?? []));
  const candidateIds = Array.from(
    new Set(
      [...dedupedWarehouseIds, input.primaryWarehouseId ?? null].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  if (candidateIds.length > 0) {
    const existingWarehouses = await prisma.warehouse.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true },
    });
    if (existingWarehouses.length !== candidateIds.length) {
      const err = new Error("One or more warehouseIds are invalid") as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: normalizedDriverId },
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
        warehouseId: true,
        driverType: true,
        warehouseAccesses: {
          select: { warehouseId: true },
        },
      },
    });
  });

  if (!updated) {
    const err = new Error("Driver not found after update") as Error & {
      statusCode?: number;
    };
    err.statusCode = 404;
    throw err;
  }

  const warehouseIds = Array.from(
    new Set(
      [updated.warehouseId ?? null, ...updated.warehouseAccesses.map((entry) => entry.warehouseId)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  return {
    id: updated.id,
    name: updated.name,
    email: updated.email,
    role: "driver",
    warehouseId: updated.warehouseId ?? null,
    warehouseIds,
    driverType: updated.driverType === DriverType.linehaul ? "linehaul" : "local",
  };
}

