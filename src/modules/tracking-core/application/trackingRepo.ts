import prisma from "../../../config/prismaClient";

const userLiteSelect = {
  id: true,
  name: true,
  email: true,
  driverType: true,
};

export async function getTrackingByOrderId(orderId: string) {
  return prisma.tracking.findMany({
    where: { orderId },
    include: {
      warehouse: true,
      parcel: true,
      actor: { select: userLiteSelect },
    },
    orderBy: { timestamp: "asc" },
  });
}
