"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const identity_access_1 = require("../../identity-access");
const trackingRepo_1 = require("../application/trackingRepo");
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
const trackingFastifyRoutes = async (fastify) => {
    fastify.get("/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const orderId = String(request.params?.id ?? "").trim();
            if (!isUuid(orderId)) {
                return reply.code(400).send({ error: "Invalid orderId" });
            }
            const scopeWhere = (await (0, identity_access_1.buildOrderScopeWhere)(request.user)) ?? {
                id: "__no_access__",
            };
            const order = await prismaClient_1.default.order.findFirst({
                where: {
                    AND: [{ id: orderId }, scopeWhere],
                },
                select: { id: true },
            });
            if (!order)
                return reply.code(404).send({ error: "Order not found" });
            const tracking = await (0, trackingRepo_1.getTrackingByOrderId)(orderId);
            return reply.send(tracking);
        }
        catch (err) {
            return reply.code(err?.statusCode ?? 500).send({
                error: err?.message || "Server error",
            });
        }
    });
};
exports.default = trackingFastifyRoutes;
