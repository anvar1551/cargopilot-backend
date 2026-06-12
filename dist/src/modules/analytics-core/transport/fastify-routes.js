"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const analyticsV2_1 = require("../application/analyticsV2");
const analyticsV2Realtime_1 = require("../realtime/analyticsV2Realtime");
const analyticsEvents_1 = require("../realtime/analyticsEvents");
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const opsMetrics_1 = require("../../../modules/observability-core/application/opsMetrics");
const analyticsConfig_1 = require("../config/analyticsConfig");
const sseHeaders_1 = require("../../../shared/http/sseHeaders");
function isWritableStream(stream) {
    return !stream.destroyed && stream.writable !== false;
}
function asStringArray(value) {
    if (!value)
        return [];
    if (Array.isArray(value)) {
        return value
            .flatMap((entry) => String(entry ?? "").split(","))
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return String(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function parseDateStart(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const raw = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}T00:00:00.000Z`);
        return Number.isNaN(date.getTime()) ? undefined : date;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
}
function parseDateEndExclusive(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const raw = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime()))
            return undefined;
        date.setUTCDate(date.getUTCDate() + 1);
        return date;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime()))
        return undefined;
    return date;
}
function getScope(request) {
    const permissionCodes = Array.isArray(request.user?.permissionCodes)
        ? request.user.permissionCodes
        : [];
    const roleCodes = Array.isArray(request.user?.roleCodes)
        ? request.user.roleCodes.map((value) => String(value || "").toLowerCase())
        : [];
    const isManagerScope = permissionCodes.includes("drivers.manage") ||
        roleCodes.includes("manager") ||
        roleCodes.includes("admin") ||
        roleCodes.includes("super_admin") ||
        roleCodes.includes("owner");
    return {
        role: isManagerScope ? "manager" : request.user?.warehouseId ? "warehouse" : "global",
        warehouseId: request.user?.warehouseId ?? null,
        userId: request.user?.id ?? null,
    };
}
const analyticsFastifyRoutes = async (fastify) => {
    fastify.get("/summary", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            const rangeDays = Number(request.query?.rangeDays);
            const staleHours = Number(request.query?.staleHours);
            const result = await (0, analyticsV2_1.getAnalyticsSummaryV2)({
                rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
                staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
                scope: getScope(request),
            });
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({ endpoint: "analytics.summary", cacheHit: result.cacheHit, durationMs });
            return reply.send(result.payload);
        }
        catch (err) {
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({
                endpoint: "analytics.summary",
                cacheHit: false,
                durationMs,
                isError: true,
            });
            return reply.code(500).send({ error: err?.message || "Failed to load summary" });
        }
    });
    fastify.get("/trend", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            const rangeDays = Number(request.query?.rangeDays);
            const result = await (0, analyticsV2_1.getAnalyticsTrendV2)({
                rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
                scope: getScope(request),
            });
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({ endpoint: "analytics.trend", cacheHit: result.cacheHit, durationMs });
            return reply.send(result.payload);
        }
        catch (err) {
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({ endpoint: "analytics.trend", cacheHit: false, durationMs, isError: true });
            return reply.code(500).send({ error: err?.message || "Failed to load trend" });
        }
    });
    fastify.get("/warnings", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            const rangeDays = Number(request.query?.rangeDays);
            const staleHours = Number(request.query?.staleHours);
            const result = await (0, analyticsV2_1.getAnalyticsWarningsV2)({
                rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
                staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
                scope: getScope(request),
            });
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({ endpoint: "analytics.warnings", cacheHit: result.cacheHit, durationMs });
            return reply.send(result.payload);
        }
        catch (err) {
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({ endpoint: "analytics.warnings", cacheHit: false, durationMs, isError: true });
            return reply.code(500).send({ error: err?.message || "Failed to load warnings" });
        }
    });
    fastify.get("/finance-queue", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            const query = request.query;
            const queuePage = Number(query.queuePage);
            const queuePageSize = Number(query.queuePageSize);
            const queueStatuses = asStringArray(query.queueStatuses).sort();
            const queueKinds = asStringArray(query.queueKinds).sort();
            const queueHolderTypes = asStringArray(query.queueHolderTypes).sort();
            const result = await (0, analyticsV2_1.getAnalyticsFinanceQueueV2)({
                queuePage: Number.isFinite(queuePage) ? queuePage : undefined,
                queuePageSize: Number.isFinite(queuePageSize) ? queuePageSize : undefined,
                queueFrom: parseDateStart(query.queueFrom),
                queueTo: parseDateEndExclusive(query.queueTo),
                queueStatuses,
                queueKinds,
                queueHolderTypes,
                scope: getScope(request),
            });
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({ endpoint: "analytics.finance-queue", cacheHit: result.cacheHit, durationMs });
            return reply.send(result.payload);
        }
        catch (err) {
            const durationMs = Date.now() - startedAt;
            reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
            (0, opsMetrics_1.recordAnalyticsRequest)({ endpoint: "analytics.finance-queue", cacheHit: false, durationMs, isError: true });
            return reply.code(500).send({ error: err?.message || "Failed to load finance queue" });
        }
    });
    fastify.post("/refresh", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.update" }) }, async (_request, reply) => {
        try {
            await (0, analyticsV2Realtime_1.publishAnalyticsInvalidation)("manual_refresh");
            await (0, analyticsEvents_1.publishCargoPilotDomainEvent)({
                type: "manual_refresh",
                tenantScope: "role:manager",
                entityId: null,
                payload: { source: "manager.analytics.refresh" },
            });
            return reply.send({ ok: true });
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to refresh analytics" });
        }
    });
    fastify.get("/stream", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "shipment.view" }) }, async (request, reply) => {
        (0, sseHeaders_1.applySseHeaders)(request, reply);
        reply.raw.flushHeaders?.();
        const clientKey = `${request.user?.id || "anon"}:${request.ip || "ip"}`;
        const lastEventId = String(request.headers["last-event-id"] || request.headers["Last-Event-ID"] || "").trim();
        (0, opsMetrics_1.recordSseConnected)({ stream: "analytics", clientKey });
        let closed = false;
        let disconnected = false;
        const send = (event, payload, id) => {
            if (closed || !isWritableStream(reply.raw))
                return false;
            try {
                if (id)
                    reply.raw.write(`id: ${id}\n`);
                reply.raw.write(`event: ${event}\n`);
                reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
                return true;
            }
            catch {
                return false;
            }
        };
        if (!send("ready", { connectedAt: new Date().toISOString(), resumedFrom: lastEventId || null })) {
            (0, opsMetrics_1.recordSseDisconnected)("analytics");
            return reply.hijack();
        }
        const redisReplayEvents = await (0, analyticsV2Realtime_1.replayAnalyticsInvalidationFromRedis)({
            lastEventId,
            limit: analyticsConfig_1.analyticsConfig.stream.replayMaxEvents,
        });
        const replayEvents = redisReplayEvents.length
            ? redisReplayEvents
            : (0, analyticsV2Realtime_1.replayAnalyticsInvalidationSince)(lastEventId);
        const replayLimit = analyticsConfig_1.analyticsConfig.stream.replayMaxEvents;
        const replaySlice = replayEvents.slice(-replayLimit);
        replaySlice.forEach((event) => {
            send("analytics-refresh", {
                at: event.at,
                reason: event.reason,
                scope: event.scope,
                keys: event.keys,
                source: event.source || "api",
            }, event.id);
        });
        if (replayEvents.length > replaySlice.length) {
            send("analytics-replay-truncated", {
                skipped: replayEvents.length - replaySlice.length,
                delivered: replaySlice.length,
            });
        }
        const heartbeatMs = analyticsConfig_1.analyticsConfig.stream.heartbeatMs;
        const refreshEveryMs = analyticsConfig_1.analyticsConfig.stream.refreshMs;
        const heartbeat = setInterval(() => {
            if (closed || !isWritableStream(reply.raw))
                return;
            try {
                reply.raw.write(`: ping ${Date.now()}\n\n`);
            }
            catch {
                closed = true;
            }
        }, heartbeatMs);
        const scheduledRefresh = refreshEveryMs > 0
            ? setInterval(() => {
                send("analytics-refresh", {
                    at: new Date().toISOString(),
                    reason: "scheduled",
                    scope: "global",
                    keys: ["summary", "trend"],
                    source: "api",
                });
            }, refreshEveryMs)
            : null;
        const unsubscribe = (0, analyticsV2Realtime_1.subscribeAnalyticsInvalidation)((event) => {
            const sent = send("analytics-refresh", {
                at: event.at,
                reason: event.reason,
                scope: event.scope,
                keys: event.keys,
                source: event.source || "api",
            }, event.id);
            if (!sent)
                closed = true;
        });
        const onClose = () => {
            if (disconnected)
                return;
            disconnected = true;
            closed = true;
            (0, opsMetrics_1.recordSseDisconnected)("analytics");
            clearInterval(heartbeat);
            if (scheduledRefresh)
                clearInterval(scheduledRefresh);
            unsubscribe();
        };
        request.raw.on("close", onClose);
        reply.raw.on("close", onClose);
        reply.raw.on("error", onClose);
        return reply.hijack();
    });
};
exports.default = analyticsFastifyRoutes;
