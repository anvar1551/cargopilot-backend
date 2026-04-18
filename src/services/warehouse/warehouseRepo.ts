import prisma from "../../config/prismaClient";
import type { WarehouseTypeValue } from "./warehouse.shared";

export const createWarehouse = async (
  name: string,
  type: WarehouseTypeValue,
  location: string,
  region?: string,
) => {
  return prisma.warehouse.create({
    data: {
      name,
      type,
      location,
      region: region ?? null,
    },
  });
};

export const updateWarehouse = async (
  id: string,
  args: {
    name: string;
    type: WarehouseTypeValue;
    location: string;
    region?: string | null;
  },
) => {
  return prisma.warehouse.update({
    where: { id },
    data: {
      name: args.name,
      type: args.type,
      location: args.location,
      region: args.region ?? null,
    },
  });
};

export const listWarehouses = async () => {
  return prisma.warehouse.findMany({
    orderBy: { createdAt: "desc" },
  });
};

export const getWarehouseById = async (id: string) => {
  return prisma.warehouse.findUnique({
    where: { id },
    include: {
      users: true,
      orders: true,
    },
  });
};
