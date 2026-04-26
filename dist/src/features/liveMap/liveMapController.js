"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveMapSnapshotController = getLiveMapSnapshotController;
exports.ingestDriverLocationController = ingestDriverLocationController;
exports.getDriverPresenceController = getDriverPresenceController;
exports.setDriverPresenceController = setDriverPresenceController;
exports.heartbeatDriverPresenceController = heartbeatDriverPresenceController;
exports.streamLiveMapController = streamLiveMapController;
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const zod_1 = require("zod");
const redis_1 = require("../../config/redis");
const liveMapStore_1 = require("./liveMapStore");
const liveMapService_1 = require("./liveMapService");
function getActor(req) {
    const role = req.user?.role;
    const warehouseId = req.user?.warehouseId ?? null;
    const userId = req.user?.id;
    if (!role || !userId)
        return null;
    return { role, warehouseId, userId };
}
function handleLiveMapActionError(res, err, fallbackMessage) {
    if (err instanceof zod_1.ZodError) {
        return res.status(400).json({
            error: "Invalid payload",
            issues: err.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
            })),
        });
    }
    if (typeof err?.message === "string" && err.message.includes("different driver")) {
        return res.status(403).json({ error: err.message });
    }
    if (typeof err?.message === "string" && err.message.includes("required for manager")) {
        return res.status(400).json({ error: err.message });
    }
    if (typeof err?.message === "string" && err.message.includes("not found")) {
        return res.status(404).json({ error: err.message });
    }
    return res.status(400).json({ error: err?.message || fallbackMessage });
}
const liveMapSnapshotCache = new Map();
const liveMapCacheGcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of liveMapSnapshotCache.entries()) {
        if (now >= entry.expiresAt)
            liveMapSnapshotCache.delete(key);
    }
}, 60000);
liveMapCacheGcTimer.unref();
function getSnapshotCacheKey(role, warehouseId) {
    return `${role}:${warehouseId ?? "all"}`;
}
function getSnapshotRedisKey(rawKey) {
    const digest = (0, crypto_1.createHash)("sha1").update(rawKey).digest("hex");
    return `${(0, redis_1.getRedisPrefix)()}:live-map:snapshot:${digest}`;
}
async function readSnapshotCache(key) {
    const memoryHit = liveMapSnapshotCache.get(key);
    if (memoryHit && Date.now() < memoryHit.expiresAt)
        return memoryHit.payload;
    if (memoryHit)
        liveMapSnapshotCache.delete(key);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return null;
        const redisHit = await redis.get(getSnapshotRedisKey(key));
        if (!redisHit)
            return null;
        return JSON.parse(redisHit);
    }
    catch (err) {
        console.error(`[live-map-cache] redis read failed: ${err?.message || "unknown"}`);
        return null;
    }
}
async function writeSnapshotCache(key, payload, ttlMs) {
    liveMapSnapshotCache.set(key, {
        payload,
        expiresAt: Date.now() + ttlMs,
    });
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
        await redis.set(getSnapshotRedisKey(key), JSON.stringify(payload), "EX", ttlSec);
    }
    catch (err) {
        console.error(`[live-map-cache] redis write failed: ${err?.message || "unknown"}`);
    }
}
async function getLiveMapSnapshotController(req, res) {
    try {
        const actor = getActor(req);
        if (!actor)
            return res.status(401).json({ error: "Unauthorized" });
        const cacheKey = getSnapshotCacheKey(actor.role, actor.warehouseId);
        const cacheTtlMs = Math.min(Math.max(Number(process.env.LIVE_MAP_SNAPSHOT_CACHE_TTL_MS || 5000), 1000), 60000);
        const cached = await readSnapshotCache(cacheKey);
        if (cached) {
            res.setHeader("X-Live-Map-Cache", "HIT");
            res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
            return res.json(cached);
        }
        const snapshot = await (0, liveMapService_1.getLiveMapSnapshot)({
            role: actor.role,
            warehouseId: actor.warehouseId,
        });
        await writeSnapshotCache(cacheKey, snapshot, cacheTtlMs);
        res.setHeader("X-Live-Map-Cache", "MISS");
        res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
        return res.json(snapshot);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to fetch live map snapshot" });
    }
}
async function ingestDriverLocationController(req, res) {
    try {
        const actor = getActor(req);
        if (!actor)
            return res.status(401).json({ error: "Unauthorized" });
        if (actor.role !== client_1.AppRole.driver && actor.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const result = await (0, liveMapService_1.ingestDriverLocation)({
            actor: {
                role: actor.role,
                warehouseId: actor.warehouseId,
                userId: actor.userId,
            },
            body: req.body,
        });
        return res.json(result);
    }
    catch (err) {
        return handleLiveMapActionError(res, err, "Failed to ingest driver location");
    }
}
async function getDriverPresenceController(req, res) {
    try {
        const actor = getActor(req);
        if (!actor)
            return res.status(401).json({ error: "Unauthorized" });
        if (actor.role !== client_1.AppRole.driver && actor.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const result = await (0, liveMapService_1.getDriverPresence)({
            actor: {
                role: actor.role,
                warehouseId: actor.warehouseId,
                userId: actor.userId,
            },
            query: req.query,
        });
        return res.json(result);
    }
    catch (err) {
        return handleLiveMapActionError(res, err, "Failed to fetch driver presence");
    }
}
async function setDriverPresenceController(req, res) {
    try {
        const actor = getActor(req);
        if (!actor)
            return res.status(401).json({ error: "Unauthorized" });
        if (actor.role !== client_1.AppRole.driver && actor.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const result = await (0, liveMapService_1.setDriverPresence)({
            actor: {
                role: actor.role,
                warehouseId: actor.warehouseId,
                userId: actor.userId,
            },
            body: req.body,
        });
        return res.json(result);
    }
    catch (err) {
        return handleLiveMapActionError(res, err, "Failed to update driver presence");
    }
}
async function heartbeatDriverPresenceController(req, res) {
    try {
        const actor = getActor(req);
        if (!actor)
            return res.status(401).json({ error: "Unauthorized" });
        if (actor.role !== client_1.AppRole.driver && actor.role !== client_1.AppRole.manager) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const result = await (0, liveMapService_1.heartbeatDriverPresence)({
            actor: {
                role: actor.role,
                warehouseId: actor.warehouseId,
                userId: actor.userId,
            },
            body: req.body,
        });
        return res.json(result);
    }
    catch (err) {
        return handleLiveMapActionError(res, err, "Failed to heartbeat driver presence");
    }
}
async function streamLiveMapController(req, res) {
    const actor = getActor(req);
    if (!actor)
        return res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
    const heartbeatMs = Math.max(10000, Number(process.env.LIVE_MAP_STREAM_HEARTBEAT_MS || 25000));
    const heartbeat = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
    }, heartbeatMs);
    const unsubscribe = (0, liveMapStore_1.subscribeLiveMapEvents)((event) => {
        if (actor.role === client_1.AppRole.warehouse && actor.warehouseId) {
            if (event.type !== "driver_location_upsert")
                return;
            if (event.type === "driver_location_upsert") {
                const eventWarehouseId = event.payload.warehouseId;
                if (eventWarehouseId && eventWarehouseId !== actor.warehouseId)
                    return;
            }
        }
        res.write(`event: live-map\ndata: ${JSON.stringify(event)}\n\n`);
    });
    req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
    });
    return undefined;
}
