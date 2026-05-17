"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const redis_1 = require("../../../config/redis");
const authFastify_1 = require("../../../middleware/authFastify");
const identity_access_1 = require("../../identity-access");
const liveMapStore_1 = require("../infrastructure/liveMapStore");
const liveMapService_1 = require("../application/liveMapService");
const opsMetrics_1 = require("../../../modules/observability-core/application/opsMetrics");
const snapshotCache = new Map();
const snapshotBuilds = new Map();
const snapshotGc = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of snapshotCache.entries()) {
        if (now >= entry.staleUntil)
            snapshotCache.delete(key);
    }
}, 60000);
snapshotGc.unref();
function parseViewport(raw) {
    const minLat = Number(raw.minLat);
    const minLng = Number(raw.minLng);
    const maxLat = Number(raw.maxLat);
    const maxLng = Number(raw.maxLng);
    const values = [minLat, minLng, maxLat, maxLng];
    if (values.some((value) => !Number.isFinite(value)))
        return null;
    if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180)
        return null;
    if (minLat >= maxLat || minLng >= maxLng)
        return null;
    return { minLat, minLng, maxLat, maxLng };
}
function isInViewport(lat, lng, viewport) {
    if (!viewport)
        return true;
    return (lat >= viewport.minLat &&
        lat <= viewport.maxLat &&
        lng >= viewport.minLng &&
        lng <= viewport.maxLng);
}
function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        promise
            .then((value) => {
            clearTimeout(timer);
            resolve(value);
        })
            .catch((err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
function actorFromRequest(request) {
    const role = request.user?.role;
    const warehouseId = request.user?.warehouseId ?? null;
    const userId = request.user?.id;
    if (!role || !userId)
        return null;
    return { role, warehouseId, userId };
}
function getScopeKey(role, warehouseId) {
    return `${role}:${warehouseId ?? "all"}`;
}
function toViewportBucketKey(viewport) {
    if (!viewport)
        return "all";
    const precision = Math.max(0, Number(process.env.LIVE_MAP_VIEWPORT_CACHE_DECIMALS || 2));
    return [
        viewport.minLat.toFixed(precision),
        viewport.minLng.toFixed(precision),
        viewport.maxLat.toFixed(precision),
        viewport.maxLng.toFixed(precision),
    ].join(",");
}
function getSnapshotCacheKey(role, warehouseId, viewport) {
    return `${getScopeKey(role, warehouseId)}:${toViewportBucketKey(viewport)}`;
}
function getSnapshotRedisKey(cacheKey) {
    const digest = (0, crypto_1.createHash)("sha1").update(cacheKey).digest("hex");
    return `${(0, redis_1.getRedisPrefix)()}:live-map:snapshot:${digest}`;
}
async function readSnapshotCache(cacheKey) {
    const memoryHit = snapshotCache.get(cacheKey);
    if (memoryHit && Date.now() < memoryHit.staleUntil) {
        return {
            payload: {
                ...memoryHit.payload,
                isStale: Date.now() >= memoryHit.expiresAt,
            },
            isFresh: Date.now() < memoryHit.expiresAt,
        };
    }
    if (memoryHit)
        snapshotCache.delete(cacheKey);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return null;
        const redisHit = await redis.get(getSnapshotRedisKey(cacheKey));
        if (!redisHit)
            return null;
        return {
            payload: JSON.parse(redisHit),
            isFresh: true,
        };
    }
    catch (err) {
        console.error(`[live-map-cache] redis read failed: ${err?.message || "unknown"}`);
        return null;
    }
}
async function writeSnapshotCache(cacheKey, payload, ttlMs) {
    const staleMs = Math.max(ttlMs, Number(process.env.LIVE_MAP_SNAPSHOT_STALE_MS || 10 * 60000));
    const now = Date.now();
    snapshotCache.set(cacheKey, {
        payload,
        expiresAt: now + ttlMs,
        staleUntil: now + ttlMs + staleMs,
    });
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
        await redis.set(getSnapshotRedisKey(cacheKey), JSON.stringify(payload), "EX", ttlSec);
    }
    catch (err) {
        console.error(`[live-map-cache] redis write failed: ${err?.message || "unknown"}`);
    }
}
const liveMapFastifyRoutes = async (fastify) => {
    fastify.get("/snapshot", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            const actor = actorFromRequest(request);
            if (!actor)
                return reply.code(401).send({ error: "Unauthorized" });
            const allowed = await (0, identity_access_1.hasPermission)(request.user, "orders.read");
            if (!allowed)
                return reply.code(403).send({ error: "Forbidden" });
            const viewport = parseViewport((request.query ?? {}));
            const cacheKey = getSnapshotCacheKey(actor.role, actor.warehouseId, viewport);
            const cacheTtlMs = Math.min(Math.max(Number(process.env.LIVE_MAP_SNAPSHOT_CACHE_TTL_MS || 45000), 1000), 120000);
            const cached = await readSnapshotCache(cacheKey);
            if (cached?.isFresh) {
                reply.header("X-Live-Map-Cache", "HIT");
                reply.header("X-Live-Map-Time-Ms", String(Date.now() - startedAt));
                reply.header("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
                return reply.send(cached.payload);
            }
            let build = snapshotBuilds.get(cacheKey);
            if (!build) {
                build = (0, liveMapService_1.getLiveMapSnapshot)({
                    actor: { role: actor.role, warehouseId: actor.warehouseId },
                    viewport,
                });
                snapshotBuilds.set(cacheKey, build);
                build
                    .then((snapshot) => writeSnapshotCache(cacheKey, snapshot, cacheTtlMs))
                    .catch((err) => {
                    console.error(`[live-map-cache] snapshot build failed: ${err?.message || "unknown"}`);
                })
                    .finally(() => {
                    snapshotBuilds.delete(cacheKey);
                });
            }
            const fastTimeoutMs = Math.max(250, Number(process.env.LIVE_MAP_SNAPSHOT_FAST_TIMEOUT_MS || 1200));
            const snapshot = cached?.payload ? await withTimeout(build, fastTimeoutMs) : await build;
            if (!snapshot) {
                const stalePayload = { ...cached.payload, isStale: true };
                reply.header("X-Live-Map-Cache", "STALE");
                reply.header("X-Live-Map-Time-Ms", String(Date.now() - startedAt));
                reply.header("Cache-Control", "private, max-age=3");
                return reply.send(stalePayload);
            }
            await writeSnapshotCache(cacheKey, snapshot, cacheTtlMs);
            const elapsedMs = Date.now() - startedAt;
            reply.header("X-Live-Map-Cache", "MISS");
            reply.header("X-Live-Map-Time-Ms", String(elapsedMs));
            reply.header("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
            if (elapsedMs > 1500) {
                console.warn(`[live-map] slow snapshot ${elapsedMs}ms drivers=${snapshot.drivers.length} orders=${snapshot.orders.length} warehouses=${snapshot.warehouses.length} viewport=${viewport ? "yes" : "no"}`);
            }
            return reply.send(snapshot);
        }
        catch (err) {
            return reply.code(500).send({ error: err?.message || "Failed to fetch live map snapshot" });
        }
    });
    fastify.get("/stream", { preHandler: (0, authFastify_1.fastifyAuth)() }, async (request, reply) => {
        const actor = actorFromRequest(request);
        if (!actor)
            return reply.code(401).send({ error: "Unauthorized" });
        const allowed = await (0, identity_access_1.hasPermission)(request.user, "orders.read");
        if (!allowed)
            return reply.code(403).send({ error: "Forbidden" });
        const viewport = parseViewport((request.query ?? {}));
        const clientKey = `${request.user?.id || "anon"}:${request.ip || "ip"}`;
        const lastEventId = String(request.headers["last-event-id"] || request.headers["Last-Event-ID"] || "").trim();
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache, no-transform");
        reply.header("Connection", "keep-alive");
        reply.header("X-Accel-Buffering", "no");
        reply.raw.flushHeaders?.();
        (0, opsMetrics_1.recordSseConnected)({ stream: "live-map", clientKey });
        reply.raw.write(`event: ready\ndata: ${JSON.stringify({
            connectedAt: new Date().toISOString(),
            resumedFrom: lastEventId || null,
        })}\n\n`);
        const redisReplayEvents = await (0, liveMapStore_1.replayLiveMapEventsFromRedis)({
            lastEventId,
            limit: Number(process.env.LIVE_MAP_STREAM_REPLAY_MAX_EVENTS || 300),
        });
        const replayEvents = redisReplayEvents.length
            ? redisReplayEvents
            : (0, liveMapStore_1.replayLiveMapEventsSince)(lastEventId);
        const replayLimit = Math.max(10, Number(process.env.LIVE_MAP_STREAM_REPLAY_MAX_EVENTS || 300));
        const replaySlice = replayEvents.slice(-replayLimit);
        replaySlice.forEach((event) => {
            reply.raw.write(`id: ${event.id || ""}\n`);
            reply.raw.write(`event: live-map\ndata: ${JSON.stringify(event)}\n\n`);
        });
        if (replayEvents.length > replaySlice.length) {
            reply.raw.write(`event: live-map-replay-truncated\ndata: ${JSON.stringify({
                skipped: replayEvents.length - replaySlice.length,
                delivered: replaySlice.length,
            })}\n\n`);
        }
        const heartbeatMs = Math.max(10000, Number(process.env.LIVE_MAP_STREAM_HEARTBEAT_MS || 25000));
        const heartbeat = setInterval(() => {
            reply.raw.write(`: keepalive ${Date.now()}\n\n`);
        }, heartbeatMs);
        const unsubscribe = (0, liveMapStore_1.subscribeLiveMapEvents)((event) => {
            if (actor.role === identity_access_1.ROLE_WAREHOUSE && actor.warehouseId) {
                if (event.type !== "driver_location_upsert")
                    return;
                const eventWarehouseId = event.payload.warehouseId;
                if (eventWarehouseId && eventWarehouseId !== actor.warehouseId)
                    return;
            }
            if (viewport && event.type === "driver_location_upsert") {
                if (!isInViewport(event.payload.lat, event.payload.lng, viewport))
                    return;
            }
            reply.raw.write(`id: ${event.id || ""}\n`);
            reply.raw.write(`event: live-map\ndata: ${JSON.stringify(event)}\n\n`);
        });
        request.raw.on("close", () => {
            (0, opsMetrics_1.recordSseDisconnected)("live-map");
            clearInterval(heartbeat);
            unsubscribe();
        });
        return reply.hijack();
    });
};
exports.default = liveMapFastifyRoutes;
