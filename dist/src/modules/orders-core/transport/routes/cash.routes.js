"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_auth_1 = require("../../../identity-access/transport/fastify-auth");
const __1 = require("../..");
const shared_1 = require("../shared");
const cashRoutes = async (fastify) => {
    fastify.post("/cash/collect-bulk", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.collectCashBulkForActor)({ actor, body: (request.body ?? {}) });
            await (0, shared_1.emitMutationInvalidation)("cash_mutation");
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to collect cash in bulk");
        }
    });
    fastify.post("/cash/handoff-bulk", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.handoffCashBulkForActor)({ actor, body: (request.body ?? {}) });
            await (0, shared_1.emitMutationInvalidation)("cash_mutation");
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to hand off cash in bulk");
        }
    });
    fastify.post("/cash/settle-bulk", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "finance.settleCash" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.settleCashBulkForActor)({ actor, body: (request.body ?? {}) });
            await (0, shared_1.emitMutationInvalidation)("cash_mutation");
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to settle cash in bulk");
        }
    });
    fastify.get("/cash/queue", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const data = await (0, __1.listCashQueueForActorView)({ actor, query: (request.query ?? {}) });
            return reply.send(data);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to load cash queue");
        }
    });
    fastify.get("/cash/queue-summary", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const summary = await (0, __1.getCashQueueSummaryForActorView)({ actor, query: (request.query ?? {}) });
            return reply.send(summary);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to load cash queue summary");
        }
    });
    fastify.post("/:id/cash/collect", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.collectCashForActor)({
                actor,
                orderId: String(request.params?.id ?? "").trim(),
                body: (request.body ?? {}),
            });
            await (0, shared_1.emitMutationInvalidation)("cash_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to collect cash");
        }
    });
    fastify.post("/:id/cash/handoff", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.handoffCashForActor)({
                actor,
                orderId: String(request.params?.id ?? "").trim(),
                body: (request.body ?? {}),
            });
            await (0, shared_1.emitMutationInvalidation)("cash_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to hand off cash");
        }
    });
    fastify.post("/:id/cash/settle", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "finance.settleCash" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.settleCashForActor)({
                actor,
                orderId: String(request.params?.id ?? "").trim(),
                body: (request.body ?? {}),
            });
            await (0, shared_1.emitMutationInvalidation)("cash_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to settle cash");
        }
    });
};
exports.default = cashRoutes;
