import { requireAuthorizedOrder } from "../orders-core/domain/order-access";
import { OrderDocumentType } from "@prisma/client";
import prisma from "../../config/prismaClient";

export async function listOrderDocuments(
  orderId: string,
  args?: { type?: OrderDocumentType | null; limit?: number | null },
  actor?: import("./shared").Actor,
) {
  await requireAuthorizedOrder(actor, orderId, "shipment.view");
  const limit = Math.min(Math.max(args?.limit ?? 100, 1), 500);
  return prisma.orderDocument.findMany({
    where: {
      orderId,
      ...(args?.type ? { type: args.type } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });
}

