import {
  AppRole,
  OrderDocumentType,
  OrderLegStatus,
  PricingComponentSource,
  PricingComponentType,
  Prisma,
  TransportMode,
} from "@prisma/client";
import prisma from "../../config/prismaClient";
import { enqueueCargoPilotDomainEventsTx } from "../../features/manager/analyticsOutbox";
import { orderError } from "../../services/orders/orderService.shared";

type Actor = {
  id: string;
  role: AppRole;
  warehouseId?: string | null;
};

type UpsertOrderLegInput = {
  legId?: string | null;
  sequence?: number | null;
  mode?: TransportMode | null;
  status?: OrderLegStatus | null;
  fromCountry?: string | null;
  toCountry?: string | null;
  transitRoute?: unknown;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
  carrierCode?: string | null;
  carrierRef?: string | null;
  vehicleRef?: string | null;
  plannedDepartureAt?: string | Date | null;
  plannedArrivalAt?: string | Date | null;
  actualDepartureAt?: string | Date | null;
  actualArrivalAt?: string | Date | null;
  notes?: string | null;
  metadata?: unknown;
};

type CreatePricingComponentInput = {
  orderLegId?: string | null;
  componentType: PricingComponentType;
  source?: PricingComponentSource | null;
  description?: string | null;
  amount: number;
  currency: string;
  fxRateSnapshot?: number | null;
  baseCurrency?: string | null;
  baseAmount?: number | null;
  referenceKey?: string | null;
};

function toDate(value?: string | Date | null) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw orderError(`Invalid date: ${value}`, 400);
  }
  return parsed;
}

function resolveActorTenantScope(actor?: Actor) {
  if (actor?.role === "warehouse" && actor.warehouseId) {
    return `warehouse:${actor.warehouseId}`;
  }
  if (actor?.role) {
    return `role:${actor.role}`;
  }
  return "global";
}

async function ensureOrderExists(orderId: string) {
  const exists = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!exists) {
    throw orderError("Order not found", 404);
  }
}

export async function listOrderLegs(orderId: string) {
  await ensureOrderExists(orderId);
  return prisma.orderLeg.findMany({
    where: { orderId },
    orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
  });
}

export async function upsertOrderLeg(
  orderId: string,
  input: UpsertOrderLegInput,
  actor?: Actor,
) {
  await ensureOrderExists(orderId);

  if (!input.legId && (input.sequence == null || input.sequence <= 0)) {
    throw orderError("sequence is required for new leg and must be > 0", 400);
  }

  return prisma.$transaction(async (tx) => {
    let leg;

    if (input.legId) {
      const existing = await tx.orderLeg.findFirst({
        where: { id: input.legId, orderId },
        select: { id: true },
      });
      if (!existing) {
        throw orderError("Order leg not found for this order", 404);
      }

      leg = await tx.orderLeg.update({
        where: { id: existing.id },
        data: {
          sequence: input.sequence ?? undefined,
          mode: input.mode ?? undefined,
          status: input.status ?? undefined,
          fromCountry: input.fromCountry ?? undefined,
          toCountry: input.toCountry ?? undefined,
          transitRoute:
            input.transitRoute === undefined
              ? undefined
              : (input.transitRoute as Prisma.InputJsonValue),
          fromWarehouseId: input.fromWarehouseId ?? undefined,
          toWarehouseId: input.toWarehouseId ?? undefined,
          carrierCode: input.carrierCode ?? undefined,
          carrierRef: input.carrierRef ?? undefined,
          vehicleRef: input.vehicleRef ?? undefined,
          plannedDepartureAt: toDate(input.plannedDepartureAt) ?? undefined,
          plannedArrivalAt: toDate(input.plannedArrivalAt) ?? undefined,
          actualDepartureAt: toDate(input.actualDepartureAt) ?? undefined,
          actualArrivalAt: toDate(input.actualArrivalAt) ?? undefined,
          notes: input.notes ?? undefined,
          metadata:
            input.metadata === undefined
              ? undefined
              : (input.metadata as Prisma.InputJsonValue),
        },
      });
    } else {
      leg = await tx.orderLeg.create({
        data: {
          orderId,
          sequence: input.sequence!,
          mode: input.mode ?? TransportMode.road,
          status: input.status ?? OrderLegStatus.planned,
          fromCountry: input.fromCountry ?? null,
          toCountry: input.toCountry ?? null,
          transitRoute: (input.transitRoute as Prisma.InputJsonValue) ?? undefined,
          fromWarehouseId: input.fromWarehouseId ?? null,
          toWarehouseId: input.toWarehouseId ?? null,
          carrierCode: input.carrierCode ?? null,
          carrierRef: input.carrierRef ?? null,
          vehicleRef: input.vehicleRef ?? null,
          plannedDepartureAt: toDate(input.plannedDepartureAt),
          plannedArrivalAt: toDate(input.plannedArrivalAt),
          actualDepartureAt: toDate(input.actualDepartureAt),
          actualArrivalAt: toDate(input.actualArrivalAt),
          notes: input.notes ?? null,
          metadata: (input.metadata as Prisma.InputJsonValue) ?? undefined,
        },
      });
    }

    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_status_changed",
        tenantScope: resolveActorTenantScope(actor),
        entityId: orderId,
        payload: {
          source: "order_leg_upsert",
          legId: leg.id,
          mode: leg.mode,
          status: leg.status,
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
        },
      },
    ]);

    return leg;
  });
}

export async function listPricingComponents(orderId: string) {
  await ensureOrderExists(orderId);
  return prisma.pricingComponent.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "desc" }],
  });
}

export async function createPricingComponent(
  orderId: string,
  input: CreatePricingComponentInput,
  actor?: Actor,
) {
  await ensureOrderExists(orderId);
  if (!Number.isFinite(input.amount)) {
    throw orderError("amount must be a finite number", 400);
  }
  if (!input.currency || !input.currency.trim()) {
    throw orderError("currency is required", 400);
  }

  return prisma.$transaction(async (tx) => {
    if (input.orderLegId) {
      const leg = await tx.orderLeg.findFirst({
        where: { id: input.orderLegId, orderId },
        select: { id: true },
      });
      if (!leg) {
        throw orderError("orderLegId is invalid for this order", 400);
      }
    }

    const created = await tx.pricingComponent.create({
      data: {
        orderId,
        orderLegId: input.orderLegId ?? null,
        componentType: input.componentType,
        source: input.source ?? PricingComponentSource.manual,
        description: input.description ?? null,
        amount: input.amount,
        currency: input.currency.trim().toUpperCase(),
        fxRateSnapshot: input.fxRateSnapshot ?? null,
        baseCurrency: input.baseCurrency?.trim().toUpperCase() ?? null,
        baseAmount: input.baseAmount ?? null,
        referenceKey: input.referenceKey ?? null,
      },
    });

    await enqueueCargoPilotDomainEventsTx(tx, [
      {
        type: "order_status_changed",
        tenantScope: resolveActorTenantScope(actor),
        entityId: orderId,
        payload: {
          source: "pricing_component_create",
          pricingComponentId: created.id,
          componentType: created.componentType,
          currency: created.currency,
          amount: String(created.amount),
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
        },
      },
    ]);

    return created;
  });
}

export async function listOrderDocuments(
  orderId: string,
  args?: { type?: OrderDocumentType | null; limit?: number | null },
) {
  await ensureOrderExists(orderId);
  const limit = Math.min(Math.max(args?.limit ?? 100, 1), 500);
  return prisma.orderDocument.findMany({
    where: {
      orderId,
      ...(args?.type ? { type: args.type } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });
}

