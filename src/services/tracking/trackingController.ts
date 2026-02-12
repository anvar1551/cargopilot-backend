import { Request, Response } from "express";
import prisma from "../../config/prismaClient";
import { AppRole } from "@prisma/client";
import { getTrackingByOrderId } from "./trackingRepo";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function getTracking(req: Request, res: Response) {
  try {
    const orderId = req.params.id;

    if (!isUuid(orderId)) {
      return res.status(400).json({ error: "Invalid orderId" });
    }

    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 1) Load order minimal for authorization
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        customerId: true,
        assignedDriverId: true,
      },
    });

    if (!order) return res.status(404).json({ error: "Order not found" });

    // 2) Access control
    const userId = req.user.id;
    const role = req.user.role as AppRole;

    const allowed =
      role === AppRole.manager ||
      role === AppRole.warehouse ||
      (role === AppRole.customer && order.customerId === userId) ||
      (role === AppRole.driver && order.assignedDriverId === userId);

    if (!allowed) return res.status(403).json({ error: "Forbidden" });

    // 3) Fetch tracking (reuse repo)
    const tracking = await getTrackingByOrderId(orderId);

    return res.json(tracking);
  } catch (err: any) {
    console.error("getTracking error:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
