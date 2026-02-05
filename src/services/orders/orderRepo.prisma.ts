import prisma from "../../config/prismaClient";
import { OrderStatus, AppRole } from "@prisma/client";
import { getNextOrderNumber } from "../../utils/orderNumber";

const userLiteSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
};

type ListManagerOrdersArgs = {
  q?: string;
  status?: string;
  page?: number;
  limit?: number;
};

type Actor = {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
};

type CreateOrderPayload = {
  pickupAddress: string;
  dropoffAddress: string;

  destinationCity?: string;

  senderName?: string;
  senderPhone?: string;
  senderAddress?: string;

  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;

  serviceType?: string;
  codAmount?: number;
  currency?: string;
  weightKg?: number;

  // parcels support
  pieceTotal?: number;
  parcels?: Array<{
    weightKg?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
  }>;
};

export const createOrder = async (
  customerId: string,
  payload: CreateOrderPayload,
  actor?: Actor,
) => {
  const orderNumber = await getNextOrderNumber();

  const pieceTotal =
    payload.pieceTotal ??
    (payload.parcels?.length ? payload.parcels.length : 1);

  const parcelsToCreate = payload.parcels?.length
    ? payload.parcels.map((p, idx) => ({
        pieceNo: idx + 1,
        pieceTotal,
        weightKg: p.weightKg ?? null,
        lengthCm: p.lengthCm ?? null,
        widthCm: p.widthCm ?? null,
        heightCm: p.heightCm ?? null,
        // ✅ Scan code based on enterprise number
        parcelCode: `${orderNumber}-${idx + 1}/${pieceTotal}`,
      }))
    : [
        {
          pieceNo: 1,
          pieceTotal,
          parcelCode: `${orderNumber}-1/${pieceTotal}`,
        },
      ];

  return prisma.order.create({
    data: {
      customerId,

      orderNumber,
      status: OrderStatus.pending,

      pickupAddress: payload.pickupAddress,
      dropoffAddress: payload.dropoffAddress,
      destinationCity: payload.destinationCity ?? null,

      senderName: payload.senderName ?? null,
      senderPhone: payload.senderPhone ?? null,
      senderAddress: payload.senderAddress ?? null,

      receiverName: payload.receiverName ?? null,
      receiverPhone: payload.receiverPhone ?? null,
      receiverAddress: payload.receiverAddress ?? null,

      serviceType: payload.serviceType ?? null,
      codAmount: payload.codAmount ?? null,
      currency: payload.currency ?? null,
      weightKg: payload.weightKg ?? null,

      parcels: { create: parcelsToCreate },

      trackingEvents: {
        create: {
          event: "created",
          status: OrderStatus.pending,
          note: "Order created",
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          warehouseId: actor?.warehouseId ?? null,
          region: null,
        },
      },
    },
    include: {
      customer: true,
      parcels: true,
      trackingEvents: {
        include: {
          actor: { select: userLiteSelect },
          warehouse: true,
          parcel: true,
        },
        orderBy: { timestamp: "asc" },
      },
      invoice: true,
    },
  });
};

export const getOrderById = async (id: string) => {
  return await prisma.order.findUnique({
    where: { id },
    include: {
      customer: { select: userLiteSelect },
      assignedDriver: { select: userLiteSelect },
      currentWarehouse: true,
      invoice: true,
      parcels: true,
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

export const listOrders = async (
  userId: string,
  role: AppRole,
  params?: {
    q?: string;
    page?: number;
    limit?: number;
  },
) => {
  const q = params?.q?.trim();
  const page = params?.page ?? 1;
  const limit = Math.min(params?.limit ?? 120, 200); // safety cap
  const skip = (page - 1) * limit;

  const where: any = {};
  const isUuid =
    !!q &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      q,
    );

  if (q) {
    where.OR = [
      // ✅ UUID-safe: only exact match when it’s actually a UUID
      ...(isUuid ? [{ id: q }] : []),

      { pickupAddress: { contains: q, mode: "insensitive" } },
      { dropoffAddress: { contains: q, mode: "insensitive" } },

      { orderNumber: { equals: q } },
      { orderNumber: { contains: q, mode: "insensitive" } },
      {
        parcels: {
          some: { parcelCode: { contains: q, mode: "insensitive" } },
        },
      },

      {
        customer: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        },
      },

      {
        currentWarehouse: {
          name: { contains: q, mode: "insensitive" },
        },
      },
    ];
  }

  // 🔐 ROLE FILTERING
  if (role === "customer") {
    where.customerId = userId;
  }

  if (role === "driver") {
    where.assignedDriverId = userId;
  }

  // 🚀 QUERY
  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        customer: { select: userLiteSelect },
        assignedDriver: { select: userLiteSelect },
        currentWarehouse: true,
        invoice: true,
        parcels: true,
        trackingEvents: {
          include: {
            warehouse: true,
            actor: { select: userLiteSelect },
            parcel: true,
          },
          orderBy: { timestamp: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
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
  };
};
