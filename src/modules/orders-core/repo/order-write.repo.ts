import { assertCreationInputAuthority, authorityError } from "../domain/creation-authority";
import { requireCompanyAuthority, hasCompanyScope } from "../domain/company-authority";
import prisma from "../../../config/prismaClient";
import { OrderPaymentState, OrderStatus, Prisma } from "@prisma/client";

import { buildInitialOrderCashCollections } from "../cash";
import { enqueueCargoPilotDomainEventsTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import { resolveOrderSlaSnapshot } from "../sla";
import { CreateOrderRepoPayload } from "../domain/orderCreate.mapper";
import { OrderActor, orderError } from "../shared";
import { userLiteSelect } from "./order-repo.shared";


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

function normalizeActorRoleForTracking(): null {
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
  assertCreationInputAuthority({
    customerEntityId: payload.customerEntityId,
    senderAddressId: payload.senderAddressId, receiverAddressId: payload.receiverAddressId,
    savePickupToAddressBook: payload.savePickupToAddressBook,
    saveDropoffToAddressBook: payload.saveDropoffToAddressBook,
  });
  if ((payload.codPaidStatus != null && payload.codPaidStatus !== "NOT_PAID") ||
      (payload.serviceChargePaidStatus != null && payload.serviceChargePaidStatus !== "NOT_PAID") ||
      payload.amount != null) throw authorityError("Client financial authority is not accepted");
  if (actor?.id !== customerId) throw authorityError("Order creator must be the authenticated identity", 403);
  return prisma.$transaction(async (tx) => {
    const membership = await requireCompanyAuthority(tx, actor, "shipment.create");
    if (!hasCompanyScope(membership)) throw authorityError("Company creation scope required", 403);
    const senderAddressId: string | null = null;
    const receiverAddressId: string | null = null;
    const createdAt = new Date();
    const orderNumber = await getNextOrderNumberTx(tx);
    const slaSnapshot = await resolveOrderSlaSnapshot({
      serviceType: payload.serviceType ?? null,
      originQuery:
        payload.senderAddressSnapshot?.city ?? null,
      destinationQuery:
        payload.destinationCity ??
        payload.receiverAddressSnapshot?.city ??
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
        codPaidStatus: "NOT_PAID",
        serviceCharge: payload.serviceCharge ?? null,
        serviceChargePaidStatus: "NOT_PAID",
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
        ownerOrgId: membership.companyId,
        customerEntityId: payload.customerEntityId ?? null,
        senderAddressId,
        receiverAddressId,
        serviceType: payload.serviceType ?? null,
        codAmount: payload.codAmount ?? null,
        currency: payload.currency ?? null,
        weightKg: payload.weightKg ?? null,
        paymentType: payload.paymentType ?? null,
        paymentState: OrderPaymentState.UNPAID,
        deliveryChargePaidBy: payload.deliveryChargePaidBy ?? null,
        ifRecipientNotAvailable: payload.ifRecipientNotAvailable ?? null,
        codPaidStatus: "NOT_PAID",
        serviceCharge: payload.serviceCharge ?? null,
        serviceChargePaidStatus: "NOT_PAID",
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
            actorRole: normalizeActorRoleForTracking(),
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
        tenantScope: `company:${membership.companyId}`,
        entityId: created.id,
        payload: {
          source: "createOrder",
          orderNumber: created.orderNumber,
          actorId: actor?.id ?? null,
          actorRole: normalizeActorRoleForTracking(),
        },
      },
    ]);

    return created;
  });
};
