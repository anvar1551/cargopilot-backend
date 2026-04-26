"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDriverWorkloads = exports.countOrdersForExport = exports.listOrdersForExport = exports.listOrders = exports.getOrderById = void 0;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const client_1 = require("@prisma/client");
const order_repo_shared_1 = require("./order-repo.shared");
const ORDER_STATUS_VALUES = new Set(Object.values(client_1.OrderStatus));
function encodeCursor(value) {
    const raw = `${value.createdAt.toISOString()}|${value.id}`;
    return Buffer.from(raw, "utf8").toString("base64url");
}
function decodeCursor(token) {
    if (!token)
        return null;
    try {
        const decoded = Buffer.from(token, "base64url").toString("utf8");
        const [dateRaw, id] = decoded.split("|");
        if (!dateRaw || !id)
            return null;
        const createdAt = new Date(dateRaw);
        if (Number.isNaN(createdAt.getTime()))
            return null;
        return { createdAt, id };
    }
    catch {
        return null;
    }
}
const orderListSelect = {
    id: true,
    orderNumber: true,
    status: true,
    pickupAddress: true,
    dropoffAddress: true,
    destinationCity: true,
    pickupLat: true,
    pickupLng: true,
    dropoffLat: true,
    dropoffLng: true,
    createdAt: true,
    updatedAt: true,
    currency: true,
    codAmount: true,
    codPaidStatus: true,
    serviceCharge: true,
    serviceChargePaidStatus: true,
    deliveryChargePaidBy: true,
    labelKey: true,
    assignedDriverId: true,
    currentWarehouseId: true,
    customer: { select: order_repo_shared_1.userLiteSelect },
    assignedDriver: { select: order_repo_shared_1.userLiteSelect },
    currentWarehouse: {
        select: { id: true, name: true, location: true, region: true },
    },
    invoice: {
        select: { id: true, status: true, paymentUrl: true, invoiceKey: true },
    },
    parcels: {
        select: {
            id: true,
            parcelCode: true,
            labelKey: true,
            pieceNo: true,
            pieceTotal: true,
        },
    },
    cashCollections: {
        select: {
            id: true,
            kind: true,
            status: true,
            expectedAmount: true,
            collectedAmount: true,
            currency: true,
            currentHolderType: true,
            currentHolderLabel: true,
            collectedAt: true,
            settledAt: true,
        },
    },
};
const orderExportSelect = {
    id: true,
    orderNumber: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    plannedPickupAt: true,
    plannedDeliveryAt: true,
    promiseDate: true,
    senderName: true,
    senderPhone: true,
    senderPhone2: true,
    senderPhone3: true,
    receiverName: true,
    receiverPhone: true,
    receiverPhone2: true,
    receiverPhone3: true,
    pickupAddress: true,
    dropoffAddress: true,
    destinationCity: true,
    pickupLat: true,
    pickupLng: true,
    dropoffLat: true,
    dropoffLng: true,
    serviceType: true,
    weightKg: true,
    codAmount: true,
    currency: true,
    paymentType: true,
    deliveryChargePaidBy: true,
    codPaidStatus: true,
    serviceCharge: true,
    serviceChargePaidStatus: true,
    itemValue: true,
    referenceId: true,
    shelfId: true,
    promoCode: true,
    numberOfCalls: true,
    fragile: true,
    dangerousGoods: true,
    shipmentInsurance: true,
    lastExceptionReason: true,
    customer: { select: order_repo_shared_1.userLiteSelect },
    customerEntity: {
        select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            companyName: true,
            type: true,
        },
    },
    assignedDriver: { select: order_repo_shared_1.userLiteSelect },
    currentWarehouse: {
        select: { id: true, name: true, location: true, region: true },
    },
    invoice: {
        select: {
            id: true,
            amount: true,
            status: true,
            paymentUrl: true,
            invoiceKey: true,
            createdAt: true,
        },
    },
    parcels: {
        select: {
            id: true,
            pieceNo: true,
            pieceTotal: true,
            parcelCode: true,
            weightKg: true,
            lengthCm: true,
            widthCm: true,
            heightCm: true,
        },
        orderBy: { pieceNo: "asc" },
    },
};
function isEmptyWhere(where) {
    return !where || Object.keys(where).length === 0;
}
function normalizeStatuses(values) {
    if (!Array.isArray(values))
        return [];
    return Array.from(new Set(values
        .map((value) => String(value || "").trim())
        .filter((value) => ORDER_STATUS_VALUES.has(value))));
}
function parseDateFloor(value) {
    if (!value)
        return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return null;
    return date;
}
function parseDateCeilingExclusive(value) {
    const date = parseDateFloor(value);
    if (!date)
        return null;
    date.setDate(date.getDate() + 1);
    return date;
}
function buildDateWhere(field, from, to) {
    const gte = parseDateFloor(from);
    const lt = parseDateCeilingExclusive(to);
    if (!gte && !lt)
        return {};
    const range = {};
    if (gte)
        range.gte = gte;
    if (lt)
        range.lt = lt;
    return { [field]: range };
}
function buildRoleScopeWhere(userId, role, customerEntityId, warehouseId) {
    if (role === "customer") {
        if (customerEntityId) {
            return { customerEntityId };
        }
        return { customerId: userId };
    }
    if (role === "driver")
        return { assignedDriverId: userId };
    if (role === "warehouse") {
        if (!warehouseId) {
            // no attached location -> no visibility
            return { id: "__no_access__" };
        }
        return {
            OR: [
                { currentWarehouseId: warehouseId },
                {
                    assignedDriver: {
                        OR: [
                            { warehouseId },
                            { warehouseAccesses: { some: { warehouseId } } },
                        ],
                    },
                },
            ],
        };
    }
    return {};
}
function buildSearchWhere(qRaw, scope) {
    const q = qRaw.trim();
    if (!q)
        return {};
    if ((0, order_repo_shared_1.isUuid)(q))
        return { id: q };
    if ((0, order_repo_shared_1.looksLikeOrderNumber)(q)) {
        return {
            OR: [{ orderNumber: q }, { orderNumber: { startsWith: q } }],
        };
    }
    if ((0, order_repo_shared_1.looksLikeParcelCode)(q)) {
        return {
            parcels: {
                some: {
                    OR: [{ parcelCode: q }, { parcelCode: { startsWith: q } }],
                },
            },
        };
    }
    const fastOr = [
        { orderNumber: { startsWith: q } },
        { referenceId: { startsWith: q, mode: "insensitive" } },
        { destinationCity: { startsWith: q, mode: "insensitive" } },
        { pickupAddress: { contains: q, mode: "insensitive" } },
        { dropoffAddress: { contains: q, mode: "insensitive" } },
    ];
    if (scope !== "deep") {
        return { OR: fastOr };
    }
    return {
        OR: [
            ...fastOr,
            {
                customer: {
                    OR: [
                        { name: { contains: q, mode: "insensitive" } },
                        { email: { contains: q, mode: "insensitive" } },
                    ],
                },
            },
            {
                customerEntity: {
                    OR: [
                        { name: { contains: q, mode: "insensitive" } },
                        { email: { contains: q, mode: "insensitive" } },
                        { phone: { contains: q, mode: "insensitive" } },
                        { companyName: { contains: q, mode: "insensitive" } },
                    ],
                },
            },
            {
                senderAddressObj: {
                    OR: [
                        { city: { contains: q, mode: "insensitive" } },
                        { street: { contains: q, mode: "insensitive" } },
                        { addressLine1: { contains: q, mode: "insensitive" } },
                        { neighborhood: { contains: q, mode: "insensitive" } },
                        { postalCode: { contains: q, mode: "insensitive" } },
                    ],
                },
            },
            {
                receiverAddressObj: {
                    OR: [
                        { city: { contains: q, mode: "insensitive" } },
                        { street: { contains: q, mode: "insensitive" } },
                        { addressLine1: { contains: q, mode: "insensitive" } },
                        { neighborhood: { contains: q, mode: "insensitive" } },
                        { postalCode: { contains: q, mode: "insensitive" } },
                    ],
                },
            },
            { currentWarehouse: { name: { contains: q, mode: "insensitive" } } },
        ],
    };
}
function buildStructuredFiltersWhere(params) {
    if (!params)
        return {};
    const and = [];
    const statuses = normalizeStatuses(params.statuses);
    const customerQuery = params.customerQuery?.trim();
    const assignedDriverId = params.assignedDriverId?.trim();
    const warehouseId = params.warehouseId?.trim();
    const region = params.region?.trim();
    if (statuses.length > 0) {
        and.push({ status: { in: statuses } });
    }
    if (customerQuery) {
        and.push({
            OR: [
                {
                    customer: {
                        OR: [
                            { name: { contains: customerQuery, mode: "insensitive" } },
                            { email: { contains: customerQuery, mode: "insensitive" } },
                        ],
                    },
                },
                {
                    customerEntity: {
                        OR: [
                            { name: { contains: customerQuery, mode: "insensitive" } },
                            { companyName: { contains: customerQuery, mode: "insensitive" } },
                            { email: { contains: customerQuery, mode: "insensitive" } },
                            { phone: { contains: customerQuery, mode: "insensitive" } },
                        ],
                    },
                },
            ],
        });
    }
    if (assignedDriverId) {
        and.push({ assignedDriverId });
    }
    if (warehouseId) {
        and.push({ currentWarehouseId: warehouseId });
    }
    if (region) {
        and.push({
            currentWarehouse: {
                region: {
                    contains: region,
                    mode: "insensitive",
                },
            },
        });
    }
    const createdAtWhere = buildDateWhere("createdAt", params.createdFrom, params.createdTo);
    if (!isEmptyWhere(createdAtWhere)) {
        and.push(createdAtWhere);
    }
    if (and.length === 0)
        return {};
    return { AND: and };
}
function buildOrderWhere(userId, role, customerEntityId, warehouseId, params) {
    const scope = params?.scope === "deep" ? "deep" : "fast";
    const q = params?.q?.trim() ?? "";
    const effectiveParams = role === "warehouse" && params
        ? { ...params, warehouseId: undefined }
        : params;
    const roleWhere = buildRoleScopeWhere(userId, role, customerEntityId, warehouseId);
    const searchWhere = q ? buildSearchWhere(q, scope) : {};
    const filterWhere = buildStructuredFiltersWhere(effectiveParams);
    const and = [roleWhere, searchWhere, filterWhere].filter((item) => !isEmptyWhere(item));
    if (and.length === 0)
        return {};
    if (and.length === 1)
        return and[0];
    return { AND: and };
}
/** Returns a single order with full details used by manager/customer/driver views. */
const getOrderById = async (id) => {
    return prismaClient_1.default.order.findUnique({
        where: { id },
        include: {
            customer: { select: order_repo_shared_1.userLiteSelect },
            assignedDriver: { select: order_repo_shared_1.userLiteSelect },
            currentWarehouse: true,
            invoice: true,
            customerEntity: {
                include: {
                    defaultAddress: true,
                },
            },
            senderAddressObj: true,
            receiverAddressObj: true,
            attachments: true,
            parcels: true,
            cashCollections: {
                include: {
                    currentHolderUser: { select: order_repo_shared_1.userLiteSelect },
                    currentHolderWarehouse: true,
                    events: {
                        include: {
                            actor: { select: order_repo_shared_1.userLiteSelect },
                        },
                        orderBy: { createdAt: "asc" },
                    },
                },
            },
            trackingEvents: {
                include: {
                    warehouse: true,
                    actor: { select: order_repo_shared_1.userLiteSelect },
                    parcel: true,
                },
                orderBy: { timestamp: "asc" },
            },
        },
    });
};
exports.getOrderById = getOrderById;
/** Lists orders with search + pagination and role-based scope restrictions. */
const listOrders = async (userId, role, customerEntityId, warehouseId, params) => {
    const page = Math.max(1, params?.page ?? 1);
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);
    const mode = params?.mode === "cursor" ? "cursor" : "page";
    const cursor = decodeCursor(params?.cursor);
    const skip = (page - 1) * limit;
    const where = buildOrderWhere(userId, role, customerEntityId, warehouseId, params);
    if (mode === "cursor") {
        const whereWithCursor = cursor
            ? {
                AND: [
                    where,
                    {
                        OR: [
                            { createdAt: { lt: cursor.createdAt } },
                            {
                                AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }],
                            },
                        ],
                    },
                ],
            }
            : where;
        const rows = await prismaClient_1.default.order.findMany({
            where: whereWithCursor,
            select: orderListSelect,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
        });
        const hasMore = rows.length > limit;
        const orders = hasMore ? rows.slice(0, limit) : rows;
        const tail = orders[orders.length - 1];
        return {
            orders,
            total: orders.length,
            page: 1,
            limit,
            pageCount: 1,
            hasMore,
            nextCursor: hasMore && tail
                ? encodeCursor({ id: tail.id, createdAt: tail.createdAt })
                : null,
            mode: "cursor",
            totalExact: false,
        };
    }
    const [orders, total] = await prismaClient_1.default.$transaction([
        prismaClient_1.default.order.findMany({
            where,
            select: orderListSelect,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: limit,
        }),
        prismaClient_1.default.order.count({ where }),
    ]);
    const pageCount = Math.ceil(total / limit);
    return {
        orders,
        total,
        page,
        limit,
        pageCount,
        hasMore: skip + orders.length < total,
        nextCursor: null,
        mode: "page",
        totalExact: true,
    };
};
exports.listOrders = listOrders;
/** Returns detailed rows for CSV export using the same filters as the manager list. */
const listOrdersForExport = async (userId, role, customerEntityId, warehouseId, params) => {
    const where = buildOrderWhere(userId, role, customerEntityId, warehouseId, params);
    return prismaClient_1.default.order.findMany({
        where,
        select: orderExportSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
};
exports.listOrdersForExport = listOrdersForExport;
/** Returns exact count for current export filters to guard large synchronous CSV exports. */
const countOrdersForExport = async (userId, role, customerEntityId, warehouseId, params) => {
    const where = buildOrderWhere(userId, role, customerEntityId, warehouseId, params);
    return prismaClient_1.default.order.count({ where });
};
exports.countOrdersForExport = countOrdersForExport;
const FINAL_STATUSES = new Set([
    client_1.OrderStatus.delivered,
    client_1.OrderStatus.returned,
    client_1.OrderStatus.cancelled,
]);
/** Aggregates assigned order counts by driver with status breakdown. */
const listDriverWorkloads = async () => {
    const rows = await prismaClient_1.default.order.groupBy({
        by: ["assignedDriverId", "status"],
        where: { assignedDriverId: { not: null } },
        _count: { _all: true },
    });
    const byDriver = new Map();
    for (const row of rows) {
        const driverId = row.assignedDriverId;
        if (!driverId)
            continue;
        const status = row.status;
        const count = row._count._all;
        const current = byDriver.get(driverId) ?? {
            driverId,
            totalAssigned: 0,
            activeAssigned: 0,
            byStatus: {},
        };
        current.totalAssigned += count;
        current.byStatus[status] = (current.byStatus[status] ?? 0) + count;
        if (!FINAL_STATUSES.has(status)) {
            current.activeAssigned += count;
        }
        byDriver.set(driverId, current);
    }
    return Array.from(byDriver.values()).sort((a, b) => {
        if (b.activeAssigned !== a.activeAssigned)
            return b.activeAssigned - a.activeAssigned;
        if (b.totalAssigned !== a.totalAssigned)
            return b.totalAssigned - a.totalAssigned;
        return a.driverId.localeCompare(b.driverId);
    });
};
exports.listDriverWorkloads = listDriverWorkloads;
