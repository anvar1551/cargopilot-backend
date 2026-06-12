import { FastifyPluginAsync } from "fastify";
import {
  OrderDocumentType,
  OrderLegStatus,
  PricingComponentSource,
  PricingComponentType,
  TransportMode,
} from "@prisma/client";
import { fastifyAuth } from "../../../identity-access/transport/fastify-auth";
import { requireOrderActor } from "../..";
import {
  bookCarrierForOrderLeg,
  cancelCarrierForOrderLeg,
  createPricingComponent,
  listOrderDocuments,
  listOrderLegs,
  listPricingComponents,
  syncCarrierTrackingForOrderLeg,
  upsertOrderLeg,
} from "../../../orders-legs";
import { asEnumValue, emitMutationInvalidation, ensureOrderInScope, parseNumber, sendError } from "../shared";

function requireUuid(value: unknown, fieldName: string) {
  const normalized = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    const error = new Error(`${fieldName} must be a valid UUID`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

const legsPricingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/:id/legs", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const legs = await listOrderLegs(orderId);
      return reply.send({ legs });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/:id/legs", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const leg = await upsertOrderLeg(orderId, {
        legId: ((request.params as any)?.legId ?? body.legId ?? null) as string | null,
        sequence: parseNumber(body.sequence, "sequence"),
        mode: asEnumValue(body.mode, Object.values(TransportMode), "mode") as TransportMode | undefined,
        status: asEnumValue(body.status, Object.values(OrderLegStatus), "status") as OrderLegStatus | undefined,
        fromCountry: (body.fromCountry ?? undefined) as string | undefined,
        toCountry: (body.toCountry ?? undefined) as string | undefined,
        transitRoute: body.transitRoute,
        fromWarehouseId: (body.fromWarehouseId ?? undefined) as string | undefined,
        toWarehouseId: (body.toWarehouseId ?? undefined) as string | undefined,
        carrierCode: (body.carrierCode ?? undefined) as string | undefined,
        carrierRef: (body.carrierRef ?? undefined) as string | undefined,
        vehicleRef: (body.vehicleRef ?? undefined) as string | undefined,
        plannedDepartureAt: (body.plannedDepartureAt ?? undefined) as string | undefined,
        plannedArrivalAt: (body.plannedArrivalAt ?? undefined) as string | undefined,
        actualDepartureAt: (body.actualDepartureAt ?? undefined) as string | undefined,
        actualArrivalAt: (body.actualArrivalAt ?? undefined) as string | undefined,
        notes: (body.notes ?? undefined) as string | undefined,
        metadata: body.metadata,
      }, actor);
      await emitMutationInvalidation("order_mutation");
      return reply.send({ leg });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.put("/:id/legs/:legId", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const leg = await upsertOrderLeg(orderId, {
        legId: String((request.params as any)?.legId ?? "").trim() || null,
        sequence: parseNumber(body.sequence, "sequence"),
        mode: asEnumValue(body.mode, Object.values(TransportMode), "mode") as TransportMode | undefined,
        status: asEnumValue(body.status, Object.values(OrderLegStatus), "status") as OrderLegStatus | undefined,
        fromCountry: (body.fromCountry ?? undefined) as string | undefined,
        toCountry: (body.toCountry ?? undefined) as string | undefined,
        transitRoute: body.transitRoute,
        fromWarehouseId: (body.fromWarehouseId ?? undefined) as string | undefined,
        toWarehouseId: (body.toWarehouseId ?? undefined) as string | undefined,
        carrierCode: (body.carrierCode ?? undefined) as string | undefined,
        carrierRef: (body.carrierRef ?? undefined) as string | undefined,
        vehicleRef: (body.vehicleRef ?? undefined) as string | undefined,
        plannedDepartureAt: (body.plannedDepartureAt ?? undefined) as string | undefined,
        plannedArrivalAt: (body.plannedArrivalAt ?? undefined) as string | undefined,
        actualDepartureAt: (body.actualDepartureAt ?? undefined) as string | undefined,
        actualArrivalAt: (body.actualArrivalAt ?? undefined) as string | undefined,
        notes: (body.notes ?? undefined) as string | undefined,
        metadata: body.metadata,
      }, actor);
      await emitMutationInvalidation("order_mutation");
      return reply.send({ leg });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post(
    "/:id/legs/:legId/carrier-booking",
    { preHandler: fastifyAuth({ permission: "shipment.bookCarrier" }) },
    async (request, reply) => {
      try {
        const actor = requireOrderActor(request.user);
        const orderId = requireUuid((request.params as any)?.id, "orderId");
        const legId = requireUuid((request.params as any)?.legId, "legId");
        const body = (request.body ?? {}) as Record<string, unknown>;
        const providerId = requireUuid(body.providerId, "providerId");
        await ensureOrderInScope(request, orderId);
        const result = await bookCarrierForOrderLeg({
          orderId,
          legId,
          providerId,
          actor,
        });
        await emitMutationInvalidation("order_mutation");
        return reply.code(202).send(result);
      } catch (err: any) {
        return sendError(reply, err, "Failed to book carrier");
      }
    },
  );

  fastify.post(
    "/:id/legs/:legId/carrier-track-sync",
    { preHandler: fastifyAuth({ permission: "shipment.bookCarrier" }) },
    async (request, reply) => {
      try {
        const actor = requireOrderActor(request.user);
        const orderId = requireUuid((request.params as any)?.id, "orderId");
        const legId = requireUuid((request.params as any)?.legId, "legId");
        await ensureOrderInScope(request, orderId);
        const result = await syncCarrierTrackingForOrderLeg({
          orderId,
          legId,
          actor,
        });
        await emitMutationInvalidation("order_mutation");
        return reply.code(202).send(result);
      } catch (err: any) {
        return sendError(reply, err, "Failed to sync carrier tracking");
      }
    },
  );

  fastify.post(
    "/:id/legs/:legId/carrier-cancel",
    { preHandler: fastifyAuth({ permission: "shipment.bookCarrier" }) },
    async (request, reply) => {
      try {
        const actor = requireOrderActor(request.user);
        const orderId = requireUuid((request.params as any)?.id, "orderId");
        const legId = requireUuid((request.params as any)?.legId, "legId");
        const body = (request.body ?? {}) as Record<string, unknown>;
        await ensureOrderInScope(request, orderId);
        const result = await cancelCarrierForOrderLeg({
          orderId,
          legId,
          reason: typeof body.reason === "string" ? body.reason : null,
          actor,
        });
        await emitMutationInvalidation("order_mutation");
        return reply.code(202).send(result);
      } catch (err: any) {
        return sendError(reply, err, "Failed to cancel carrier booking");
      }
    },
  );

  fastify.get("/:id/pricing-components", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const items = await listPricingComponents(orderId);
      return reply.send({ items });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.post("/:id/pricing-components", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    try {
      const actor = requireOrderActor(request.user);
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const item = await createPricingComponent(orderId, {
        orderLegId: (body.orderLegId ?? undefined) as string | undefined,
        componentType: asEnumValue(body.componentType, Object.values(PricingComponentType), "componentType") as PricingComponentType,
        source: asEnumValue(body.source, Object.values(PricingComponentSource), "source") as PricingComponentSource | undefined,
        description: (body.description ?? undefined) as string | undefined,
        amount: parseNumber(body.amount, "amount", true)!,
        currency: String(body.currency ?? "").trim(),
        fxRateSnapshot: parseNumber(body.fxRateSnapshot, "fxRateSnapshot"),
        baseCurrency: body.baseCurrency != null ? String(body.baseCurrency).trim() : undefined,
        baseAmount: parseNumber(body.baseAmount, "baseAmount"),
        referenceKey: (body.referenceKey ?? undefined) as string | undefined,
      }, actor);
      await emitMutationInvalidation("order_mutation");
      return reply.code(201).send({ item });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });

  fastify.get("/:id/documents", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (request, reply) => {
    try {
      const orderId = String((request.params as any)?.id ?? "").trim();
      await ensureOrderInScope(request, orderId);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const type = asEnumValue(query.type, Object.values(OrderDocumentType), "type") as OrderDocumentType | undefined;
      const limit = parseNumber(query.limit, "limit");
      const items = await listOrderDocuments(orderId, { type: type ?? null, limit: limit ?? undefined });
      return reply.send({ items });
    } catch (err: any) {
      return sendError(reply, err, "Failed");
    }
  });
};

export default legsPricingRoutes;
