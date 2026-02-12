import { Request } from "express";
import { Response } from "express-serve-static-core";
import path from "path";

import prisma from "../../config/prismaClient";
import { AppRole, TrackingAction, ReasonCode } from "@prisma/client";

import { createInvoice, createStripePayment } from "../invoice/invoiceRepo";
import { createOrder, getOrderById, listOrders } from "./orderRepo.prisma";
import { mapCreateOrderDtoToRepoPayload } from "./orderCreate.mapper";

import {
  assignOrdersToDriver,
  updateOrderStatusMany,
  updateOrderStatus,
} from "./orderWorkFlow";

import { generateLabelPDF } from "../../features/label/labelService";
import { uploadLabel } from "../../utils/uploadLabel";

// ---------------- Helpers ----------------

function buildAddressText(addr: any): string {
  // Keep deterministic + “competitor-like” single-line format
  const parts = [
    addr?.addressLine1,
    addr?.addressLine2,
    addr?.street,
    addr?.building ? `Bldg ${addr.building}` : null,
    addr?.floor ? `Fl. ${addr.floor}` : null,
    addr?.apartment ? `Apt ${addr.apartment}` : null,
    addr?.neighborhood,
    addr?.city,
    addr?.postalCode,
    addr?.country,
    addr?.landmark ? `Landmark: ${addr.landmark}` : null,
  ].filter(Boolean);

  return parts.join(", ");
}

async function resolveAddressesForOrderInput(input: any) {
  const senderAddressId = input.senderAddressId ?? null;
  const receiverAddressId = input.receiverAddressId ?? null;

  if (!senderAddressId && !receiverAddressId) {
    return {
      pickupAddress: (input.pickupAddress ?? "").trim(),
      dropoffAddress: (input.dropoffAddress ?? "").trim(),
      destinationCity: input.destinationCity ?? null,
    };
  }

  const [senderAddr, receiverAddr] = await Promise.all([
    senderAddressId
      ? prisma.address.findUnique({ where: { id: senderAddressId } })
      : Promise.resolve(null),
    receiverAddressId
      ? prisma.address.findUnique({ where: { id: receiverAddressId } })
      : Promise.resolve(null),
  ]);

  if (senderAddressId && !senderAddr) {
    const e: any = new Error("senderAddressId not found");
    e.statusCode = 400;
    throw e;
  }
  if (receiverAddressId && !receiverAddr) {
    const e: any = new Error("receiverAddressId not found");
    e.statusCode = 400;
    throw e;
  }

  const pickupAddress = senderAddr
    ? buildAddressText(senderAddr)
    : (input.pickupAddress ?? "").trim();

  const dropoffAddress = receiverAddr
    ? buildAddressText(receiverAddr)
    : (input.dropoffAddress ?? "").trim();

  const destinationCity = receiverAddr?.city ?? input.destinationCity ?? null;

  return { pickupAddress, dropoffAddress, destinationCity };
}

// ---------------- CREATE ----------------

