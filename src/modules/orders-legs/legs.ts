import { requireAuthorizedOrder, requireOrderWarehouseReference } from "../orders-core/domain/order-access";
import { OrderLegStatus, Prisma, TransportMode } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { enqueueCargoPilotDomainEventsTx } from "../analytics-core/infrastructure/analyticsOutbox";
import { orderError } from "../orders-core/shared";
import {
  resolveActorTenantScope,
  toDate,
  type Actor,
  type UpsertOrderLegInput,
} from "./shared";
import { autoBookCarrierForOrderLeg } from "./carrier-auto-booking";
import { requireDispatchAuthority, dispatchOrderWhere } from "../orders-core/domain/dispatch-authority";
import { lockDispatchBatch } from "../orders-core/domain/dispatch-batch";

export async function listOrderLegs(orderId: string, actor?: Actor) {
  await requireAuthorizedOrder(actor, orderId, "shipment.view");
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
  await requireAuthorizedOrder(actor, orderId, "shipment.update");
  if (input.status && input.status !== "planned" || input.actualDepartureAt || input.actualArrivalAt) throw orderError("Generic leg authoring is planning only",409);

  for (const warehouseId of [input.fromWarehouseId, input.toWarehouseId]) {
    if (!warehouseId) continue;
    await requireOrderWarehouseReference(actor!, warehouseId);
  }

  if (!input.legId && (input.sequence == null || input.sequence <= 0)) {
    throw orderError("sequence is required for new leg and must be > 0", 400);
  }

  const leg = await prisma.$transaction(async (tx) => {
    let authority=await requireDispatchAuthority(actor!,"shipment.update");
    await lockDispatchBatch(tx,authority,[orderId]);
    authority=await requireDispatchAuthority(actor!,"shipment.update");
    if (!await tx.order.findFirst({where:dispatchOrderWhere(authority,[orderId]),select:{id:true}})) throw orderError("Order no longer authorized",403);
    if (input.legId && await tx.orderCustodyAction.count({where:{orderId,legId:input.legId}})) throw orderError("Accepted custody leg cannot be edited",409);
    let leg;

    if (input.legId) {
      const existing = await tx.orderLeg.findFirst({
        where: { id: input.legId, orderId },
        select: { id: true, status:true, carrierBookingStatus:true },
      });
      if (!existing) {
        throw orderError("Order leg not found for this order", 404);
      }
      if(existing.status!=="planned" || existing.carrierBookingStatus!=="not_requested") throw orderError("Executed/accepted leg cannot be edited",409);

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

  if (!input.legId) {
    await autoBookCarrierForOrderLeg({ orderId, legId: leg.id, actor }).catch((error) => {
      console.error(
        `[carrier-routing] auto-book failed for order=${orderId} leg=${leg.id}:`,
        error,
      );
    });
  }

  return leg;
}
