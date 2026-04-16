import prisma from "../../../config/prismaClient";
import { OrderStatus } from "@prisma/client";

import { getNextOrderNumber } from "../../../utils/orderNumber";
import { CreateOrderRepoPayload } from "../orderCreate.mapper";
import { OrderActor, orderError } from "../orderService.shared";
import { userLiteSelect } from "./order-repo.shared";

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

function toDateOrNull(v?: Date | string | null) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function assertFkExists(payload: CreateOrderRepoPayload) {
  if (payload.customerEntityId) {
    const exists = await prisma.customerEntity.findUnique({
      where: { id: payload.customerEntityId },
      select: { id: true },
    });
    if (!exists) {
      throw orderError("customerEntityId not found", 400);
    }
  }

  if (payload.senderAddressId) {
    const exists = await prisma.address.findUnique({
      where: { id: payload.senderAddressId },
      select: { id: true },
    });
    if (!exists) {
      throw orderError("senderAddressId not found", 400);
    }
  }

  if (payload.receiverAddressId) {
    const exists = await prisma.address.findUnique({
      where: { id: payload.receiverAddressId },
      select: { id: true },
    });
    if (!exists) {
      throw orderError("receiverAddressId not found", 400);
    }
  }
}

/** Persists a new order with related parcels and initial tracking event. */
export const createOrder = async (
  customerId: string,
  payload: CreateOrderRepoPayload,
  actor?: OrderActor,
) => {
  const wantsSavePickup = payload.savePickupToAddressBook === true;
  const wantsSaveDropoff = payload.saveDropoffToAddressBook === true;

  if ((wantsSavePickup || wantsSaveDropoff) && !payload.customerEntityId) {
    throw orderError("customerEntityId is required to save addresses", 400);
  }

  if (wantsSavePickup && !payload.senderAddressId) {
    const snap = sanitizeSnapshot(payload.senderAddressSnapshot);
    if (!snap) {
      throw orderError(
        "senderAddress (structured) is required to save pickup address",
        400,
      );
    }
  }

  if (wantsSaveDropoff && !payload.receiverAddressId) {
    const snap = sanitizeSnapshot(payload.receiverAddressSnapshot);
    if (!snap) {
      throw orderError(
        "receiverAddress (structured) is required to save dropoff address",
        400,
      );
    }
  }

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
      senderPhone2: payload.senderPhone2 ?? null,
      senderPhone3: payload.senderPhone3 ?? null,
      senderAddress: payload.senderAddress ?? null,
      receiverName: payload.receiverName ?? null,
      receiverPhone: payload.receiverPhone ?? null,
      receiverPhone2: payload.receiverPhone2 ?? null,
      receiverPhone3: payload.receiverPhone3 ?? null,
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
