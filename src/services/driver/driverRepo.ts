import { DriverType } from "@prisma/client";
import prisma from "../../config/prismaClient";

export const listAllDrivers = async () => {
  const rows = await prisma.user.findMany({
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
    const warehouseIds = Array.from(
      new Set(
        [
          driver.warehouseId ?? null,
          ...driver.warehouseAccesses.map((entry) => entry.warehouseId),
        ].filter((value): value is string => Boolean(value)),
      ),
    );

    return {
      id: driver.id,
      name: driver.name,
      email: driver.email,
      role: driver.role,
      warehouseId: driver.warehouseId ?? null,
      warehouseIds,
      driverType: driver.driverType === DriverType.linehaul ? "linehaul" : "local",
    };
  });
};
