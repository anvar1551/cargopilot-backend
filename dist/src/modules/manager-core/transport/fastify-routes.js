"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authFastify_1 = require("../../../middleware/authFastify");
const opsMetrics_1 = require("../../../features/observability/opsMetrics");
const managerController_1 = require("../application/managerController");
const managerFastifyRoutes = async (fastify) => {
    fastify.get("/overview", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (request, reply) => {
        try {
            const result = await (0, managerController_1.getManagerOverviewPayload)({
                actor: {
                    id: request.user?.id ?? null,
                    role: request.user?.role ?? null,
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
    fastify.get("/ops/metrics", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "orders.read" }) }, async (_request, reply) => {
        try {
            const snapshot = (0, opsMetrics_1.getOpsMetricsSnapshot)();
            return reply.send(snapshot);
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to load ops metrics" });
        }
    });
    fastify.get("/drivers", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "drivers.read" }) }, async (request, reply) => {
        try {
            const result = await (0, managerController_1.listDriversPayload)({
                actor: {
                    id: request.user?.id ?? null,
                    role: request.user?.role ?? null,
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
