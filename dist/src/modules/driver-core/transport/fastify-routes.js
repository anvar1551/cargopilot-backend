"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const authFastify_1 = require("../../../middleware/authFastify");
const identity_access_1 = require("../../identity-access");
const liveMapService_1 = require("../../live-map-core/application/liveMapService");
const driverProfileService_1 = require("../application/driverProfileService");
function liveMapActorFromRequest(request) {
    const role = request.user?.role;
    const warehouseId = request.user?.warehouseId ?? null;
    const userId = request.user?.id;
    if (!role || !userId)
        return null;
    return { role, warehouseId, userId };
}
function sendLiveMapActionError(reply, err, fallbackMessage) {
    if (err instanceof zod_1.ZodError) {
        return reply.code(400).send({
            error: "Invalid payload",
            issues: err.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
            })),
        });
    }
    if (typeof err?.message === "string" && err.message.includes("different driver")) {
        return reply.code(403).send({ error: err.message });
    }
    if (typeof err?.message === "string" && err.message.includes("required for manager")) {
        return reply.code(400).send({ error: err.message });
    }
    if (typeof err?.message === "string" && err.message.includes("not found")) {
        return reply.code(404).send({ error: err.message });
    }
    return reply.code(400).send({ error: err?.message || fallbackMessage });
}
const driverFastifyRoutes = async (fastify) => {
    fastify.get("/", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "drivers.manage" }) }, async (request, reply) => {
        try {
            const drivers = await (0, driverProfileService_1.listDriversView)();
            return reply.send(drivers);
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to fetch drivers" });
        }
    });
    fastify.put("/:id", { preHandler: (0, authFastify_1.fastifyAuth)({ permission: "drivers.manage" }) }, async (request, reply) => {
        try {
            const payload = await (0, driverProfileService_1.updateDriverProfileById)(String(request.params?.id || ""), request.body ?? {});
            return reply.send(payload);
        }
        catch (err) {
            if (err instanceof zod_1.ZodError) {
                return reply.code(400).send({
                    error: "Invalid payload",
                    issues: err.issues,
                });
            }
            return reply.code(err?.statusCode ?? 500).send({
                error: err?.message || "Failed to update driver profile",
            });
        }
    });
    fastify.post("/location", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        const actor = liveMapActorFromRequest(request);
        if (!actor)
            return reply.code(401).send({ error: "Unauthorized" });
        const [canTelemetry, canManage] = await Promise.all([
            (0, identity_access_1.hasPermission)(request.user, "drivers.telemetry"),
            (0, identity_access_1.hasPermission)(request.user, "drivers.manage"),
        ]);
        if (!canTelemetry && !canManage)
            return reply.code(403).send({ error: "Forbidden" });
        try {
            const result = await (0, liveMapService_1.ingestDriverLocation)({ actor, body: request.body });
            return reply.send(result);
        }
        catch (err) {
            return sendLiveMapActionError(reply, err, "Failed to ingest driver location");
        }
    });
    fastify.get("/presence", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        const actor = liveMapActorFromRequest(request);
        if (!actor)
            return reply.code(401).send({ error: "Unauthorized" });
        const [canTelemetry, canManage] = await Promise.all([
            (0, identity_access_1.hasPermission)(request.user, "drivers.telemetry"),
            (0, identity_access_1.hasPermission)(request.user, "drivers.manage"),
        ]);
        if (!canTelemetry && !canManage)
            return reply.code(403).send({ error: "Forbidden" });
        try {
            const result = await (0, liveMapService_1.getDriverPresence)({ actor, query: request.query });
            return reply.send(result);
        }
        catch (err) {
            return sendLiveMapActionError(reply, err, "Failed to fetch driver presence");
        }
    });
    fastify.put("/presence", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        const actor = liveMapActorFromRequest(request);
        if (!actor)
            return reply.code(401).send({ error: "Unauthorized" });
        const [canTelemetry, canManage] = await Promise.all([
            (0, identity_access_1.hasPermission)(request.user, "drivers.telemetry"),
            (0, identity_access_1.hasPermission)(request.user, "drivers.manage"),
        ]);
        if (!canTelemetry && !canManage)
            return reply.code(403).send({ error: "Forbidden" });
        try {
            const result = await (0, liveMapService_1.setDriverPresence)({ actor, body: request.body });
            return reply.send(result);
        }
        catch (err) {
            return sendLiveMapActionError(reply, err, "Failed to update driver presence");
        }
    });
    fastify.post("/presence/heartbeat", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        const actor = liveMapActorFromRequest(request);
        if (!actor)
            return reply.code(401).send({ error: "Unauthorized" });
        const [canTelemetry, canManage] = await Promise.all([
            (0, identity_access_1.hasPermission)(request.user, "drivers.telemetry"),
            (0, identity_access_1.hasPermission)(request.user, "drivers.manage"),
        ]);
        if (!canTelemetry && !canManage)
            return reply.code(403).send({ error: "Forbidden" });
        try {
            const result = await (0, liveMapService_1.heartbeatDriverPresence)({ actor, body: request.body });
            return reply.send(result);
        }
        catch (err) {
            return sendLiveMapActionError(reply, err, "Failed to heartbeat driver presence");
        }
    });
};
exports.default = driverFastifyRoutes;
