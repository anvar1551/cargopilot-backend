"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_auth_1 = require("../../../identity-access/transport/fastify-auth");
const __1 = require("../..");
const shared_1 = require("../shared");
const ordersRoutes = async (fastify) => {
    fastify.post("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.create" }) }, async (request, reply) => {
        try {
            const result = await (0, __1.createOrderForActor)({ user: request.user, body: request.body });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to create order");
        }
    });
    fastify.get("/", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const result = await (0, __1.listOrdersForActor)({ actor, query: (request.query ?? {}) });
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to list orders");
        }
    });
    fastify.get("/export.csv", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.export" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const result = await (0, __1.exportOrdersCsvForActor)({ actor, query: (request.query ?? {}) });
            reply.header("Content-Type", "text/csv; charset=utf-8");
            reply.header("Content-Disposition", `attachment; filename=\"${result.filename}\"`);
            return reply.code(200).send(result.csv);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to export CSV");
        }
    });
    fastify.get("/driver-workloads", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const actor = request.user;
            const workloads = await (0, __1.listDriverWorkloadForActor)(actor);
            return reply.send({ workloads });
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to fetch workloads");
        }
    });
    fastify.post("/assign-driver-bulk", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.assignCourier" }) }, async (request, reply) => {
        try {
            const includeFull = request.query?.include === "full";
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.assignDriversBulkForActor)({ actor, body: (request.body ?? {}), includeFull });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.post("/tasks/assign-bulk", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.assignCourier" }) }, async (request, reply) => {
        try {
            const includeFull = request.query?.include === "full";
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.assignTasksBulkForActor)({ actor, body: (request.body ?? {}), includeFull });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.post("/status-bulk", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.changeStatus" }) }, async (request, reply) => {
        try {
            const includeFull = request.query?.include === "full";
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.updateStatusBulkForActor)({ actor, body: (request.body ?? {}), includeFull });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
    fastify.post("/driver-status", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.changeStatus" }) }, async (request, reply) => {
        try {
            const actor = (0, __1.requireOrderActor)(request.user);
            const result = await (0, __1.updateDriverStatusForActor)({ actor, body: (request.body ?? {}) });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed");
        }
    });
};
exports.default = ordersRoutes;
