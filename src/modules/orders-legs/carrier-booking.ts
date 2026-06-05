import { TransportMode } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { orderError } from "../orders-core/shared";
import { enqueueCargoPilotDomainEventsTx } from "../analytics-core/infrastructure/analyticsOutbox";
import { resolveActorTenantScope, type Actor } from "./shared";

const db = prisma as any;

type BookCarrierForOrderLegInput = {
  orderId: string;
  legId: string;
  providerId: string;
  actor: Actor & { companyId?: string | null };
};

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "bigint") return String(value);
  }
  return null;
}

function toMinor(value: unknown) {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numberValue) || numberValue <= 0) return undefined;
  return BigInt(Math.round(numberValue * 100)).toString();
}

function normalizeTransportMode(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["road", "air", "rail", "sea", "multimodal"].includes(normalized)) return normalized;
  return "road";
}

function addressNode(args: {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
}) {
  const name = firstString(args.name);
  const phone = firstString(args.phone);
  const address = firstString(args.address);
  if (!name || !phone || !address) return null;
  return {
    name,
    phone,
    address,
    ...(typeof args.lat === "number" ? { lat: args.lat } : {}),
    ...(typeof args.lng === "number" ? { lng: args.lng } : {}),
  };
}

function buildParcels(order: any) {
  const parcelRows = Array.isArray(order.parcels) ? order.parcels : [];
  const fromParcels = parcelRows
    .map((parcel: any) => {
      const weightKg = Number(parcel.weightKg);
      if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
      return {
        weightKg,
        quantity: 1,
        description: firstString(parcel.parcelCode) ?? undefined,
      };
    })
    .filter(Boolean);

  if (fromParcels.length > 0) return fromParcels;

  const fallbackWeight = Number(order.weightKg);
  if (Number.isFinite(fallbackWeight) && fallbackWeight > 0) {
    return [{ weightKg: fallbackWeight, quantity: 1, description: order.orderNumber }];
  }

  return [];
}

async function isOrgInsideCompany(tx: any, orgId: string | null | undefined, companyId: string) {
  if (!orgId) return true;
  if (orgId === companyId) return true;

  let currentId: string | null = orgId;
  for (let depth = 0; currentId && depth < 16; depth += 1) {
    const org: { id: string; parentOrgId: string | null } | null = await tx.organization.findUnique({
      where: { id: currentId },
      select: { id: true, parentOrgId: true },
    });
    if (!org) return false;
    if (org.parentOrgId === companyId) return true;
    currentId = org.parentOrgId;
  }

  return false;
}

function buildCarrierCreateShipmentInput(order: any, leg: any) {
  const sender = addressNode({
    name: order.senderName ?? order.customer?.name,
    phone: firstString(order.senderPhone, order.senderPhone2, order.senderPhone3),
    address: firstString(order.senderAddress, order.pickupAddress),
    lat: order.pickupLat,
    lng: order.pickupLng,
  });
  const receiver = addressNode({
    name: order.receiverName,
    phone: firstString(order.receiverPhone, order.receiverPhone2, order.receiverPhone3),
    address: firstString(order.receiverAddress, order.dropoffAddress),
    lat: order.dropoffLat,
    lng: order.dropoffLng,
  });
  const parcels = buildParcels(order);

  if (!sender) throw orderError("Order is missing sender contact/address for carrier booking", 400);
  if (!receiver) throw orderError("Order is missing receiver contact/address for carrier booking", 400);
  if (parcels.length === 0) throw orderError("Order is missing parcel weight for carrier booking", 400);

  return {
    externalOrderId: order.orderNumber,
    sender,
    receiver,
    parcels,
    declaredValueMinor: toMinor(order.itemValue),
    currency: firstString(order.currency) ?? "UZS",
    transportMode: normalizeTransportMode(leg.mode ?? TransportMode.road),
    serviceCode: firstString(order.serviceType),
    metadata: {
      orderId: order.id,
      orderLegId: leg.id,
      orderNumber: order.orderNumber,
      legSequence: leg.sequence,
      fromCountry: leg.fromCountry ?? null,
      toCountry: leg.toCountry ?? null,
    },
  };
}

