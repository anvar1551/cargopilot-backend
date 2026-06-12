"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = require("../../../config/redis");
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const opsMetrics_1 = require("../../../modules/observability-core/application/opsMetrics");
const managerController_1 = require("../application/managerController");
const managerFastifyRoutes = async (fastify) => {
    fastify.get("/overview", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        try {
            const result = await (0, managerController_1.getManagerOverviewPayload)({
                actor: {
                    id: request.user?.id ?? null,
                    roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
                    permissionCodes: Array.isArray(request.user?.permissionCodes)
                        ? request.user.permissionCodes
                        : [],
                    warehouseId: request.user?.warehouseId ?? null,
                },
            });
            reply.header("X-Overview-Cache", result.cache);
            reply.header("Cache-Control", `private, max-age=${Math.floor(result.ttlMs / 1000)}`);
            return reply.send(result.payload);
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to load overview" });
        }
    });
    fastify.get("/ops/metrics", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (_request, reply) => {
        try {
            const snapshot = (0, opsMetrics_1.getOpsMetricsSnapshot)();
            const redis = await (0, redis_1.getRedisHealthSnapshot)();
            return reply.send({
                ...snapshot,
                redis,
            });
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to load ops metrics" });
        }
    });
    fastify.get("/drivers", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "drivers.read" }) }, async (request, reply) => {
        try {
            const result = await (0, managerController_1.listDriversPayload)({
                actor: {
                    id: request.user?.id ?? null,
                    roleCodes: Array.isArray(request.user?.roleCodes) ? request.user.roleCodes : [],
                    permissionCodes: Array.isArray(request.user?.permissionCodes)
                        ? request.user.permissionCodes
                        : [],
                    warehouseId: request.user?.warehouseId ?? null,
                },
            });
            reply.header("X-Drivers-Cache", result.cache);
            reply.header("Cache-Control", `private, max-age=${Math.floor(result.ttlMs / 1000)}`);
            return reply.send(result.payload);
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to load drivers" });
        }
    });
};
exports.default = managerFastifyRoutes;
