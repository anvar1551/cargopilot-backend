import { Request, Response } from "express";

import {
  createWarehouse,
  listWarehouses,
  getWarehouseById,
  updateWarehouse,
} from "./warehouseRepo";
import { normalizeWarehouseType } from "./warehouse.shared";

function parseCoordinate(value: unknown, axis: "lat" | "lng") {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (axis === "lat") {
    return parsed >= -90 && parsed <= 90 ? parsed : null;
  }
  return parsed >= -180 && parsed <= 180 ? parsed : null;
}

export const create = async (req: Request, res: Response) => {
  try {
    const { name, type, location, region, latitude, longitude } = req.body;

    if (!name || !location) {
      return res.status(400).json({ error: "Name and location are required" });
    }

    const warehouse = await createWarehouse(
      name,
      normalizeWarehouseType(type),
      location,
      region,
      parseCoordinate(latitude, "lat"),
      parseCoordinate(longitude, "lng"),
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

export const update = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, type, location, region, latitude, longitude } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Warehouse id is required" });
    }
    if (!name || !location) {
      return res.status(400).json({ error: "Name and location are required" });
    }

    const warehouse = await updateWarehouse(id, {
      name: String(name).trim(),
      type: normalizeWarehouseType(type),
      location: String(location).trim(),
      region:
        typeof region === "string" && region.trim().length > 0
          ? region.trim()
          : null,
      latitude: parseCoordinate(latitude, "lat"),
      longitude: parseCoordinate(longitude, "lng"),
    });

    return res.json(warehouse);
  } catch (error: any) {
    if (error?.code === "P2025") {
      return res.status(404).json({ error: "Warehouse not found" });
    }
    console.error("updateWarehouse error:", error);
    return res.status(500).json({ error: "Failed to update warehouse" });
  }
};
