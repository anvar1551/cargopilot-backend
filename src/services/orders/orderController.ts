import { Request } from "express";
import { Response } from "express-serve-static-core";
import prisma from "../../config/prismaClient";
import { OrderStatus, AppRole } from "@prisma/client";

import { createInvoice, createStripePayment } from "../invoice/invoiceRepo";
import { createOrder, getOrderById, listOrders } from "./orderRepo.prisma";
import {
  assignOrdersToDriver,
  updateOrderStatusMany,
  updateOrderStatus,
} from "./orderWorkFlow";
import { generateLabelPDF } from "../../features/label/labelService";
import { uploadLabel } from "../../utils/uploadLabel";

export const create = async (req: Request, res: Response) => {
  try {
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";

    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

    const { pickupAddress, dropoffAddress, amount, ...rest } = req.body;

    if (!pickupAddress?.trim() || !dropoffAddress?.trim()) {
      return res
        .status(400)
        .json({ error: "pickupAddress and dropoffAddress are required" });
    }

    const actor = {
      id: req.user.id,
      role: req.user.role as AppRole,
      warehouseId: req.user.warehouseId ?? null,
    };

    // 1) Create enterprise order + parcels
    const order = await createOrder(
      req.user.id,
      { pickupAddress, dropoffAddress, ...rest },
      actor,
    );

    // 2) OPTION B: Generate + upload one label per parcel
    //    - label PDF id = parcel.parcelCode (scan value)
    //    - store labelKey on parcel
    const labelUpdates: Array<{ parcelId: string; labelKey: string }> = [];
    const trackingRows: any[] = [];

    for (const parcel of order.parcels ?? []) {
      // Generate PDF (your generator uses `id` for barcode + QR)
      await generateLabelPDF({
        parcelCode: parcel.parcelCode,
        pieceNo: parcel.pieceNo,
        pieceTotal: parcel.pieceTotal,

        pickupAddress: order.pickupAddress,
        dropoffAddress: order.dropoffAddress,
        destinationCity: order.destinationCity ?? undefined,

        weightKg: parcel.weightKg ?? order.weightKg ?? undefined,
        serviceType: order.serviceType ?? undefined,
        senderName: order.senderName ?? undefined,
        senderPhone: order.senderPhone ?? undefined,
        receiverName: order.receiverName ?? undefined,
        receiverPhone: order.receiverPhone ?? undefined,
      });

      // Upload file (must match how uploadLabel reads files)
      // NOTE: this assumes uploadLabel expects `${filename}.pdf` from /labels folder.
      const { key: labelKey } = await uploadLabel(`${parcel.parcelCode}.pdf`);

      labelUpdates.push({ parcelId: parcel.id, labelKey });

      trackingRows.push({
        orderId: order.id,
        event: "parcel_label_generated",
        status: order.status, // OrderStatus (or null if you prefer)
        note: `Label generated for ${parcel.parcelCode}`,
        region: null,
        warehouseId: actor.warehouseId ?? null,
        actorId: actor.id,
        actorRole: actor.role,
        parcelId: parcel.id,
      });
    }

    // Persist parcel labelKeys + tracking in one transaction
    if (labelUpdates.length) {
      await prisma.$transaction([
        ...labelUpdates.map((u) =>
          prisma.parcel.update({
            where: { id: u.parcelId },
            data: { labelKey: u.labelKey },
          }),
        ),
        prisma.tracking.createMany({ data: trackingRows }),
      ]);
    }

    // 3) If Stripe OFF, finish here
    if (!paymentsEnabled) {
      const fresh = await prisma.order.findUnique({
        where: { id: order.id },
        include: {
          customer: true,
          parcels: true,
          trackingEvents: { orderBy: { timestamp: "asc" } },
          invoice: true,
        },
      });

      return res.status(201).json({
        order: fresh,
        message: "Order created (manual payment) + parcel labels generated",
      });
    }

    // 4) Stripe ON: require amount
    if (typeof amount !== "number" || amount <= 0) {
      return res
        .status(400)
        .json({ error: "amount must be > 0 when PAYMENTS_ENABLED=true" });
    }

    const invoice = await createInvoice(order.id, req.user.id, amount);

    const paymentUrl = await createStripePayment(
      order.id,
      invoice.id,
      amount,
      req.user.email,
    );

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { paymentUrl },
    });

    const fresh = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        customer: true,
        parcels: true,
        trackingEvents: { orderBy: { timestamp: "asc" } },
        invoice: true,
      },
    });

    return res.status(201).json({
      order: fresh,
      invoice,
      paymentUrl,
      message: "Order + parcel labels + invoice created successfully",
    });
  } catch (err: any) {
    console.error("Create order failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to create order" });
  }
};

