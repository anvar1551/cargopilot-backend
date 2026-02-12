import prisma from "../../config/prismaClient";

export async function listCustomerEntities(params?: {
  q?: string;
  take?: number;
}) {
  const q = params?.q?.trim();
  const take = Math.min(params?.take ?? 20, 50);

  return prisma.customerEntity.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { companyName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take,
    include: {
      defaultAddress: true,
    },
  });
}