export async function bookCarrierForOrderLeg(input: BookCarrierForOrderLegInput) {
  const companyId = firstString(input.actor.companyId);
  if (!companyId) throw orderError("Active company membership is required", 403);

  return db.$transaction(async (tx: any) => {
    const provider = await tx.integrationProvider.findFirst({
      where: {
        id: input.providerId,
        companyId,
        domain: "carrier",
        status: "active",
      },
      select: {
        id: true,
        companyId: true,
        providerCode: true,
        environment: true,
        timeoutMs: true,
      },
    });
    if (!provider) {
      throw orderError("Active carrier provider not found for this company", 403);
    }

    const leg = await tx.orderLeg.findFirst({
      where: { id: input.legId, orderId: input.orderId },
      include: {
        order: {
          include: {
            parcels: true,
            customer: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    if (!leg) throw orderError("Order leg not found for this order", 404);

    const order = leg.order;
    const [ownerAllowed, assignedAllowed] = await Promise.all([
      isOrgInsideCompany(tx, order.ownerOrgId, provider.companyId),
      isOrgInsideCompany(tx, order.assignedOrgId, provider.companyId),
    ]);
    if (!ownerAllowed || !assignedAllowed) {
      throw orderError("Carrier provider is outside this order company scope", 403);
    }

    const shipmentInput = buildCarrierCreateShipmentInput(order, leg);
    const now = new Date();
    const idempotencyKey = `carrier:create-shipment:${leg.id}:${provider.id}`;
    const envelope = {
      eventId: idempotencyKey,
      eventType: "shipment.assigned",
      occurredAt: now.toISOString(),
      companyId: provider.companyId,
      aggregateType: "shipment",
      aggregateId: leg.id,
      schemaVersion: 1,
      source: "orders-core",
      payload: {
        action: "create_shipment",
        input: shipmentInput,
      },
    };

    const updatedLeg = await tx.orderLeg.update({
      where: { id: leg.id },
      data: {
        carrierProviderId: provider.id,
        carrierCode: provider.providerCode,
        carrierBookingStatus: "requested",
        carrierBookingError: null,
      },
    });

    const outbox = await tx.integrationOutbox.upsert({
      where: {
        companyId_providerCode_idempotencyKey: {
          companyId: provider.companyId,
          providerCode: provider.providerCode,
          idempotencyKey,
        },
      },
      create: {
        companyId: provider.companyId,
        providerId: provider.id,
        domain: "carrier",
        providerCode: provider.providerCode,
        environment: provider.environment,
        eventType: "shipment.assigned",
        aggregateType: "shipment",
        aggregateId: leg.id,
        operation: "create_shipment",
        status: "pending",
        maxAttempts: 10,
        attemptCount: 0,
        nextAttemptAt: now,
        lastError: null,
        idempotencyKey,
        payload: envelope,
      },
      update: {
        providerId: provider.id,
        environment: provider.environment,
        aggregateType: "shipment",
        aggregateId: leg.id,
        operation: "create_shipment",
        ...(leg.carrierBookingStatus === "failed"
          ? {
              status: "pending",
              nextAttemptAt: now,
              lastError: null,
            }
          : {}),
      },
    });

    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_status_changed",
        tenantScope: resolveActorTenantScope(input.actor),
        entityId: order.id,
        payload: {
          source: "carrier_booking_requested",
          orderId: order.id,
          legId: leg.id,
          providerId: provider.id,
          providerCode: provider.providerCode,
          actorId: input.actor.id,
          actorRole: null,
        },
      },
    ]);

    return {
      leg: updatedLeg,
      outbox: {
        id: outbox.id,
        status: outbox.status,
        idempotencyKey: outbox.idempotencyKey,
        providerId: outbox.providerId,
        providerCode: outbox.providerCode,
      },
    };
  });
}
