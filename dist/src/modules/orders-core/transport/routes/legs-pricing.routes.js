"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const fastify_auth_1 = require("../../../identity-access/transport/fastify-auth");
const __1 = require("../..");
const orders_legs_1 = require("../../../orders-legs");
const shared_1 = require("../shared");
function requireUuid(value, fieldName) {
    const normalized = String(value || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
        const error = new Error(`${fieldName} must be a valid UUID`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}
const legsPricingRoutes = async (fastify) => {
    fastify.get("/:id/legs", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id ?? "").trim();
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const legs = await (0, orders_legs_1.listOrderLegs)(orderId);
            return reply.send({ legs });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.post("/:id/legs", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = String(request.params?.id ?? "").trim();
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const body = (request.body ?? {});
            const leg = await (0, orders_legs_1.upsertOrderLeg)(orderId, {
                legId: (request.params?.legId ?? body.legId ?? null),
                sequence: (0, shared_1.parseNumber)(body.sequence, "sequence"),
                mode: (0, shared_1.asEnumValue)(body.mode, Object.values(client_1.TransportMode), "mode"),
                status: (0, shared_1.asEnumValue)(body.status, Object.values(client_1.OrderLegStatus), "status"),
                fromCountry: (body.fromCountry ?? undefined),
                toCountry: (body.toCountry ?? undefined),
                transitRoute: body.transitRoute,
                fromWarehouseId: (body.fromWarehouseId ?? undefined),
                toWarehouseId: (body.toWarehouseId ?? undefined),
                carrierCode: (body.carrierCode ?? undefined),
                carrierRef: (body.carrierRef ?? undefined),
                vehicleRef: (body.vehicleRef ?? undefined),
                plannedDepartureAt: (body.plannedDepartureAt ?? undefined),
                plannedArrivalAt: (body.plannedArrivalAt ?? undefined),
                actualDepartureAt: (body.actualDepartureAt ?? undefined),
                actualArrivalAt: (body.actualArrivalAt ?? undefined),
                notes: (body.notes ?? undefined),
                metadata: body.metadata,
            }, actor);
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.send({ leg });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.put("/:id/legs/:legId", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = String(request.params?.id ?? "").trim();
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const body = (request.body ?? {});
            const leg = await (0, orders_legs_1.upsertOrderLeg)(orderId, {
                legId: String(request.params?.legId ?? "").trim() || null,
                sequence: (0, shared_1.parseNumber)(body.sequence, "sequence"),
                mode: (0, shared_1.asEnumValue)(body.mode, Object.values(client_1.TransportMode), "mode"),
                status: (0, shared_1.asEnumValue)(body.status, Object.values(client_1.OrderLegStatus), "status"),
                fromCountry: (body.fromCountry ?? undefined),
                toCountry: (body.toCountry ?? undefined),
                transitRoute: body.transitRoute,
                fromWarehouseId: (body.fromWarehouseId ?? undefined),
                toWarehouseId: (body.toWarehouseId ?? undefined),
                carrierCode: (body.carrierCode ?? undefined),
                carrierRef: (body.carrierRef ?? undefined),
                vehicleRef: (body.vehicleRef ?? undefined),
                plannedDepartureAt: (body.plannedDepartureAt ?? undefined),
                plannedArrivalAt: (body.plannedArrivalAt ?? undefined),
                actualDepartureAt: (body.actualDepartureAt ?? undefined),
                actualArrivalAt: (body.actualArrivalAt ?? undefined),
                notes: (body.notes ?? undefined),
                metadata: body.metadata,
            }, actor);
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.send({ leg });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.post("/:id/legs/:legId/carrier-booking", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.bookCarrier" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = requireUuid(request.params?.id, "orderId");
            const legId = requireUuid(request.params?.legId, "legId");
            const body = (request.body ?? {});
            const providerId = requireUuid(body.providerId, "providerId");
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const result = await (0, orders_legs_1.bookCarrierForOrderLeg)({
                orderId,
                legId,
                providerId,
                actor,
            });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.code(202).send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to book carrier");
        }
    });
    fastify.post("/:id/legs/:legId/carrier-track-sync", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.bookCarrier" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = requireUuid(request.params?.id, "orderId");
            const legId = requireUuid(request.params?.legId, "legId");
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const result = await (0, orders_legs_1.syncCarrierTrackingForOrderLeg)({
                orderId,
                legId,
                actor,
            });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.code(202).send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to sync carrier tracking");
        }
    });
    fastify.post("/:id/legs/:legId/carrier-cancel", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.bookCarrier" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = requireUuid(request.params?.id, "orderId");
            const legId = requireUuid(request.params?.legId, "legId");
            const body = (request.body ?? {});
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const result = await (0, orders_legs_1.cancelCarrierForOrderLeg)({
                orderId,
                legId,
                reason: typeof body.reason === "string" ? body.reason : null,
                actor,
            });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.code(202).send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to cancel carrier booking");
        }
    });
    fastify.get("/:id/pricing-components", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id ?? "").trim();
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const items = await (0, orders_legs_1.listPricingComponents)(orderId);
            return reply.send({ items });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.post("/:id/pricing-components", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const orderId = String(request.params?.id ?? "").trim();
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const body = (request.body ?? {});
            const item = await (0, orders_legs_1.createPricingComponent)(orderId, {
                orderLegId: (body.orderLegId ?? undefined),
                componentType: (0, shared_1.asEnumValue)(body.componentType, Object.values(client_1.PricingComponentType), "componentType"),
                source: (0, shared_1.asEnumValue)(body.source, Object.values(client_1.PricingComponentSource), "source"),
                description: (body.description ?? undefined),
                amount: (0, shared_1.parseNumber)(body.amount, "amount", true),
                currency: String(body.currency ?? "").trim(),
                fxRateSnapshot: (0, shared_1.parseNumber)(body.fxRateSnapshot, "fxRateSnapshot"),
                baseCurrency: body.baseCurrency != null ? String(body.baseCurrency).trim() : undefined,
                baseAmount: (0, shared_1.parseNumber)(body.baseAmount, "baseAmount"),
                referenceKey: (body.referenceKey ?? undefined),
            }, actor);
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.code(201).send({ item });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.get("/:id/documents", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id ?? "").trim();
            await (0, shared_1.ensureOrderInScope)(request, orderId);
            const query = (request.query ?? {});
            const type = (0, shared_1.asEnumValue)(query.type, Object.values(client_1.OrderDocumentType), "type");
            const limit = (0, shared_1.parseNumber)(query.limit, "limit");
            const items = await (0, orders_legs_1.listOrderDocuments)(orderId, { type: type ?? null, limit: limit ?? undefined });
            return reply.send({ items });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
};
exports.default = legsPricingRoutes;
