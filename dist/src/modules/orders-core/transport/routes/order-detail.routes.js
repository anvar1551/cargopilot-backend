"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_auth_1 = require("../../../identity-access/transport/fastify-auth");
const __1 = require("../..");
const shared_1 = require("../shared");
const orderDetailRoutes = async (fastify) => {
    fastify.get("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const orderId = String(request.params?.id ?? "").trim();
            const result = await (0, __1.getOrderForActor)({ actor, orderId });
            if (result.status === 200)
                return reply.send(result.order);
            if (result.status === 404)
                return reply.code(404).send({ error: "Not found" });
            return reply.code(403).send({ error: "Forbidden" });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to fetch order");
        }
    });
    fastify.delete("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.delete" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const orderId = String(request.params?.id ?? "").trim();
            const result = await (0, __1.deleteOrderForActor)({ actor, orderId });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to delete order");
        }
    });
};
exports.default = orderDetailRoutes;
