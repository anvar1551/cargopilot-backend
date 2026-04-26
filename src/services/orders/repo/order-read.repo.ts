import prisma from "../../../config/prismaClient";
import { AppRole, OrderStatus, Prisma } from "@prisma/client";

import {
  isUuid,
  looksLikeOrderNumber,
  looksLikeParcelCode,
  userLiteSelect,
} from "./order-repo.shared";

type ListMode = "page" | "cursor";
type SearchScope = "fast" | "deep";

export type OrderListFilters = {
  statuses?: string[];
  createdFrom?: string;
  createdTo?: string;
  customerQuery?: string;
  assignedDriverId?: string;
  warehouseId?: string;
  region?: string;
};

type ListOrdersParams = {
  q?: string;
  page?: number;
  limit?: number;
  cursor?: string;
  mode?: ListMode;
  scope?: SearchScope;
} & OrderListFilters;

type OrderCursor = {
  id: string;
  createdAt: Date;
};

const ORDER_STATUS_VALUES = new Set<string>(Object.values(OrderStatus));

function encodeCursor(value: OrderCursor) {
  const raw = `${value.createdAt.toISOString()}|${value.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

function decodeCursor(token?: string | null): OrderCursor | null {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [dateRaw, id] = decoded.split("|");
    if (!dateRaw || !id) return null;
    const createdAt = new Date(dateRaw);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
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
  customer: { select: userLiteSelect },
  assignedDriver: { select: userLiteSelect },
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
} satisfies Prisma.OrderSelect;

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
  customer: { select: userLiteSelect },
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
  assignedDriver: { select: userLiteSelect },
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
} satisfies Prisma.OrderSelect;

function isEmptyWhere(where: Prisma.OrderWhereInput | null | undefined) {
  return !where || Object.keys(where).length === 0;
}

function normalizeStatuses(values?: string[]) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter((value): value is OrderStatus => ORDER_STATUS_VALUES.has(value)),
    ),
  );
}

function parseDateFloor(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseDateCeilingExclusive(value?: string) {
  const date = parseDateFloor(value);
  if (!date) return null;
  date.setDate(date.getDate() + 1);
  return date;
}

function buildDateWhere(
  field: "createdAt" | "plannedPickupAt" | "plannedDeliveryAt",
  from?: string,
  to?: string,
): Prisma.OrderWhereInput {
  const gte = parseDateFloor(from);
  const lt = parseDateCeilingExclusive(to);
  if (!gte && !lt) return {};

  const range: { gte?: Date; lt?: Date } = {};
  if (gte) range.gte = gte;
  if (lt) range.lt = lt;

  return { [field]: range } as Prisma.OrderWhereInput;
}

function buildRoleScopeWhere(
  userId: string,
  role: AppRole,
  customerEntityId?: string | null,
  warehouseId?: string | null,
): Prisma.OrderWhereInput {
  if (role === "customer") {
    if (customerEntityId) {
      return { customerEntityId };
    }
    return { customerId: userId };
  }
  if (role === "driver") return { assignedDriverId: userId };
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

function buildSearchWhere(
  qRaw: string,
  scope: SearchScope,
): Prisma.OrderWhereInput {
  const q = qRaw.trim();
  if (!q) return {};

  if (isUuid(q)) return { id: q };

  if (looksLikeOrderNumber(q)) {
    return {
      OR: [{ orderNumber: q }, { orderNumber: { startsWith: q } }],
    };
  }

  if (looksLikeParcelCode(q)) {
    return {
      parcels: {
        some: {
          OR: [{ parcelCode: q }, { parcelCode: { startsWith: q } }],
        },
      },
    };
  }

  const fastOr: Prisma.OrderWhereInput[] = [
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

function buildStructuredFiltersWhere(
  params?: OrderListFilters,
): Prisma.OrderWhereInput {
  if (!params) return {};

  const and: Prisma.OrderWhereInput[] = [];
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

  const createdAtWhere = buildDateWhere(
    "createdAt",
    params.createdFrom,
    params.createdTo,
  );
  if (!isEmptyWhere(createdAtWhere)) {
    and.push(createdAtWhere);
  }

  if (and.length === 0) return {};
  return { AND: and };
}

function buildOrderWhere(
  userId: string,
  role: AppRole,
  customerEntityId?: string | null,
  warehouseId?: string | null,
  params?: ListOrdersParams,
): Prisma.OrderWhereInput {
  const scope: SearchScope = params?.scope === "deep" ? "deep" : "fast";
  const q = params?.q?.trim() ?? "";
  const effectiveParams =
    role === "warehouse" && params
      ? { ...params, warehouseId: undefined }
      : params;
  const roleWhere = buildRoleScopeWhere(
    userId,
    role,
    customerEntityId,
    warehouseId,
  );
  const searchWhere = q ? buildSearchWhere(q, scope) : {};
  const filterWhere = buildStructuredFiltersWhere(effectiveParams);
  const and = [roleWhere, searchWhere, filterWhere].filter(
    (item) => !isEmptyWhere(item),
  );

  if (and.length === 0) return {};
  if (and.length === 1) return and[0];
  return { AND: and };
}

/** Returns a single order with full details used by manager/customer/driver views. */
export const getOrderById = async (id: string) => {
  return prisma.order.findUnique({
    where: { id },
    include: {
      customer: { select: userLiteSelect },
      assignedDriver: { select: userLiteSelect },
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
          currentHolderUser: { select: userLiteSelect },
          currentHolderWarehouse: true,
          events: {
            include: {
              actor: { select: userLiteSelect },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      },
      trackingEvents: {
        include: {
          warehouse: true,
          actor: { select: userLiteSelect },
          parcel: true,
        },
        orderBy: { timestamp: "asc" },
      },
    },
  });
};

/** Lists orders with search + pagination and role-based scope restrictions. */
export const listOrders = async (
  userId: string,
  role: AppRole,
  customerEntityId?: string | null,
  warehouseId?: string | null,
  params?: ListOrdersParams,
) => {
  const page = Math.max(1, params?.page ?? 1);
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);
  const mode: ListMode = params?.mode === "cursor" ? "cursor" : "page";
  const cursor = decodeCursor(params?.cursor);
  const skip = (page - 1) * limit;
  const where = buildOrderWhere(
    userId,
    role,
    customerEntityId,
    warehouseId,
    params,
  );

  if (mode === "cursor") {
    const whereWithCursor: Prisma.OrderWhereInput = cursor
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

    const rows = await prisma.order.findMany({
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
      nextCursor:
        hasMore && tail
          ? encodeCursor({ id: tail.id, createdAt: tail.createdAt })
          : null,
      mode: "cursor" as const,
      totalExact: false as const,
    };
  }

  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      select: orderListSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
    prisma.order.count({ where }),
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
    mode: "page" as const,
    totalExact: true as const,
  };
};

/** Returns detailed rows for CSV export using the same filters as the manager list. */
export const listOrdersForExport = async (
  userId: string,
  role: AppRole,
  customerEntityId?: string | null,
  warehouseId?: string | null,
  params?: ListOrdersParams,
) => {
  const where = buildOrderWhere(
    userId,
    role,
    customerEntityId,
    warehouseId,
    params,
  );
  return prisma.order.findMany({
    where,
    select: orderExportSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
};

/** Returns exact count for current export filters to guard large synchronous CSV exports. */
export const countOrdersForExport = async (
  userId: string,
  role: AppRole,
  customerEntityId?: string | null,
  warehouseId?: string | null,
  params?: ListOrdersParams,
) => {
  const where = buildOrderWhere(
    userId,
    role,
    customerEntityId,
    warehouseId,
    params,
  );
  return prisma.order.count({ where });
};

type DriverWorkload = {
  driverId: string;
  totalAssigned: number;
  activeAssigned: number;
  byStatus: Record<string, number>;
};

const FINAL_STATUSES = new Set<OrderStatus>([
  OrderStatus.delivered,
  OrderStatus.returned,
  OrderStatus.cancelled,
]);

/** Aggregates assigned order counts by driver with status breakdown. */
export const listDriverWorkloads = async (): Promise<DriverWorkload[]> => {
  const rows = await prisma.order.groupBy({
    by: ["assignedDriverId", "status"],
    where: { assignedDriverId: { not: null } },
    _count: { _all: true },
  });

  const byDriver = new Map<string, DriverWorkload>();

  for (const row of rows) {
    const driverId = row.assignedDriverId;
    if (!driverId) continue;

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
    if (b.activeAssigned !== a.activeAssigned) return b.activeAssigned - a.activeAssigned;
    if (b.totalAssigned !== a.totalAssigned) return b.totalAssigned - a.totalAssigned;
    return a.driverId.localeCompare(b.driverId);
  });
};