export const create = async (req: Request, res: Response) => {
  try {
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";

    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

    const actor = {
      id: req.user.id,
      role: req.user.role as AppRole,
      warehouseId: req.user.warehouseId ?? null,
    };

    console.log("RAW BODY:", req.body);
    console.log("RAW.addresses:", req.body?.addresses);
    console.log("RAW.shipment:", req.body?.shipment);

    // ✅ 1) Validate + map incoming DTO -> repo payload
    const mapped = await mapCreateOrderDtoToRepoPayload(req.body);

    // ✅ Auto-save address-book entries if user typed manual + checked checkbox
    const ownerCustomerEntityId =
      mapped.customerEntityId ?? req.user.customerEntityId ?? null;

    // PICKUP save
    if (mapped.savePickupToAddressBook && !mapped.senderAddressId) {
      if (!ownerCustomerEntityId) {
        return res.status(400).json({
          error: "customerEntityId is required to save pickup address",
        });
      }
      if (!mapped.senderAddressSnapshot) {
        return res.status(400).json({
          error:
            "senderAddress (structured) is required to save pickup address",
        });
      }

      const created = await prisma.address.create({
        data: {
          customerEntityId: ownerCustomerEntityId,
          isSaved: true,
          ...mapped.senderAddressSnapshot,
        },
      });

      mapped.senderAddressId = created.id;
      mapped.pickupAddress = buildAddressText(created);
    }

    // DROPOFF save
    if (mapped.saveDropoffToAddressBook && !mapped.receiverAddressId) {
      if (!ownerCustomerEntityId) {
        return res.status(400).json({
          error: "customerEntityId is required to save dropoff address",
        });
      }
      if (!mapped.receiverAddressSnapshot) {
        return res.status(400).json({
          error:
            "receiverAddress (structured) is required to save dropoff address",
        });
      }

      const created = await prisma.address.create({
        data: {
          customerEntityId: ownerCustomerEntityId,
          isSaved: true,
          ...mapped.receiverAddressSnapshot,
        },
      });

      mapped.receiverAddressId = created.id;
      mapped.dropoffAddress = buildAddressText(created);

      if (!mapped.destinationCity && (created as any).city) {
        mapped.destinationCity = (created as any).city;
      }
    }

    // amount is only used when PAYMENTS_ENABLED=true
    const { amount, ...repoPayload } = mapped;

    // ✅ 2) Create order (repo handles: parcels + ORDER_CREATED tracking)
    const order = await createOrder(req.user.id, repoPayload, actor);

    // ✅ 3) Generate + upload one label per parcel (NO tracking rows)
    const labelUpdates: Array<{ parcelId: string; labelKey: string }> = [];

    for (const parcel of order.parcels ?? []) {
      const labelPath = await generateLabelPDF({
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

      const labelFileName = path.basename(labelPath);
      const { key: labelKey } = await uploadLabel(labelFileName);

      labelUpdates.push({ parcelId: parcel.id, labelKey });
    }

    if (labelUpdates.length) {
      await prisma.$transaction(
        labelUpdates.map((u) =>
          prisma.parcel.update({
            where: { id: u.parcelId },
            data: { labelKey: u.labelKey },
          }),
        ),
      );
    }

    // ✅ 4) Stripe OFF -> return fresh order
    if (!paymentsEnabled) {
      const fresh = await getOrderById(order.id);
      return res.status(201).json({
        order: fresh,
        message: "Order created (manual payment) + parcel labels generated",
      });
    }

    // ✅ 5) Stripe ON -> require amount
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

    const fresh = await getOrderById(order.id);

    return res.status(201).json({
      order: fresh,
      invoice,
      paymentUrl,
      message: "Order + parcel labels + invoice created successfully",
    });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    console.error("Create order failed:", err?.message || err);
    return res
      .status(code)
      .json({ error: err?.message ?? "Failed to create order" });
  }
};
// ---------------- LIST ----------------

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

// ---------------- GET ONE ----------------

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

// ---------------- ASSIGN DRIVER ----------------

export async function assign(req: any, res: any) {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: "Missing driverId" });

    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

    const actor = {
      id: req.user.id,
      role: req.user.role as AppRole,
      warehouseId: req.user.warehouseId ?? null,
    };

    const orderId = req.params.id;

    const updatedOrders = await assignOrdersToDriver({
      orderIds: [orderId],
      driverId,
      actor,
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

    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

    const actor = {
      id: req.user.id,
      role: req.user.role as AppRole,
      warehouseId: req.user.warehouseId ?? null,
    };

    const updatedOrders = await assignOrdersToDriver({
      orderIds,
      driverId,
      actor,
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

// ---------------- UPDATE STATUS ----------------

export async function updateStatus(req: Request, res: Response) {
  try {
    const orderId = req.params.id;

    const {
      action,
      reasonCode,
      note,
      region,
      warehouseId,
      parcelId,
    }: {
      action: TrackingAction;
      reasonCode?: ReasonCode | null;
      note?: string | null;
      region?: string | null;
      warehouseId?: string | null;
      parcelId?: string | null;
    } = req.body;

    if (!action) return res.status(400).json({ error: "Missing action" });

    const user = req.user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const actor = {
      id: user.id,
      role: user.role as AppRole,
      warehouseId: user.warehouseId ?? null,
    };

    const updatedOrder = await updateOrderStatus({
      orderId,
      action,
      reasonCode,
      note,
      region,
      warehouseId,
      parcelId,
      actor,
    });

    return res.json({
      success: true,
      message: "Order updated successfully",
      order: updatedOrder,
    });
  } catch (err: any) {
    const code = err.statusCode ?? 500;
    return res.status(code).json({ error: err.message });
  }
}

// ---------------- MANAGER UPDATE (action-based) ----------------

export const updateStatusManager = async (req: any, res: any) => {
  try {
    const { id: orderId } = req.params;
    const { action, reasonCode, note, region, warehouseId, parcelId } =
      req.body;

    if (!action) return res.status(400).json({ error: "Missing action" });
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
      action,
      reasonCode,
      note,
      region,
      warehouseId,
      parcelId,
      actor,
    });

    return res.json({ success: true, order: updatedOrder });
  } catch (err: any) {
    const code = err.statusCode ?? 400;
    return res.status(code).json({ error: err.message });
  }
};

// ---------------- BULK UPDATE (manager) ----------------

export const updateStatusBulk = async (req: any, res: Response) => {
  try {
    const {
      orderIds,
      action,
      reasonCode,
      note,
      region,
      warehouseId,
      parcelId,
    } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res
        .status(400)
        .json({ error: "orderIds must be a non-empty array" });
    }
    if (!action) return res.status(400).json({ error: "Missing action" });

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
      action,
      reasonCode,
      note,
      region,
      warehouseId,
      parcelId,
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
