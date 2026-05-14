import { OrderDocumentType } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { ensureOrderExists } from "./shared";

export async function listOrderDocuments(
  orderId: string,
  args?: { type?: OrderDocumentType | null; limit?: number | null },
) {
  await ensureOrderExists(orderId);
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

