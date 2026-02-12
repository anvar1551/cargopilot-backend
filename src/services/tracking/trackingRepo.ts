import prisma from "../../config/prismaClient";

const userLiteSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
};

export const getTrackingByOrderId = async (orderId: string) => {
  return prisma.tracking.findMany({
    where: { orderId },
    include: {
      warehouse: true,
      parcel: true,
      actor: { select: userLiteSelect },
    },
    orderBy: { timestamp: "asc" },
  });
};
