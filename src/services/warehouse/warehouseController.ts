import { Request, Response } from "express";

import {
  createWarehouse,
  listWarehouses,
  getWarehouseById,
} from "./warehouseRepo";
import { normalizeWarehouseType } from "./warehouse.shared";

export const create = async (req: Request, res: Response) => {
  try {
    const { name, type, location, region } = req.body;

    if (!name || !location) {
      return res.status(400).json({ error: "Name and location are required" });
    }

    const warehouse = await createWarehouse(
      name,
      normalizeWarehouseType(type),
      location,
      region,
    );
    return res.status(201).json(warehouse);
  } catch (error) {
    console.error("createWarehouse error:", error);
    return res.status(500).json({ error: "Failed to create warehouse" });
  }
};

export const list = async (_req: Request, res: Response) => {
  try {
    const warehouses = await listWarehouses();
    return res.json(warehouses);
  } catch (error) {
    console.error("listWarehouses error:", error);
    return res.status(500).json({ error: "Failed to fetch warehouses" });
  }
};

export const getWarehouse = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const warehouse = await getWarehouseById(id);
    if (!warehouse)
      return res.status(404).json({ error: "Warehouse not found" });

    return res.json(warehouse);
  } catch (error) {
    console.error("getWarehouse error:", error);
    return res.status(500).json({ error: "Failed to fetch warehouse" });
  }
};
