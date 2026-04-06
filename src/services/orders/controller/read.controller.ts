import { AppRole } from "@prisma/client";

import {
  getOrderById,
  listDriverWorkloads,
  listOrders,
  listOrdersForExport,
} from "../repo";

function toStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function parseOrderListParams(query: any): Parameters<typeof listOrders>[2] {
  const mode = query.mode === "cursor" ? "cursor" : "page";
  const scope = query.scope === "deep" ? "deep" : "fast";

  return {
    q: query.q as string | undefined,
    page: query.page ? Number(query.page) : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    cursor: typeof query.cursor === "string" ? query.cursor : undefined,
    mode,
    scope,
    statuses: toStringArray(query.statuses),
    createdFrom:
      typeof query.createdFrom === "string" ? query.createdFrom : undefined,
    createdTo: typeof query.createdTo === "string" ? query.createdTo : undefined,
    customerQuery:
      typeof query.customerQuery === "string" ? query.customerQuery : undefined,
    assignedDriverId:
      typeof query.assignedDriverId === "string"
        ? query.assignedDriverId
        : undefined,
    warehouseId:
      typeof query.warehouseId === "string" ? query.warehouseId : undefined,
    region: typeof query.region === "string" ? query.region : undefined,
  };
}

function csvEscape(value: unknown) {
  const raw =
    value == null
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

function buildCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(csvEscape).join(",");
  const bodyRows = rows.map((row) =>
    headers.map((header) => csvEscape(row[header])).join(","),
  );
  return [headerRow, ...bodyRows].join("\n");
}

/** Lists orders with pagination and role-aware visibility rules. */
export async function list(req: any, res: any) {
  try {
    const { id, role } = req.user as { id: string; role: AppRole };
    const result = await listOrders(id, role, parseOrderListParams(req.query));

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

/** Returns one order when requester has access to it. */
export async function getOne(req: any, res: any) {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: "Not found" });

    const { id: userId, role } = req.user as { id: string; role: AppRole };

    if (role === "manager" || role === "warehouse") return res.json(order);
    if (role === "customer" && order.customerId === userId) return res.json(order);
    if (role === "driver" && order.assignedDriverId === userId)
      return res.json(order);

    return res.status(403).json({ error: "Forbidden" });
  } catch (err: any) {
    console.error("Error in getOne:", err);
    res.status(500).json({ error: err.message || "Failed to fetch order" });
  }
}

/** Returns aggregate workload counts grouped by assigned driver. */
export async function listDriverWorkload(req: any, res: any) {
  try {
    const { role } = req.user as { role: AppRole };
    if (role !== "manager" && role !== "warehouse") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const workloads = await listDriverWorkloads();
    return res.json({ workloads });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Failed to fetch workloads" });
  }
}

/** Exports manager-visible orders into a finance-friendly CSV using current filters. */
export async function exportCsv(req: any, res: any) {
  try {
    const { id, role } = req.user as { id: string; role: AppRole };
    if (role !== "manager") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const orders = await listOrdersForExport(id, role, {
      ...parseOrderListParams(req.query),
      mode: "page",
      cursor: undefined,
      page: undefined,
      limit: undefined,
    });

    const csvRows = orders.map((order: any) => ({
      orderId: order.id,
      orderNumber: order.orderNumber ?? "",
      status: order.status ?? "",
      createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : "",
      updatedAt: order.updatedAt ? new Date(order.updatedAt).toISOString() : "",
      plannedPickupAt: order.plannedPickupAt
        ? new Date(order.plannedPickupAt).toISOString()
        : "",
      plannedDeliveryAt: order.plannedDeliveryAt
        ? new Date(order.plannedDeliveryAt).toISOString()
        : "",
      promiseDate: order.promiseDate
        ? new Date(order.promiseDate).toISOString()
        : "",
      customerName: order.customer?.name ?? "",
      customerEmail: order.customer?.email ?? "",
      customerRole: order.customer?.role ?? "",
      customerEntityName: order.customerEntity?.name ?? "",
      customerEntityCompany: order.customerEntity?.companyName ?? "",
      customerEntityEmail: order.customerEntity?.email ?? "",
      customerEntityPhone: order.customerEntity?.phone ?? "",
      senderName: order.senderName ?? "",
      senderPhone: order.senderPhone ?? "",
      receiverName: order.receiverName ?? "",
      receiverPhone: order.receiverPhone ?? "",
      pickupAddress: order.pickupAddress ?? "",
      dropoffAddress: order.dropoffAddress ?? "",
      destinationCity: order.destinationCity ?? "",
      assignedDriverName: order.assignedDriver?.name ?? "",
      assignedDriverEmail: order.assignedDriver?.email ?? "",
      currentWarehouseName: order.currentWarehouse?.name ?? "",
      currentWarehouseLocation: order.currentWarehouse?.location ?? "",
      currentWarehouseRegion: order.currentWarehouse?.region ?? "",
      serviceType: order.serviceType ?? "",
      weightKg: order.weightKg ?? "",
      pieceCount: Array.isArray(order.parcels) ? order.parcels.length : "",
      parcelCodes: Array.isArray(order.parcels)
        ? order.parcels.map((parcel: any) => parcel.parcelCode).filter(Boolean).join(" | ")
        : "",
      parcelWeights: Array.isArray(order.parcels)
        ? order.parcels
            .map((parcel: any) => parcel.weightKg)
            .filter((value: unknown) => value != null)
            .join(" | ")
        : "",
      parcelDimensions: Array.isArray(order.parcels)
        ? order.parcels
            .map((parcel: any) =>
              [parcel.lengthCm, parcel.widthCm, parcel.heightCm]
                .filter((value: unknown) => value != null)
                .join("x"),
            )
            .filter(Boolean)
            .join(" | ")
        : "",
      codAmount: order.codAmount ?? "",
      currency: order.currency ?? "",
      paymentType: order.paymentType ?? "",
      deliveryChargePaidBy: order.deliveryChargePaidBy ?? "",
      codPaidStatus: order.codPaidStatus ?? "",
      serviceCharge: order.serviceCharge ?? "",
      serviceChargePaidStatus: order.serviceChargePaidStatus ?? "",
      itemValue: order.itemValue ?? "",
      invoiceAmount: order.invoice?.amount ?? "",
      invoiceStatus: order.invoice?.status ?? "",
      referenceId: order.referenceId ?? "",
      shelfId: order.shelfId ?? "",
      promoCode: order.promoCode ?? "",
      numberOfCalls: order.numberOfCalls ?? "",
      fragile: order.fragile ? "true" : "false",
      dangerousGoods: order.dangerousGoods ? "true" : "false",
      shipmentInsurance: order.shipmentInsurance ? "true" : "false",
      lastExceptionReason: order.lastExceptionReason ?? "",
    }));

    const csv = buildCsv(csvRows);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=\"orders-export-${stamp}.csv\"`,
    );
    return res.status(200).send(csv);
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Failed to export CSV" });
  }
}
