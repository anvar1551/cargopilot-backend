import { Request, Response } from "express";
import {
  createWarehouse,
  listWarehouses,
  getWarehouseById,
} from "./warehouseRepo";
import prisma from "../../config/prismaClient";

export const create = async (req: Request, res: Response) => {
  try {
    const { name, location, region } = req.body;

    if (!name || !location)
      return res.status(400).json({ error: "Name and location are required" });

    const warehouse = await createWarehouse(name, location, region);
    res.status(201).json(warehouse);
  } catch (error) {
    res.status(500).json({ error: "Failed to create warehouse" });
  }
};

export const list = async (req: Request, res: Response) => {
  try {
    const warehouses = await listWarehouses();
    res.json(warehouses);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch warehouses" });
  }
};

export const getWarehouse = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const warehouse = await getWarehouseById(id);

    if (!warehouse)
      return res.status(404).json({ error: "Warehouse not found" });

    res.json(warehouse);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch warehouse" });
  }
};

export const scanPackage = async (req: Request, res: Response) => {
  try {
    const { orderId, warehouseId, status } = req.body;

    //Verify order exists
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) return res.status(404).json({ error: "Order not found" });

    //Update status
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: status || "sorted",
        currentWarehouseId: warehouseId,
      },
    });

    await prisma.tracking.create({
      data: {
        orderId,
        warehouseId,
        status: updatedOrder.status,
      },
    });

    res.json({
      message: "order scanned successfully",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("❌ Warehouse scan error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
