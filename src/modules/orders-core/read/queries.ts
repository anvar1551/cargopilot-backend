import { authorize, buildOrderScopeWhere } from "../../identity-access";
import {
  countOrdersForExport,
  getOrderById,
  listDriverWorkloads,
  listOrders,
  listOrdersForExport,
} from "../repo";

type ListMode = "page" | "cursor";
type SearchScope = "fast" | "deep";

export type OrdersCoreActor = Express.User;

type ListOrdersQuery = {
  q?: string;
  page?: string | number;
  limit?: string | number;
  cursor?: string;
  mode?: string;
  scope?: string;
  statuses?: string[] | string;
  createdFrom?: string;
  createdTo?: string;
  customerQuery?: string;
  assignedDriverId?: string;
  warehouseId?: string;
  region?: string;
};

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

function parseOrderListParams(query: ListOrdersQuery): Parameters<typeof listOrders>[0] {
  const mode: ListMode = query.mode === "cursor" ? "cursor" : "page";
  const scope: SearchScope = query.scope === "deep" ? "deep" : "fast";

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

async function resolveOrderReadScope(actor: OrdersCoreActor) {
  await authorize(actor, "orders.read");
  return buildOrderScopeWhere(actor);
}

export async function listOrdersForActor(args: {
  actor: OrdersCoreActor;
  query: ListOrdersQuery;
}) {
  const { actor, query } = args;
  const enforcedScopeWhere = await resolveOrderReadScope(actor);
  return listOrders(parseOrderListParams(query), enforcedScopeWhere, actor.id);
}

export async function getOrderForActor(args: { actor: OrdersCoreActor; orderId: string }) {
  const { actor, orderId } = args;
  const enforcedScopeWhere = await resolveOrderReadScope(actor);
  const order = await getOrderById(orderId, enforcedScopeWhere);
  if (!order) return { status: 404 as const };
  return { status: 200 as const, order };
}

export async function listDriverWorkloadForActor(actor: OrdersCoreActor) {
  await authorize(actor, "orders.read");
  return listDriverWorkloads();
}

export async function exportOrdersCsvForActor(args: {
  actor: OrdersCoreActor;
  query: ListOrdersQuery;
}) {
  const { actor, query } = args;

  await authorize(actor, "orders.export");

  const enforcedScopeWhere = await buildOrderScopeWhere(actor);
  const exportParams = {
    ...parseOrderListParams(query),
    mode: "page" as const,
    cursor: undefined,
    page: undefined,
    limit: undefined,
  };

  const maxExportRows = Math.min(
    Math.max(Number(process.env.MAX_EXPORT_ROWS || 20000), 1000),
    200000,
  );

  const totalExportRows = await countOrdersForExport(
    exportParams,
    enforcedScopeWhere,
  );

  if (totalExportRows > maxExportRows) {
    const err = new Error(
      `Export is too large (${totalExportRows} rows). Narrow filters or raise MAX_EXPORT_ROWS.`,
    ) as Error & { statusCode: number };
    err.statusCode = 413;
    throw err;
  }

  const orders = await listOrdersForExport(
    exportParams,
    enforcedScopeWhere,
  );

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
    promiseDate: order.promiseDate ? new Date(order.promiseDate).toISOString() : "",
    customerName: order.customer?.name ?? "",
    customerEmail: order.customer?.email ?? "",
    customerRole: order.customer?.role ?? "",
    customerEntityName: order.customerEntity?.name ?? "",
    customerEntityCompany: order.customerEntity?.companyName ?? "",
    customerEntityEmail: order.customerEntity?.email ?? "",
    customerEntityPhone: order.customerEntity?.phone ?? "",
    senderName: order.senderName ?? "",
    senderPhone: order.senderPhone ?? "",
    senderPhone2: order.senderPhone2 ?? "",
    senderPhone3: order.senderPhone3 ?? "",
    receiverName: order.receiverName ?? "",
    receiverPhone: order.receiverPhone ?? "",
    receiverPhone2: order.receiverPhone2 ?? "",
    receiverPhone3: order.receiverPhone3 ?? "",
    pickupAddress: order.pickupAddress ?? "",
    dropoffAddress: order.dropoffAddress ?? "",
    destinationCity: order.destinationCity ?? "",
    pickupLat: order.pickupLat ?? "",
    pickupLng: order.pickupLng ?? "",
    dropoffLat: order.dropoffLat ?? "",
    dropoffLng: order.dropoffLng ?? "",
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

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    csv: buildCsv(csvRows),
    filename: `orders-export-${stamp}.csv`,
  };
}
