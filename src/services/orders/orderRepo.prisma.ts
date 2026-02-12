import prisma from "../../config/prismaClient";
import { Prisma, OrderStatus, AppRole, TrackingAction } from "@prisma/client";
import { getNextOrderNumber } from "../../utils/orderNumber";
import { CreateOrderRepoPayload } from "./orderCreate.mapper";

const userLiteSelect = { id: true, name: true, email: true, role: true };

type Actor = {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
};

function sanitizeSnapshot(s: any) {
  if (!s || typeof s !== "object") return null;

  return {
    country: s.country ?? null,
    city: s.city ?? null,
    neighborhood: s.neighborhood ?? null,
    street: s.street ?? null,
    addressLine1: s.addressLine1 ?? null,
    addressLine2: s.addressLine2 ?? null,
    building: s.building ?? null,
    apartment: s.apartment ?? null,
    floor: s.floor ?? null,
    landmark: s.landmark ?? null,
    postalCode: s.postalCode ?? null,
    addressType: s.addressType ?? null,
    // keep passport fields out unless you really want them
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function looksLikeOrderNumber(value: string) {
  return /^[0-9]{6,20}$/.test(value);
}

function toDateOrNull(v?: Date | string | null) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function assertFkExists(payload: CreateOrderRepoPayload) {
  // ✅ only validate when user actually provided IDs
  if (payload.customerEntityId) {
    const exists = await prisma.customerEntity.findUnique({
      where: { id: payload.customerEntityId },
      select: { id: true },
    });
    if (!exists) {
      const e: any = new Error("customerEntityId not found");
      e.statusCode = 400;
      throw e;
    }
  }

  if (payload.senderAddressId) {
    const exists = await prisma.address.findUnique({
      where: { id: payload.senderAddressId },
      select: { id: true },
    });
    if (!exists) {
      const e: any = new Error("senderAddressId not found");
      e.statusCode = 400;
      throw e;
    }
  }

  if (payload.receiverAddressId) {
    const exists = await prisma.address.findUnique({
      where: { id: payload.receiverAddressId },
      select: { id: true },
    });
    if (!exists) {
      const e: any = new Error("receiverAddressId not found");
      e.statusCode = 400;
      throw e;
    }
  }
}

export const createOrder = async (
  customerId: string,
  payload: CreateOrderRepoPayload,
  actor?: Actor,
) => {
  // ✅ customerEntityId required only if we want to save addresses
  const wantsSavePickup = payload.savePickupToAddressBook === true;
  const wantsSaveDropoff = payload.saveDropoffToAddressBook === true;

  if ((wantsSavePickup || wantsSaveDropoff) && !payload.customerEntityId) {
    const e: any = new Error("customerEntityId is required to save addresses");
    e.statusCode = 400;
    throw e;
  }

  // ✅ if user wants save but didn't select an addressId, they must provide structured snapshot
  if (wantsSavePickup && !payload.senderAddressId) {
    const snap = sanitizeSnapshot(payload.senderAddressSnapshot);
    if (!snap) {
      const e: any = new Error(
        "senderAddress (structured) is required to save pickup address",
      );
      e.statusCode = 400;
      throw e;
    }
  }

  if (wantsSaveDropoff && !payload.receiverAddressId) {
    const snap = sanitizeSnapshot(payload.receiverAddressSnapshot);
    if (!snap) {
      const e: any = new Error(
        "receiverAddress (structured) is required to save dropoff address",
      );
      e.statusCode = 400;
      throw e;
    }
  }

  // ✅ create Address rows (only when needed)
  let senderAddressId = payload.senderAddressId ?? null;
  let receiverAddressId = payload.receiverAddressId ?? null;

  if (wantsSavePickup && !senderAddressId) {
    const snap = sanitizeSnapshot(payload.senderAddressSnapshot)!;

    const created = await prisma.address.create({
      data: {
        customerEntityId: payload.customerEntityId!,
        ...snap,
        isSaved: true,
      },
      select: { id: true },
    });

    senderAddressId = created.id;
  }

  if (wantsSaveDropoff && !receiverAddressId) {
    const snap = sanitizeSnapshot(payload.receiverAddressSnapshot)!;

    const created = await prisma.address.create({
      data: {
        customerEntityId: payload.customerEntityId!,
        ...snap,
        isSaved: true,
      },
      select: { id: true },
    });

    receiverAddressId = created.id;
  }

  // optional but makes errors clean
  await assertFkExists({ ...payload, senderAddressId, receiverAddressId });

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

      customerEntityId: payload.customerEntityId ?? null,
      senderAddressId,
      receiverAddressId,

      serviceType: payload.serviceType ?? null,
      codAmount: payload.codAmount ?? null,
      currency: payload.currency ?? null,
      weightKg: payload.weightKg ?? null,

      paymentType: payload.paymentType ?? null,
      deliveryChargePaidBy: payload.deliveryChargePaidBy ?? null,
      ifRecipientNotAvailable: payload.ifRecipientNotAvailable ?? null,

      codPaidStatus: payload.codPaidStatus ?? null,
      serviceCharge: payload.serviceCharge ?? null,
      serviceChargePaidStatus: payload.serviceChargePaidStatus ?? null,
      itemValue: payload.itemValue ?? null,

      plannedPickupAt: toDateOrNull(payload.plannedPickupAt),
      plannedDeliveryAt: toDateOrNull(payload.plannedDeliveryAt),
      promiseDate: toDateOrNull(payload.promiseDate),

      referenceId: payload.referenceId ?? null,
      shelfId: payload.shelfId ?? null,
      promoCode: payload.promoCode ?? null,
      numberOfCalls: payload.numberOfCalls ?? null,

      fragile: payload.fragile ?? false,
      dangerousGoods: payload.dangerousGoods ?? false,
      shipmentInsurance: payload.shipmentInsurance ?? false,

      parcels: { create: parcelsToCreate },

      trackingEvents: {
        create: {
          action: TrackingAction.ORDER_CREATED,
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
      customer: { select: userLiteSelect },

      customerEntity: true,
      senderAddressObj: true,
      receiverAddressObj: true,
      attachments: true,

      parcels: true,
      currentWarehouse: true,
      assignedDriver: { select: userLiteSelect },
      invoice: true,

      trackingEvents: {
        include: {
          actor: { select: userLiteSelect },
          warehouse: true,
          parcel: true,
        },
        orderBy: { timestamp: "asc" },
      },
    },
  });
};

export const getOrderById = async (id: string) => {
  return prisma.order.findUnique({
    where: { id },
    include: {
      customer: { select: userLiteSelect },
      assignedDriver: { select: userLiteSelect },
      currentWarehouse: true,
      invoice: true,

      // ✅ avoid loading full address book (scales better)
      customerEntity: {
        include: {
          defaultAddress: true,
          // addresses: true, // <-- do not load all by default
        },
      },

      senderAddressObj: true,
      receiverAddressObj: true,
      attachments: true,

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
  params?: { q?: string; page?: number; limit?: number },
) => {
  const q = params?.q?.trim();
  const page = params?.page ?? 1;
  const limit = Math.min(params?.limit ?? 50, 200);
  const skip = (page - 1) * limit;

  const where: Prisma.OrderWhereInput = {};

  if (q) {
    const or: Prisma.OrderWhereInput[] = [];

    if (isUuid(q)) or.push({ id: q });
    if (looksLikeOrderNumber(q)) or.push({ orderNumber: q });

    or.push(
      { pickupAddress: { contains: q, mode: "insensitive" } },
      { dropoffAddress: { contains: q, mode: "insensitive" } },
      { orderNumber: { contains: q, mode: "insensitive" } },
      { referenceId: { contains: q, mode: "insensitive" } },

      {
        parcels: { some: { parcelCode: { contains: q, mode: "insensitive" } } },
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
    );

    where.OR = or;
  }

  if (role === "customer") where.customerId = userId;
  if (role === "driver") where.assignedDriverId = userId;

  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        customer: { select: userLiteSelect },
        assignedDriver: { select: userLiteSelect },
        currentWarehouse: true,
        invoice: true,

        customerEntity: true,
        senderAddressObj: true,
        receiverAddressObj: true,
        attachments: true,

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
