import { OrderLegStatus, Prisma, TransportMode } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { enqueueCargoPilotDomainEventsTx } from "../analytics-core/infrastructure/analyticsOutbox";
import { orderError } from "../orders-core/shared";
import {
  ensureOrderExists,
  resolveActorTenantScope,
  toDate,
  type Actor,
  type UpsertOrderLegInput,
} from "./shared";

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
          actorRole: null,
        },
      },
    ]);

    return leg;
  });
}
