import type { Prisma } from "@prisma/client";

export const SAFE_WAREHOUSE_USER_SELECT = {
  id: true,
  name: true,
  driverType: true,
} satisfies Prisma.UserSelect;

export const WAREHOUSE_SELECT = {
  id: true,
  name: true,
  type: true,
  location: true,
  region: true,
  latitude: true,
  longitude: true,
  createdAt: true,
} satisfies Prisma.WarehouseSelect;

export const WAREHOUSE_DETAIL_SELECT = {
  ...WAREHOUSE_SELECT,
  users: { select: SAFE_WAREHOUSE_USER_SELECT },
  orders: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      serviceType: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.WarehouseSelect;

type WarehouseView = Prisma.WarehouseGetPayload<{ select: typeof WAREHOUSE_SELECT }>;
type WarehouseDetail = Prisma.WarehouseGetPayload<{ select: typeof WAREHOUSE_DETAIL_SELECT }>;

// Explicit DTOs also protect the transport if a repository result grows later.
export function warehouseView(row: WarehouseView) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    location: row.location,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    createdAt: row.createdAt,
  };
}

export function warehouseDetailView(row: WarehouseDetail) {
  return {
    ...warehouseView(row),
    users: row.users.map((user) => ({
      id: user.id,
      name: user.name,
      driverType: user.driverType,
    })),
    orders: row.orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      serviceType: order.serviceType,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    })),
  };
}
