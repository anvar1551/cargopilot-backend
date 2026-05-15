import prisma from "../../../config/prismaClient";
import { OrderStatus, Prisma } from "@prisma/client";

import { buildInitialOrderCashCollections } from "../cash";
import { enqueueCargoPilotDomainEventsTx } from "../../../features/manager/analyticsOutbox";
import { resolveOrderSlaSnapshot } from "../sla";
import { CreateOrderRepoPayload } from "../domain/orderCreate.mapper";
import { OrderActor, orderError } from "../shared";
import { userLiteSelect } from "./order-repo.shared";

type TrackingActorRole = "customer" | "driver" | "warehouse" | "manager";

function sanitizeSnapshot(s: any) {
  if (!s || typeof s !== "object") return null;

  return {
    country: s.country ?? null,
    city: s.city ?? null,
    neighborhood: s.neighborhood ?? null,
    street: s.street ?? null,
    latitude:
      typeof s.latitude === "number" && Number.isFinite(s.latitude)
        ? s.latitude
        : null,
    longitude:
      typeof s.longitude === "number" && Number.isFinite(s.longitude)
        ? s.longitude
        : null,
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

function resolveActorTenantScope(actor?: OrderActor) {
  if (actor?.tenantScope) {
    return actor.tenantScope;
  }
  if (actor?.warehouseId) {
    return `warehouse:${actor.warehouseId}`;
  }
  if (actor?.id) {
    return `user:${actor.id}`;
  }
  return "system";
}

async function assertFkExistsTx(
  tx: Prisma.TransactionClient,
  payload: CreateOrderRepoPayload,
) {
  if (payload.customerEntityId) {
    const exists = await tx.customerEntity.findUnique({
      where: { id: payload.customerEntityId },
      select: { id: true },
    });
    if (!exists) {
      throw orderError("customerEntityId not found", 400);
    }
  }

  if (payload.senderAddressId) {
    const exists = await tx.address.findUnique({
      where: { id: payload.senderAddressId },
      select: { id: true },
    });
    if (!exists) {
      throw orderError("senderAddressId not found", 400);
    }
  }

  if (payload.receiverAddressId) {
    const exists = await tx.address.findUnique({
      where: { id: payload.receiverAddressId },
      select: { id: true },
    });
    if (!exists) {
      throw orderError("receiverAddressId not found", 400);
    }
  }
}

function normalizeActorRoleForTracking(
  role: string | null | undefined,
): TrackingActorRole | null {
  if (
    role === "customer" ||
    role === "driver" ||
    role === "warehouse" ||
    role === "manager"
  ) {
    return role;
  }
  return null;
}

async function getNextOrderNumberTx(tx: Prisma.TransactionClient): Promise<string> {
  const counter = await tx.counter.upsert({
    where: { key: "orderNumber" },
    update: { value: { increment: 1 } },
    create: { key: "orderNumber", value: 1 },
  });
  return `99${String(counter.value).padStart(10, "0")}`;
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
    if (!sanitizeSnapshot(payload.senderAddressSnapshot)) {
      throw orderError(
        "senderAddress (structured) is required to save pickup address",
        400,
      );
    }
  }

  if (wantsSaveDropoff && !payload.receiverAddressId) {
    if (!sanitizeSnapshot(payload.receiverAddressSnapshot)) {
      throw orderError(
        "receiverAddress (structured) is required to save dropoff address",
        400,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    let senderAddressId = payload.senderAddressId ?? null;
    let receiverAddressId = payload.receiverAddressId ?? null;

    if (wantsSavePickup && !senderAddressId) {
      const snap = sanitizeSnapshot(payload.senderAddressSnapshot)!;
      const created = await tx.address.create({
        data: {
          customerEntity: {
            connect: { id: payload.customerEntityId! },
          },
          ...snap,
          isSaved: true,
        },
        select: { id: true },
      });
      senderAddressId = created.id;
    }

    if (wantsSaveDropoff && !receiverAddressId) {
      const snap = sanitizeSnapshot(payload.receiverAddressSnapshot)!;
      const created = await tx.address.create({
        data: {
          customerEntity: {
            connect: { id: payload.customerEntityId! },
          },
          ...snap,
          isSaved: true,
        },
        select: { id: true },
      });
      receiverAddressId = created.id;
    }

    await assertFkExistsTx(tx, { ...payload, senderAddressId, receiverAddressId });

    const [senderAddressRecord, receiverAddressRecord] = await Promise.all([
      senderAddressId
        ? tx.address.findUnique({
            where: { id: senderAddressId },
            select: { city: true },
          })
        : Promise.resolve(null),
      receiverAddressId
        ? tx.address.findUnique({
            where: { id: receiverAddressId },
            select: { city: true },
          })
        : Promise.resolve(null),
    ]);

    const createdAt = new Date();
    const orderNumber = await getNextOrderNumberTx(tx);
    const slaSnapshot = await resolveOrderSlaSnapshot({
      serviceType: payload.serviceType ?? null,
      originQuery:
        payload.senderAddressSnapshot?.city ?? senderAddressRecord?.city ?? null,
      destinationQuery:
        payload.destinationCity ??
        payload.receiverAddressSnapshot?.city ??
        receiverAddressRecord?.city ??
        null,
      promiseDate: payload.promiseDate ?? null,
      createdAt,
    });

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

    const cashCollectionsToCreate = buildInitialOrderCashCollections(
      {
        codAmount: payload.codAmount ?? null,
        codPaidStatus: payload.codPaidStatus ?? null,
        serviceCharge: payload.serviceCharge ?? null,
        serviceChargePaidStatus: payload.serviceChargePaidStatus ?? null,
        deliveryChargePaidBy: payload.deliveryChargePaidBy ?? null,
        currency: payload.currency ?? null,
      },
      actor,
    );

    const created = await tx.order.create({
      data: {
        customerId,
        orderNumber,
        status: OrderStatus.pending,
        pickupAddress: payload.pickupAddress,
        dropoffAddress: payload.dropoffAddress,
        destinationCity: payload.destinationCity ?? null,
        pickupLat: payload.pickupLat ?? null,
        pickupLng: payload.pickupLng ?? null,
        dropoffLat: payload.dropoffLat ?? null,
        dropoffLng: payload.dropoffLng ?? null,
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
        expectedDeliveryAt: slaSnapshot.expectedDeliveryAt,
        slaSource: slaSnapshot.slaSource,
        slaRuleId: slaSnapshot.slaRuleId,
        slaTargetDays: slaSnapshot.slaTargetDays,
        referenceId: payload.referenceId ?? null,
        shelfId: payload.shelfId ?? null,
        promoCode: payload.promoCode ?? null,
        numberOfCalls: payload.numberOfCalls ?? null,
        fragile: payload.fragile ?? false,
        dangerousGoods: payload.dangerousGoods ?? false,
        shipmentInsurance: payload.shipmentInsurance ?? false,
        createdAt,
        parcels: { create: parcelsToCreate },
        ...(cashCollectionsToCreate.length > 0
          ? { cashCollections: { create: cashCollectionsToCreate } }
          : {}),
        trackingEvents: {
          create: {
            status: OrderStatus.pending,
            note: "Order created",
            actorId: actor?.id ?? null,
            actorRole: normalizeActorRoleForTracking(actor?.userRole),
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

    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_created",
        tenantScope: resolveActorTenantScope(actor),
        entityId: created.id,
        payload: {
          source: "createOrder",
          orderNumber: created.orderNumber,
          actorId: actor?.id ?? null,
          actorRole: normalizeActorRoleForTracking(actor?.userRole),
        },
      },
    ]);

    return created;
  });
};
