import prisma from "../../../config/prismaClient";

export async function resolveCarrierProviderForFinance(args: {
  companyId: string;
  providerId: string;
}) {
  const provider = await prisma.integrationProvider.findFirst({
    where: {
      id: args.providerId,
      companyId: args.companyId,
      domain: "carrier",
    },
    select: { id: true, providerCode: true, environment: true, status: true },
  });
  if (!provider) {
    throw Object.assign(new Error("Carrier provider not found for this company"), {
      statusCode: 404,
    });
  }
  if (provider.status === "disabled") {
    throw Object.assign(new Error("Disabled carrier provider cannot receive new bills"), {
      statusCode: 409,
    });
  }
  return provider;
}
