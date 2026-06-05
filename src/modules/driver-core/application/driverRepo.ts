import { DriverType } from "@prisma/client";
import prisma from "../../../config/prismaClient";

export const listAllDrivers = async () => {
  const rows = await prisma.user.findMany({
    where: { driverType: { not: null } },
    select: {
      id: true,
      name: true,
      email: true,
      warehouseId: true,
      driverType: true,
      warehouseAccesses: {
        select: {
          warehouseId: true,
        },
      },
    },
  });

  return rows.map((driver: (typeof rows)[number]) => {
    const warehouseIds = Array.from(
      new Set(
        [
          driver.warehouseId ?? null,
          ...driver.warehouseAccesses.map(
            (entry: (typeof driver.warehouseAccesses)[number]) => entry.warehouseId,
          ),
        ].filter((value): value is string => Boolean(value)),
      ),
    );

    return {
      id: driver.id,
      name: driver.name,
      email: driver.email,
      role: "driver",
      warehouseId: driver.warehouseId ?? null,
      warehouseIds,
      driverType: driver.driverType === DriverType.linehaul ? "linehaul" : "local",
    };
  });
};
