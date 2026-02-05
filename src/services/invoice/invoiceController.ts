import { Request, Response } from "express";
import prisma from "../../config/prismaClient";
import { presignGetObject } from "../../utils/s3Presign";

export async function getInvoicePdfUrl(req: Request, res: Response) {
  const invoiceId = req.params.id;
  const user = req.user!; // from auth middleware

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { order: true },
  });

  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  if (!invoice.invoiceKey)
    return res.status(404).json({ error: "Invoice PDF not available yet" });

  // Authorization:
  // - manager can access all
  // - customer can access only their own invoice
  if (user.role !== "manager" && invoice.customerId !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const url = await presignGetObject(invoice.invoiceKey, 60 * 5);
  return res.json({ url });
}
