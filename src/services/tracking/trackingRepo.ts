import prisma from "../../config/prismaClient";

export const getTrackingById = async (orderId: string) => {
  return await prisma.tracking.findMany({
    where: { orderId },
    include: {
      warehouse: true,
    },
    orderBy: { timestamp: "asc" },
  });
};
