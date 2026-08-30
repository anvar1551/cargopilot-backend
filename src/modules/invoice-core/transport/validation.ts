import { InvoiceStatus } from "@prisma/client";
import { z } from "zod";

export const invoiceOrderParamsSchema = z.object({ orderId: z.string().uuid() });

export const issueInvoiceSchema = z.object({
  dueAt: z.string().datetime().nullable().optional(),
});

export const listInvoicesSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.nativeEnum(InvoiceStatus).optional(),
});
