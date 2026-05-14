"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOrdersForActor = listOrdersForActor;
exports.getOrderForActor = getOrderForActor;
exports.listDriverWorkloadForActor = listDriverWorkloadForActor;
exports.exportOrdersCsvForActor = exportOrdersCsvForActor;
const identity_access_1 = require("../../identity-access");
const repo_1 = require("../repo");
function csvEscape(value) {
    const raw = value == null
        ? ""
        : value instanceof Date
            ? value.toISOString()
            : String(value);
    return `"${raw.replace(/"/g, '""')}"`;
}
function buildCsv(rows) {
    if (rows.length === 0)
        return "";
    const headers = Object.keys(rows[0]);
    const headerRow = headers.map(csvEscape).join(",");
    const bodyRows = rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","));
    return [headerRow, ...bodyRows].join("\n");
}
function toStringArray(value) {
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
function parseOrderListParams(query) {
    const mode = query.mode === "cursor" ? "cursor" : "page";
    const scope = query.scope === "deep" ? "deep" : "fast";
    return {
        q: query.q,
        page: query.page ? Number(query.page) : undefined,
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: typeof query.cursor === "string" ? query.cursor : undefined,
        mode,
        scope,
        statuses: toStringArray(query.statuses),
        createdFrom: typeof query.createdFrom === "string" ? query.createdFrom : undefined,
        createdTo: typeof query.createdTo === "string" ? query.createdTo : undefined,
        customerQuery: typeof query.customerQuery === "string" ? query.customerQuery : undefined,
        assignedDriverId: typeof query.assignedDriverId === "string"
            ? query.assignedDriverId
            : undefined,
        warehouseId: typeof query.warehouseId === "string" ? query.warehouseId : undefined,
        region: typeof query.region === "string" ? query.region : undefined,
    };
}
async function resolveOrderReadScope(actor) {
    await (0, identity_access_1.authorize)(actor, "orders.read");
    return (0, identity_access_1.buildOrderScopeWhere)(actor);
}
async function listOrdersForActor(args) {
    const { actor, query } = args;
    const enforcedScopeWhere = await resolveOrderReadScope(actor);
    return (0, repo_1.listOrders)(parseOrderListParams(query), enforcedScopeWhere, actor.id);
}
async function getOrderForActor(args) {
    const { actor, orderId } = args;
    const enforcedScopeWhere = await resolveOrderReadScope(actor);
    const order = await (0, repo_1.getOrderById)(orderId, enforcedScopeWhere);
    if (!order)
        return { status: 404 };
    return { status: 200, order };
}
async function listDriverWorkloadForActor(actor) {
    await (0, identity_access_1.authorize)(actor, "orders.read");
    return (0, repo_1.listDriverWorkloads)();
}
async function exportOrdersCsvForActor(args) {
    const { actor, query } = args;
    await (0, identity_access_1.authorize)(actor, "orders.export");
    const enforcedScopeWhere = await (0, identity_access_1.buildOrderScopeWhere)(actor);
    const exportParams = {
        ...parseOrderListParams(query),
        mode: "page",
        cursor: undefined,
        page: undefined,
        limit: undefined,
    };
    const maxExportRows = Math.min(Math.max(Number(process.env.MAX_EXPORT_ROWS || 20000), 1000), 200000);
    const totalExportRows = await (0, repo_1.countOrdersForExport)(exportParams, enforcedScopeWhere);
    if (totalExportRows > maxExportRows) {
        const err = new Error(`Export is too large (${totalExportRows} rows). Narrow filters or raise MAX_EXPORT_ROWS.`);
        err.statusCode = 413;
        throw err;
    }
    const orders = await (0, repo_1.listOrdersForExport)(exportParams, enforcedScopeWhere);
    const csvRows = orders.map((order) => ({
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
            ? order.parcels.map((parcel) => parcel.parcelCode).filter(Boolean).join(" | ")
            : "",
        parcelWeights: Array.isArray(order.parcels)
            ? order.parcels
                .map((parcel) => parcel.weightKg)
                .filter((value) => value != null)
                .join(" | ")
            : "",
        parcelDimensions: Array.isArray(order.parcels)
            ? order.parcels
                .map((parcel) => [parcel.lengthCm, parcel.widthCm, parcel.heightCm]
                .filter((value) => value != null)
                .join("x"))
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
