import prisma from "../../config/prismaClient";

export async function listAddresses(params: {
  customerEntityId?: string;
  q?: string;
  take?: number;
}) {
  const take = Math.min(params.take ?? 20, 50);
  const q = params.q?.trim();

  return prisma.address.findMany({
    where: {
      ...(params.customerEntityId
        ? { customerEntityId: params.customerEntityId }
        : {}),
      ...(q
        ? {
            OR: [
              { city: { contains: q, mode: "insensitive" } },
              { street: { contains: q, mode: "insensitive" } },
              { addressLine1: { contains: q, mode: "insensitive" } },
              { neighborhood: { contains: q, mode: "insensitive" } },
              { postalCode: { contains: q, mode: "insensitive" } },
              { landmark: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take,
  });
}
