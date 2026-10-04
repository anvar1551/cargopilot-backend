import { InvoiceStatus } from "@prisma/client";
import { z } from "zod";

export const invoiceOrderParamsSchema = z.object({ orderId: z.string().uuid() });

const legacyIssueInvoiceSchema = z.object({
  dueAt: z.string().datetime().nullable().optional(),
}).strict();
export const issueInvoiceSchema = z.union([z.object({operationId:z.string().uuid(),priceApprovalId:z.string().uuid(),reason:z.string().trim().min(1).max(1000)}).strict(),legacyIssueInvoiceSchema]);

export const listInvoicesSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.nativeEnum(InvoiceStatus).optional(),
});
