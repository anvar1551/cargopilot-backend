import prisma from "../../../config/prismaClient";

export async function validateCarrierBillOrderLegs(args: {
  companyId: string;
  carrierProviderId: string;
  lines: Array<{ orderId: string; orderLegId: string }>;
}) {
  const legIds = [...new Set(args.lines.map((line) => line.orderLegId))];
  const legs = await prisma.orderLeg.findMany({
    where: {
      id: { in: legIds },
      order: { ownerOrgId: args.companyId },
    },
    select: { id: true, orderId: true, carrierProviderId: true },
  });
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  for (const line of args.lines) {
    const leg = byId.get(line.orderLegId);
    if (!leg || leg.orderId !== line.orderId) {
      throw Object.assign(new Error("Carrier bill contains an invalid company order leg"), {
        statusCode: 409,
      });
    }
    if (leg.carrierProviderId !== args.carrierProviderId) {
      throw Object.assign(new Error("Carrier bill provider does not match the booked order leg"), {
        statusCode: 409,
      });
    }
  }
}
