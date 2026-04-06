import { OrderStatus, ReasonCode } from "@prisma/client";

import {
  assignDriversBulk as assignDriversBulkWorkflow,
  updateDriverOrderStatus,
  updateOrdersStatusBulk,
} from "../workflow";
import { normalizeBulkOrderIds, requireOrderActor } from "../orderService.shared";

/** Assigns drivers in bulk with assignment type metadata. */
export async function assignTasksBulk(req: any, res: any) {
  try {
    const includeFull = req.query?.include === "full";
    const { driverId, type, warehouseId, note, region } = req.body as {
      driverId?: string;
      type?: "pickup" | "delivery" | "linehaul";
      warehouseId?: string | null;
      note?: string | null;
      region?: string | null;
    };
    const orderIds = normalizeBulkOrderIds(req.body?.orderIds);

    if (!driverId) return res.status(400).json({ error: "Missing driverId" });

    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const actor = requireOrderActor(req.user);

    const orders = await assignDriversBulkWorkflow({
      orderIds,
      driverId,
      type,
      warehouseId: warehouseId ?? null,
      note: note ?? null,
      region: region ?? null,
      actor,
      includeFull,
    });

    return res.json({
      success: true,
      message: `Assigned driver to ${orders.length} order(s)`,
      count: orders.length,
      orders,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message ?? "Failed" });
  }
}

/** Explicit endpoint name for direct driver assignment flow. */
export const assignDriversBulk = assignTasksBulk;

/** Applies bulk order status changes with role-based policy. */
export async function updateStatusBulk(req: any, res: any) {
  try {
    const includeFull = req.query?.include === "full";
    const { status, reasonCode, warehouseId, note, region } = req.body as {
      status?: OrderStatus;
      reasonCode?: ReasonCode;
      warehouseId?: string | null;
      note?: string | null;
      region?: string | null;
    };
    const orderIds = normalizeBulkOrderIds(req.body?.orderIds);

    if (!status) {
      return res.status(400).json({ error: "Missing status" });
    }

    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const actor = requireOrderActor(req.user);

    const orders = await updateOrdersStatusBulk({
      orderIds,
      status,
      reasonCode: reasonCode ?? null,
      warehouseId: warehouseId ?? null,
      note: note ?? null,
      region: region ?? null,
      actor,
      includeFull,
    });

    return res.json({
      success: true,
      message: `Updated ${orders.length} order(s)`,
      count: orders.length,
      orders,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message ?? "Failed" });
  }
}

/** Applies a single status transition initiated by the assigned driver. */
export async function updateDriverStatus(req: any, res: any) {
  try {
    const { orderId, status, reasonCode, note, region } = req.body as {
      orderId?: string;
      status?: OrderStatus;
      reasonCode?: ReasonCode;
      note?: string | null;
      region?: string | null;
    };

    if (!orderId) return res.status(400).json({ error: "Missing orderId" });
    if (!status) return res.status(400).json({ error: "Missing status" });

    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const actor = requireOrderActor(req.user);
    const order = await updateDriverOrderStatus({
      orderId,
      status,
      reasonCode: reasonCode ?? null,
      note: note ?? null,
      region: region ?? null,
      actor,
    });

    return res.json({
      success: true,
      message: "Order status updated",
      order,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message ?? "Failed" });
  }
}
