import prisma from "../../config/prismaClient";

// Assign a driver to an order
export const assignDriverToOrder = async (
  orderId: string,
  driverId: string,
) => {
  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      assignedDriverId: driverId,
      status: "assigned",
    },
    include: {
      customer: true,
      assignedDriver: true,
    },
  });

  // Add tracking entry automatically
  await prisma.tracking.create({
    data: {
      orderId,
      status: "assigned",
      region: "Assignment Center",
    },
  });

  return updatedOrder;
};

export const listAllDrivers = async () => {
  return await prisma.user.findMany({
    where: { role: "driver" },
    select: { id: true, name: true, email: true, role: true },
  });
};
