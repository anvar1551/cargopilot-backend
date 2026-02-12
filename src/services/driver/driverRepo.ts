import prisma from "../../config/prismaClient";
import { TrackingAction } from "@prisma/client";

export const listAllDrivers = async () => {
  return await prisma.user.findMany({
    where: { role: "driver" },
    select: { id: true, name: true, email: true, role: true },
  });
};
