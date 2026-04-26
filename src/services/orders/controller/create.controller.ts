import { Request } from "express";
import { Response } from "express-serve-static-core";
import { AddressType } from "@prisma/client";

import prisma from "../../../config/prismaClient";
import { createInvoice, createStripePayment } from "../../invoice/invoiceRepo";
import { createOrder, getOrderById } from "../repo";
import {
  CreateOrderRepoPayload,
  mapCreateOrderDtoToRepoPayload,
} from "../orderCreate.mapper";
import { buildAddressText } from "../orderAddress.shared";
import { requireOrderActor } from "../orderService.shared";
import {
  enqueueOrderLabelJob,
  generateAndAttachParcelLabelsForOrder,
  getOrderImportTemplateCsv,
  importOrdersFromCsv,
  previewOrderImport,
} from "../workflow";

type SaveAddressToBookArgs = {
  enabled: boolean;
  existingAddressId?: string | null;
  ownerCustomerEntityId?: string | null;
  snapshot?: Record<string, unknown> | null;
  missingCustomerEntityError: string;
  missingSnapshotError: string;
};

function sanitizeAddressSnapshot(snapshot?: Record<string, unknown> | null) {
  if (!snapshot || typeof snapshot !== "object") return null;

  return {
    country: (snapshot.country as string | null | undefined) ?? null,
    city: (snapshot.city as string | null | undefined) ?? null,
    neighborhood: (snapshot.neighborhood as string | null | undefined) ?? null,
    street: (snapshot.street as string | null | undefined) ?? null,
    latitude:
      typeof snapshot.latitude === "number" && Number.isFinite(snapshot.latitude)
        ? snapshot.latitude
        : null,
    longitude:
      typeof snapshot.longitude === "number" && Number.isFinite(snapshot.longitude)
        ? snapshot.longitude
        : null,
    addressLine1: (snapshot.addressLine1 as string | null | undefined) ?? null,
    addressLine2: (snapshot.addressLine2 as string | null | undefined) ?? null,
    building: (snapshot.building as string | null | undefined) ?? null,
    apartment: (snapshot.apartment as string | null | undefined) ?? null,
    floor: (snapshot.floor as string | null | undefined) ?? null,
    landmark: (snapshot.landmark as string | null | undefined) ?? null,
    postalCode: (snapshot.postalCode as string | null | undefined) ?? null,
    addressType:
      snapshot.addressType === "RESIDENTIAL" || snapshot.addressType === "BUSINESS"
        ? (snapshot.addressType as AddressType)
        : null,
  };
}

async function saveAddressToBookIfRequested(
  args: SaveAddressToBookArgs,
): Promise<{ id: string; addressText: string; city: string | null } | null> {
  if (!args.enabled || args.existingAddressId) return null;

  if (!args.ownerCustomerEntityId) {
    throw new Error(args.missingCustomerEntityError);
  }
  if (!args.snapshot) {
    throw new Error(args.missingSnapshotError);
  }
  const sanitized = sanitizeAddressSnapshot(args.snapshot);
  if (!sanitized) {
    throw new Error(args.missingSnapshotError);
  }

  const created = await prisma.address.create({
    data: {
      customerEntity: {
        connect: { id: args.ownerCustomerEntityId },
      },
      isSaved: true,
      ...sanitized,
    },
  });

  return {
    id: created.id,
    addressText: buildAddressText(created),
    city: (created as any).city ?? null,
  };
}

