import { Request, Response } from "express";
import prisma from "../../config/prismaClient";
import { AppRole, TrackingAction, ReasonCode } from "@prisma/client";

import {
  createWarehouse,
  listWarehouses,
  getWarehouseById,
} from "./warehouseRepo";
import { updateOrderStatus } from "../orders/orderWorkFlow";

const SCAN_ACTIONS = new Set<TrackingAction>([
  TrackingAction.ARRIVED_AT_WAREHOUSE,
  TrackingAction.SORTED,
  TrackingAction.DISPATCHED,
  TrackingAction.ON_HOLD,
]);

function needsReason(action: TrackingAction) {
  return action === TrackingAction.ON_HOLD;
}

export const create = async (req: Request, res: Response) => {
  try {
    const { name, location, region } = req.body;

    if (!name || !location) {
      return res.status(400).json({ error: "Name and location are required" });
    }

    const warehouse = await createWarehouse(name, location, region);
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

/**
 * ✅ Warehouse scans a parcel
 * Body:
 * - parcelCode: string (required)
 * - action: TrackingAction (ARRIVED_AT_WAREHOUSE / SORTED / DISPATCHED / ON_HOLD)
 * - warehouseId?: string (manager only; warehouse users cannot override)
 * - reasonCode?: ReasonCode (required for ON_HOLD)
 * - note?: string
 * - region?: string
 */
export const scanPackage = async (req: Request, res: Response) => {
  try {
    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ✅ only warehouse or manager can scan
    if (
      req.user.role !== AppRole.warehouse &&
      req.user.role !== AppRole.manager
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { parcelCode, action, warehouseId, reasonCode, note, region } =
      req.body as {
        parcelCode: string;
        action: TrackingAction;
        warehouseId?: string | null;
        reasonCode?: ReasonCode | null;
        note?: string | null;
        region?: string | null;
      };

    if (!parcelCode)
      return res.status(400).json({ error: "parcelCode is required" });
    if (!action) return res.status(400).json({ error: "action is required" });

    if (!SCAN_ACTIONS.has(action)) {
      return res.status(400).json({ error: "Invalid scan action" });
    }

    if (needsReason(action) && !reasonCode) {
      return res
        .status(400)
        .json({ error: `reasonCode is required for action ${action}` });
    }

    const actor = {
      id: req.user.id,
      role: req.user.role as AppRole,
      warehouseId: req.user.warehouseId ?? null,
    };

    // ✅ warehouse users must have an assigned warehouse
    if (actor.role === AppRole.warehouse && !actor.warehouseId) {
      return res
        .status(400)
        .json({ error: "Warehouse user has no warehouse assigned" });
    }

    // ✅ Find parcel -> order
    const parcel = await prisma.parcel.findUnique({
      where: { parcelCode },
      select: { id: true, orderId: true },
    });

    if (!parcel) return res.status(404).json({ error: "Parcel not found" });

    // Load order currentWarehouseId for security/fallback
    const order = await prisma.order.findUnique({
      where: { id: parcel.orderId },
      select: { id: true, currentWarehouseId: true },
    });

    if (!order) return res.status(404).json({ error: "Order not found" });

    // ✅ Determine effectiveWarehouseId safely
    // - warehouse user: always their own warehouseId
    // - manager: can provide warehouseId; else fallback to order.currentWarehouseId; else null
    const effectiveWarehouseId =
      actor.role === AppRole.warehouse
        ? actor.warehouseId
        : (warehouseId ?? order.currentWarehouseId ?? null);

    // ✅ Warehouse user cannot scan orders belonging to another warehouse (if already set)
    if (
      actor.role === AppRole.warehouse &&
      actor.warehouseId &&
      order.currentWarehouseId &&
      order.currentWarehouseId !== actor.warehouseId
    ) {
      return res
        .status(403)
        .json({ error: "Order belongs to a different warehouse" });
    }

    const updatedOrder = await updateOrderStatus({
      orderId: parcel.orderId,
      action,
      reasonCode: reasonCode ?? null,
      note: note ?? null,
      region: region ?? null,
      warehouseId: effectiveWarehouseId,
      parcelId: parcel.id,
      actor,
    });

    return res.json({
      message: "Parcel scanned successfully",
      order: updatedOrder,
    });
  } catch (error: any) {
    console.error("❌ Warehouse scan error:", error?.message || error);
    const code = error?.statusCode ?? 500;
    return res
      .status(code)
      .json({ error: error?.message ?? "Internal server error" });
  }
};
