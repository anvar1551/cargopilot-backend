"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const v4_1 = require("zod/v4");
const fastify_auth_1 = require("../../../identity-access/transport/fastify-auth");
const __1 = require("../..");
const shared_1 = require("../shared");
function enumSchema(enumObj) {
    return v4_1.z.enum(Object.values(enumObj));
}
const orderCreateBodySchema = v4_1.z.record(v4_1.z.string(), v4_1.z.unknown());
const orderListQuerySchema = v4_1.z.object({
    q: v4_1.z.string().optional(),
    page: v4_1.z.coerce.number().int().positive().optional(),
    limit: v4_1.z.coerce.number().int().positive().max(500).optional(),
    cursor: v4_1.z.string().optional(),
    mode: v4_1.z.enum(["page", "cursor"]).optional(),
    scope: v4_1.z.enum(["fast", "deep"]).optional(),
    statuses: v4_1.z.union([v4_1.z.string(), v4_1.z.array(v4_1.z.string())]).optional(),
    createdFrom: v4_1.z.string().optional(),
    createdTo: v4_1.z.string().optional(),
    customerQuery: v4_1.z.string().optional(),
    assignedDriverId: v4_1.z.string().optional(),
    warehouseId: v4_1.z.string().optional(),
    region: v4_1.z.string().optional(),
});
const includeQuerySchema = v4_1.z.object({
    include: v4_1.z.enum(["full"]).optional(),
});
const bulkOrderIdsSchema = v4_1.z.union([
    v4_1.z.array(v4_1.z.string().trim().min(1)).min(1),
    v4_1.z.string().trim().min(1),
]);
const assignTasksBulkBodySchema = v4_1.z.object({
    driverId: v4_1.z.string().trim().min(1),
    type: v4_1.z.enum(["pickup", "delivery", "linehaul"]).optional(),
    warehouseId: v4_1.z.string().trim().nullable().optional(),
    note: v4_1.z.string().nullable().optional(),
    region: v4_1.z.string().nullable().optional(),
    orderIds: bulkOrderIdsSchema,
});
const statusBulkBodySchema = v4_1.z.object({
    status: enumSchema(client_1.OrderStatus),
    reasonCode: enumSchema(client_1.ReasonCode).nullable().optional(),
    warehouseId: v4_1.z.string().trim().nullable().optional(),
    note: v4_1.z.string().nullable().optional(),
    region: v4_1.z.string().nullable().optional(),
    orderIds: bulkOrderIdsSchema,
});
const driverStatusBodySchema = v4_1.z.object({
    orderId: v4_1.z.string().trim().min(1),
    status: enumSchema(client_1.OrderStatus),
    reasonCode: enumSchema(client_1.ReasonCode).nullable().optional(),
    note: v4_1.z.string().nullable().optional(),
    region: v4_1.z.string().nullable().optional(),
});
const ordersRoutes = async (fastify) => {
    fastify.post("/", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.create" }),
        schema: { body: orderCreateBodySchema },
    }, async (request, reply) => {
        try {
            const result = await (0, __1.createOrderForActor)({ user: request.user, body: request.body });
            await (0, shared_1.emitMutationInvalidation)("order_mutation");
            return reply.code(result.statusCode).send(result.payload);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to create order");
        }
    });
    fastify.get("/", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }),
        schema: { querystring: orderListQuerySchema },
    }, async (request, reply) => {
        try {
            const actor = request.user;
            const result = await (0, __1.listOrdersForActor)({ actor, query: (request.query ?? {}) });
            return reply.send(result);
        }
        catch (err) {
            return (0, shared_1.sendError)(reply, err, "Failed to list orders");
        }
    });
    fastify.get("/export.csv", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.export" }),
        schema: { querystring: orderListQuerySchema },
    }, async (request, reply) => {
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
    fastify.post("/assign-driver-bulk", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.assignCourier" }),
        schema: { querystring: includeQuerySchema, body: assignTasksBulkBodySchema },
    }, async (request, reply) => {
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
    fastify.post("/tasks/assign-bulk", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.assignCourier" }),
        schema: { querystring: includeQuerySchema, body: assignTasksBulkBodySchema },
    }, async (request, reply) => {
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
    fastify.post("/status-bulk", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.changeStatus" }),
        schema: { querystring: includeQuerySchema, body: statusBulkBodySchema },
    }, async (request, reply) => {
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
    fastify.post("/driver-status", {
        preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.changeStatus" }),
        schema: { body: driverStatusBodySchema },
    }, async (request, reply) => {
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
