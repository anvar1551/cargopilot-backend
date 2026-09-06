import prisma from "../../../config/prismaClient";
import type { WarehouseTypeValue } from "./warehouse.shared";
import { WAREHOUSE_SELECT, WAREHOUSE_DETAIL_SELECT } from "./warehouseProjection";

export const createWarehouse = async (
  name: string,
  type: WarehouseTypeValue,
  location: string,
  region?: string,
  latitude?: number | null,
  longitude?: number | null,
) => {
  return prisma.warehouse.create({
    select: WAREHOUSE_SELECT,
    data: {
      name,
      type,
      location,
      region: region ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
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
    latitude?: number | null;
    longitude?: number | null;
  },
) => {
  return prisma.warehouse.update({
    select: WAREHOUSE_SELECT,
    where: { id },
    data: {
      name: args.name,
      type: args.type,
      location: args.location,
      region: args.region ?? null,
      latitude: args.latitude ?? null,
      longitude: args.longitude ?? null,
    },
  });
};

export const listWarehouses = async () => {
  return prisma.warehouse.findMany({
    select: WAREHOUSE_SELECT,
    orderBy: { createdAt: "desc" },
  });
};

export const getWarehouseById = async (id: string) => {
  return prisma.warehouse.findUnique({
    where: { id },
    select: WAREHOUSE_DETAIL_SELECT,
  });
};
