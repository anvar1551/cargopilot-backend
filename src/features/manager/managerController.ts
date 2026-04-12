import { Request, Response } from "express";
import prisma from "../../config/prismaClient";

export async function getManagerOverview(req: Request, res: Response) {
  try {
    // Total orders
    const totalOrders = await prisma.order.count();

    // By status
    const [pending, inTransit, delivered] = await Promise.all([
      prisma.order.count({ where: { status: "pending" } }),
      prisma.order.count({ where: { status: "in_transit" } }),
      prisma.order.count({ where: { status: "delivered" } }),
    ]);

    // Revenue from paid invoices
    const paidInvoices = await prisma.invoice.aggregate({
      _sum: { amount: true },
      where: { status: "paid" },
    });

    res.json({
      totalOrders,
      pending,
      inTransit,
      delivered,
      totalRevenue: paidInvoices._sum.amount || 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function listDrivers(req: Request, res: Response) {
  try {
    const role = req.user?.role;
    const warehouseId = req.user?.warehouseId ?? null;

    const drivers = await prisma.user.findMany({
      where: {
        role: "driver",
        ...(role === "warehouse"
          ? warehouseId
            ? { warehouseId }
            : { id: "__no_matching_driver__" }
          : {}),
      },
      select: { id: true, name: true, email: true, warehouseId: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(drivers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
