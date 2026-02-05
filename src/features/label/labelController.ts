import { Request, Response } from "express";
import prisma from "../../config/prismaClient";
import { presignGetObject } from "../../utils/s3Presign";

export async function getLabelPdfUrl(req: Request, res: Response) {
  const orderId = req.params.id;
  const user = req.user!;

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  // use labelKey (recommended). If you currently store it in labelUrl, use that field.
  const labelKey = (order as any).labelKey || (order as any).labelUrl;
  if (!labelKey)
    return res.status(404).json({ error: "Label not available yet" });

  // Authorization (adjust as you like)
  if (user.role === "manager") {
    // ok
  } else if (user.role === "customer" && order.customerId !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  } else if (user.role === "driver" && order.assignedDriverId !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  } else if (user.role === "warehouse") {
    // Optional strict check:
    // if (order.currentWarehouseId && user.warehouseId && order.currentWarehouseId !== user.warehouseId) ...
  }

  const url = await presignGetObject(labelKey, 300);
  return res.json({ url });
}