export async function list(req: any, res: any) {
  try {
    const { id, role } = req.user as { id: string; role: AppRole };
    const { q, page, limit } = req.query;

    const result = await listOrders(id, role, {
      q: q as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function getOne(req: any, res: any) {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Not found" });

    const { id: userId, role } = req.user as { id: string; role: AppRole };
    if (role === "manager" || role === "warehouse") return res.json(order);
    if (role === "customer" && order.customerId === userId)
      return res.json(order);
    if (role === "driver" && order.assignedDriverId === userId)
      return res.json(order);

    return res.status(403).json({ error: "Forbidden" });
  } catch (err: any) {
    console.error("Error in getOne:", err);
    res.status(500).json({ error: err.message || "Failed to fetch order" });
  }
}

function requireUser(req: any) {
  if (!req.user?.id || !req.user?.role) {
    const err = new Error("Unauthorized");
    // @ts-expect-error
    err.statusCode = 401;
    throw err;
  }
  return req.user as {
    id: string;
    role: AppRole;
    warehouseId?: string | null;
  };
}

export async function updateStatus(req: Request, res: Response) {
  try {
    const orderId = req.params.id;
    const { status, region, warehouseId } = req.body;

    const user = req.user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const actor = {
      id: user.id,
      role: user.role,
      warehouseId: user.warehouseId,
    };

    const updatedOrder = await updateOrderStatus({
      orderId,
      status,
      region,
      warehouseId,
      actor,
    });

    return res.json({
      success: true,
      message: "Order status updated successfully",
      order: updatedOrder,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 500;
    return res.status(code).json({ error: err.message });
  }
}

export async function assign(req: any, res: any) {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: "Missing driverId" });

    const orderId = req.params.id;

    const updatedOrders = await assignOrdersToDriver({
      orderIds: [orderId],
      driverId,
    });

    return res.json({
      success: true,
      message: "Driver assigned successfully",
      order: updatedOrders[0],
    });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message });
  }
}

export async function assignBulk(req: any, res: any) {
  try {
    const { driverId, orderIds } = req.body;

    if (!driverId) return res.status(400).json({ error: "Missing driverId" });
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res
        .status(400)
        .json({ error: "orderIds must be a non-empty array" });
    }

    const updatedOrders = await assignOrdersToDriver({
      orderIds,
      driverId,
    });

    return res.json({
      success: true,
      message: `Assigned ${updatedOrders.length} orders to driver`,
      count: updatedOrders.length,
      orders: updatedOrders,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message });
  }
}

const ALLOWED_MANAGER_STATUSES: OrderStatus[] = [
  "pending",
  "assigned",
  "in_transit",
  "arrived_at_warehouse",
  "out_for_delivery",
  "delivered",
];

export const updateStatusManager = async (req: any, res: any) => {
  try {
    const { id: orderId } = req.params;
    const { status, region, warehouseId, note } = req.body;

    assertManagerStatus(status);

    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const actor = {
      id: req.user.id,
      role: req.user.role as AppRole,
      warehouseId: req.user.warehouseId ?? null,
    };

    const updatedOrder = await updateOrderStatus({
      orderId,
      status,
      region: region ?? null,
      warehouseId: warehouseId ?? null,
      note: note ?? null,
      actor,
    });

    return res.json({ success: true, order: updatedOrder });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message });
  }
};

function assertManagerStatus(status: any): asserts status is OrderStatus {
  if (!ALLOWED_MANAGER_STATUSES.includes(status)) {
    const err: any = new Error("Invalid status");
    err.statusCode = 400;
    throw err;
  }
}

export const updateStatusBulk = async (req: any, res: Response) => {
  try {
    const { orderIds, status, region, warehouseId, note } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res
        .status(400)
        .json({ error: "orderIds must be a non-empty array" });
    }

    assertManagerStatus(status);

    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const actor = {
      id: req.user.id,
      role: req.user.role as AppRole,
      warehouseId: req.user.warehouseId ?? null,
    };

    const orders = await updateOrderStatusMany({
      orderIds,
      status,
      region: region ?? null,
      warehouseId: warehouseId ?? null,
      note: note ?? null,
      actor,
    });

    return res.json({
      success: true,
      message: `Updated ${orders.length} orders`,
      count: orders.length,
      orders,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message ?? "Failed" });
  }
};
