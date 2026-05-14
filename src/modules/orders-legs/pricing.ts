import { PricingComponentSource } from "@prisma/client";
import prisma from "../../config/prismaClient";
import { enqueueCargoPilotDomainEventsTx } from "../../features/manager/analyticsOutbox";
import { orderError } from "../orders-core/shared";
import {
  ensureOrderExists,
  resolveActorTenantScope,
  type Actor,
  type CreatePricingComponentInput,
} from "./shared";

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
