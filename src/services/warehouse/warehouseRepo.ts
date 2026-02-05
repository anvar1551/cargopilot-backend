import prisma from "../../config/prismaClient";

export const createWarehouse = async (
  name: string,
  location: string,
  region: string
) => {
  const warehouse = await prisma.warehouse.create({
    data: {
      name,
      location,
      region,
    },
  });
  return warehouse;
};

export const listWarehouses = async () => {
  return await prisma.warehouse.findMany({
    orderBy: { createdAt: "desc" },
  });
};

export const getWarehouseById = async (id: string) => {
  return await prisma.warehouse.findMany({
    where: { id },
    include: { users: true, orders: true },
  });
};
