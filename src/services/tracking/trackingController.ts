import { Request, Response } from "express";
import prisma from "../../config/prismaClient";

export async function getTracking(req: Request, res: Response) {
  try {
    const orderId = req.params.id;

    const tracking = await prisma.tracking.findMany({
      where: { orderId },
      include: {
        warehouse: true,
      },
      orderBy: { timestamp: "asc" },
    });

    res.json(tracking);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