/** Creates a new order, optional invoice/payment, and generated parcel labels. */
export const create = async (req: Request, res: Response) => {
  try {
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";
    const rawLabelMode = process.env.ORDER_LABEL_MODE;
    const labelMode =
      rawLabelMode === "async" || rawLabelMode === "queue" ? rawLabelMode : "sync";

    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
    const actor = requireOrderActor(req.user);

    const mapped = await mapCreateOrderDtoToRepoPayload(req.body);

    const ownerCustomerEntityId =
      mapped.customerEntityId ?? req.user.customerEntityId ?? null;

    try {
      const savedPickup = await saveAddressToBookIfRequested({
        enabled: mapped.savePickupToAddressBook === true,
        existingAddressId: mapped.senderAddressId,
        ownerCustomerEntityId,
        snapshot: mapped.senderAddressSnapshot,
        missingCustomerEntityError:
          "customerEntityId is required to save pickup address",
        missingSnapshotError:
          "senderAddress (structured) is required to save pickup address",
      });

      if (savedPickup) {
        mapped.senderAddressId = savedPickup.id;
        mapped.pickupAddress = savedPickup.addressText;
      }

      const savedDropoff = await saveAddressToBookIfRequested({
        enabled: mapped.saveDropoffToAddressBook === true,
        existingAddressId: mapped.receiverAddressId,
        ownerCustomerEntityId,
        snapshot: mapped.receiverAddressSnapshot,
        missingCustomerEntityError:
          "customerEntityId is required to save dropoff address",
        missingSnapshotError:
          "receiverAddress (structured) is required to save dropoff address",
      });

      if (savedDropoff) {
        mapped.receiverAddressId = savedDropoff.id;
        mapped.dropoffAddress = savedDropoff.addressText;
        if (!mapped.destinationCity && savedDropoff.city) {
          mapped.destinationCity = savedDropoff.city;
        }
      }
    } catch (addressErr: any) {
      return res.status(400).json({
        error:
          addressErr?.message ??
          "Failed to process address-book save request",
      });
    }

    const { amount, ...repoPayload } = mapped as CreateOrderRepoPayload;

    const order = await createOrder(req.user.id, repoPayload, actor);

    let labelWarning: string | null = null;

    try {
      if (labelMode === "queue") {
        await enqueueOrderLabelJob(order.id);
      } else if (labelMode === "async") {
        void generateAndAttachParcelLabelsForOrder(order.id).catch((labelErr) => {
          console.error(`Label generation failed for order ${order.id}:`, labelErr);
        });
      } else {
        await generateAndAttachParcelLabelsForOrder(order.id);
      }
    } catch (labelErr: any) {
      labelWarning =
        labelErr?.message ??
        "Order created, but parcel label generation failed";
      console.error(`Label generation failed for order ${order.id}:`, labelErr);
    }

    if (!paymentsEnabled) {
      const fresh = await getOrderById(order.id);
      return res.status(201).json({
        order: fresh,
        warning: labelWarning,
        message:
          labelMode === "async"
            ? "Order created (manual payment) + parcel labels scheduled"
            : labelMode === "queue"
              ? "Order created (manual payment) + parcel labels queued"
            : labelWarning
              ? "Order created (manual payment) + parcel labels pending retry"
              : "Order created (manual payment) + parcel labels generated",
      });
    }

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
      warning: labelWarning,
      message:
        labelMode === "async"
          ? "Order + invoice created successfully (parcel labels scheduled)"
          : labelMode === "queue"
            ? "Order + invoice created successfully (parcel labels queued)"
            : labelWarning
              ? "Order + invoice created successfully (parcel labels pending retry)"
              : "Order + parcel labels + invoice created successfully",
    });
  } catch (err: any) {
    const code = err?.statusCode ?? 500;
    console.error("Create order failed:", err?.message || err);
    return res
      .status(code)
      .json({ error: err?.message ?? "Failed to create order" });
  }
};

/** Downloads the supported CSV template for bulk order import. */
export const downloadImportTemplate = async (_req: Request, res: Response) => {
  const csv = getOrderImportTemplateCsv();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="order-import-template-v1.csv"',
  );
  return res.status(200).send(csv);
};

/** Parses CSV and validates rows against the standard create-order schema. */
export const previewImport = async (req: Request, res: Response) => {
  try {
    if (!req.user?.id || !req.user.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const csvText =
      typeof req.body?.csvText === "string" ? req.body.csvText : "";
    const customerEntityId =
      typeof req.body?.customerEntityId === "string"
        ? req.body.customerEntityId
        : req.user.customerEntityId ?? null;

    if (!csvText.trim()) {
      return res.status(400).json({ error: "csvText is required" });
    }

    if (req.user.role === "manager" && !customerEntityId) {
      return res.status(400).json({
        error: "customerEntityId is required for manager bulk import",
      });
    }

    const preview = await previewOrderImport({
      csvText,
      customerEntityId,
    });

    return res.json(preview);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "Failed to preview import" });
  }
};

/** Confirms a validated CSV import and creates all orders through the same repo flow. */
export const confirmImport = async (req: Request, res: Response) => {
  try {
    if (!req.user?.id || !req.user.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const csvText =
      typeof req.body?.csvText === "string" ? req.body.csvText : "";
    const customerEntityId =
      typeof req.body?.customerEntityId === "string"
        ? req.body.customerEntityId
        : req.user.customerEntityId ?? null;

    if (!csvText.trim()) {
      return res.status(400).json({ error: "csvText is required" });
    }

    if (req.user.role === "manager" && !customerEntityId) {
      return res.status(400).json({
        error: "customerEntityId is required for manager bulk import",
      });
    }

    const result = await importOrdersFromCsv({
      actor: req.user,
      csvText,
      customerEntityId,
    });

    return res.status(201).json({
      success: true,
      count: result.count,
      orders: result.orders,
    });
  } catch (err: any) {
    const code = err?.statusCode ?? 400;
    return res.status(code).json({ error: err?.message ?? "Failed to import orders" });
  }
};
