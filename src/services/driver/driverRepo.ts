import prisma from "../../config/prismaClient";

export const listAllDrivers = async () => {
  return await prisma.user.findMany({
    where: { role: "driver" },
    select: { id: true, name: true, email: true, role: true },
  });
};
