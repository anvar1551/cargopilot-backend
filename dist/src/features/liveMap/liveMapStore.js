"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertDriverLocation = upsertDriverLocation;
exports.readDriverLocation = readDriverLocation;
exports.readDriverLocations = readDriverLocations;
exports.upsertDriverPresence = upsertDriverPresence;
exports.touchDriverPresenceHeartbeat = touchDriverPresenceHeartbeat;
exports.readDriverPresence = readDriverPresence;
exports.readDriverPresences = readDriverPresences;
exports.publishLiveMapEvent = publishLiveMapEvent;
exports.subscribeLiveMapEvents = subscribeLiveMapEvents;
// Modernized: ioredis + Hash storage + Redis Streams
const events_1 = require("events");
const redis_1 = require("../../config/redis");
const LOCATION_TTL_SEC = Math.max(300, Number(process.env.LIVE_MAP_DRIVER_LOCATION_TTL_SEC || 60 * 60 * 12));
const PRESENCE_TTL_SEC = Math.max(300, Number(process.env.LIVE_MAP_DRIVER_PRESENCE_TTL_SEC || 60 * 60 * 24));
const memoryStore = new Map();
const presenceMemoryStore = new Map();
const _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryStore) {
        if (now >= entry.expiresAt)
            memoryStore.delete(key);
    }
    for (const [key, entry] of presenceMemoryStore) {
        if (now >= entry.expiresAt)
            presenceMemoryStore.delete(key);
    }
}, 60000);
_cleanupTimer.unref();
const liveMapEmitter = new events_1.EventEmitter();
liveMapEmitter.setMaxListeners(200);
let streamLastId = "$";
let streamConsumerStarted = false;
function nowMs() {
    return Date.now();
}
function parseDriverLocationRecord(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const value = raw;
    if (typeof value.driverId !== "string" || !value.driverId.trim())
        return null;
    if (typeof value.lat !== "number" || !Number.isFinite(value.lat))
        return null;
    if (typeof value.lng !== "number" || !Number.isFinite(value.lng))
        return null;
    if (typeof value.speedKmh !== "number" || !Number.isFinite(value.speedKmh))
        return null;
    if (typeof value.headingDeg !== "number" || !Number.isFinite(value.headingDeg))
        return null;
    if (typeof value.recordedAt !== "string" || !value.recordedAt.trim())
        return null;
    return {
        driverId: value.driverId,
        warehouseId: typeof value.warehouseId === "string" ? value.warehouseId : null,
        lat: value.lat,
        lng: value.lng,
        speedKmh: value.speedKmh,
        headingDeg: value.headingDeg,
        accuracyM: typeof value.accuracyM === "number" && Number.isFinite(value.accuracyM) ? value.accuracyM : null,
        recordedAt: value.recordedAt,
        orderId: typeof value.orderId === "string" ? value.orderId : null,
    };
}
function parseDriverLocationHash(hash, driverId) {
    const accuracyRaw = hash.accuracyM;
    const parsed = parseDriverLocationRecord({
        driverId,
        warehouseId: hash.warehouseId,
        lat: parseFloat(hash.lat),
        lng: parseFloat(hash.lng),
        speedKmh: parseFloat(hash.speedKmh),
        headingDeg: parseFloat(hash.headingDeg),
        accuracyM: typeof accuracyRaw === "string" && accuracyRaw.trim()
            ? parseFloat(accuracyRaw)
            : null,
        recordedAt: hash.recordedAt,
        orderId: hash.orderId,
    });
    return parsed;
}
function parsePresenceEnabled(value) {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
    if (!normalized)
        return null;
    if (normalized === "1" || normalized === "true" || normalized === "on")
        return true;
    if (normalized === "0" || normalized === "false" || normalized === "off")
        return false;
    return null;
}
function parseDriverPresenceHash(hash, driverId) {
    if (!hash || Object.keys(hash).length === 0)
        return null;
    const enabled = parsePresenceEnabled(hash.enabled);
    const updatedAt = typeof hash.updatedAt === "string" ? hash.updatedAt : "";
    if (enabled == null || !updatedAt)
        return null;
    const heartbeatAt = typeof hash.heartbeatAt === "string" && hash.heartbeatAt.trim() ? hash.heartbeatAt : null;
    return {
        driverId,
        enabled,
        heartbeatAt,
        updatedAt,
    };
}
function getLocationRedisKey(driverId) {
    return `${(0, redis_1.getRedisPrefix)()}:live-map:driver-location:${driverId}`;
}
function getPresenceRedisKey(driverId) {
    return `${(0, redis_1.getRedisPrefix)()}:live-map:driver-presence:${driverId}`;
}
function getEventsStream() {
    return `${(0, redis_1.getRedisPrefix)()}:live-map:events`;
}
function readMemoryLocation(driverId) {
    const hit = memoryStore.get(driverId);
    if (!hit)
        return null;
    if (nowMs() >= hit.expiresAt) {
        memoryStore.delete(driverId);
        return null;
    }
    return hit.value;
}
function writeMemoryLocation(location) {
    memoryStore.set(location.driverId, {
        value: location,
        expiresAt: nowMs() + LOCATION_TTL_SEC * 1000,
    });
}
function readMemoryPresence(driverId) {
    const hit = presenceMemoryStore.get(driverId);
    if (!hit)
        return null;
    if (nowMs() >= hit.expiresAt) {
        presenceMemoryStore.delete(driverId);
        return null;
    }
    return hit.value;
}
function writeMemoryPresence(record) {
    presenceMemoryStore.set(record.driverId, {
        value: record,
        expiresAt: nowMs() + PRESENCE_TTL_SEC * 1000,
    });
}
async function startStreamConsumer() {
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return;
    while (true) {
        try {
            const results = (await redis.xread("COUNT", 100, "BLOCK", 2000, "STREAMS", getEventsStream(), streamLastId));
            if (results) {
                for (const [, entries] of results) {
                    for (const [id, fields] of entries) {
                        streamLastId = id;
                        const dataIdx = fields.indexOf("data");
                        if (dataIdx !== -1) {
                            const rawEvent = fields[dataIdx + 1];
                            if (!rawEvent)
                                continue;
                            const event = JSON.parse(rawEvent);
                            liveMapEmitter.emit("live-map-event", event);
                        }
                    }
                }
            }
        }
        catch (err) {
            console.error(`[live-map] stream read error: ${err?.message}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}
async function upsertDriverLocation(location) {
    writeMemoryLocation(location);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        const fields = [
            "lat",
            location.lat,
            "lng",
            location.lng,
            "speedKmh",
            location.speedKmh,
            "headingDeg",
            location.headingDeg,
            "recordedAt",
            location.recordedAt,
            ...(location.warehouseId ? ["warehouseId", location.warehouseId] : []),
            ...(location.orderId ? ["orderId", location.orderId] : []),
            ...(location.accuracyM !== null ? ["accuracyM", location.accuracyM] : []),
        ];
        await redis.hset(getLocationRedisKey(location.driverId), ...fields);
        await redis.expire(getLocationRedisKey(location.driverId), LOCATION_TTL_SEC);
    }
    catch (err) {
        console.error(`[live-map] redis write location failed: ${err?.message || "unknown"}`);
    }
}
async function readDriverLocation(driverId) {
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (redis) {
            const hash = await redis.hgetall(getLocationRedisKey(driverId));
            if (hash && Object.keys(hash).length > 0) {
                const parsed = parseDriverLocationHash(hash, driverId);
                if (parsed) {
                    writeMemoryLocation(parsed);
                    return parsed;
                }
            }
        }
    }
    catch (err) {
        console.error(`[live-map] redis read location failed: ${err?.message || "unknown"}`);
    }
    return readMemoryLocation(driverId);
}
async function readDriverLocations(driverIds) {
    const locations = new Map();
    if (driverIds.length === 0)
        return locations;
    const keyByIndex = [];
    const redisKeys = driverIds.map((driverId) => {
        keyByIndex.push(driverId);
        return getLocationRedisKey(driverId);
    });
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (redis) {
            const pipe = redis.pipeline();
            redisKeys.forEach((key) => pipe.hgetall(key));
            const results = await pipe.exec();
            if (results) {
                results.forEach((entry, index) => {
                    const [err, hash] = entry ?? [];
                    if (err || !hash || typeof hash !== "object")
                        return;
                    if (Object.keys(hash).length === 0)
                        return;
                    const parsed = parseDriverLocationHash(hash, keyByIndex[index]);
                    if (!parsed)
                        return;
                    locations.set(keyByIndex[index], parsed);
                    writeMemoryLocation(parsed);
                });
            }
        }
    }
    catch (err) {
        console.error(`[live-map] redis pipeline read failed: ${err?.message || "unknown"}`);
    }
    for (const driverId of driverIds) {
        if (locations.has(driverId))
            continue;
        const memoryHit = readMemoryLocation(driverId);
        if (memoryHit) {
            locations.set(driverId, memoryHit);
        }
    }
    return locations;
}
async function upsertDriverPresence(record) {
    writeMemoryPresence(record);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        const key = getPresenceRedisKey(record.driverId);
        const fields = [
            "enabled",
            record.enabled ? "1" : "0",
            "updatedAt",
            record.updatedAt,
            ...(record.heartbeatAt ? ["heartbeatAt", record.heartbeatAt] : []),
        ];
        await redis.hset(key, ...fields);
        await redis.expire(key, PRESENCE_TTL_SEC);
    }
    catch (err) {
        console.error(`[live-map] redis write presence failed: ${err?.message || "unknown"}`);
    }
}
async function touchDriverPresenceHeartbeat(args) {
    const memoryHit = readMemoryPresence(args.driverId);
    const next = {
        driverId: args.driverId,
        enabled: memoryHit?.enabled ?? true,
        heartbeatAt: args.heartbeatAt,
        updatedAt: args.heartbeatAt,
    };
    writeMemoryPresence(next);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return next;
        const key = getPresenceRedisKey(args.driverId);
        const fields = [
            "enabled",
            next.enabled ? "1" : "0",
            "heartbeatAt",
            args.heartbeatAt,
            "updatedAt",
            args.heartbeatAt,
        ];
        await redis.hset(key, ...fields);
        await redis.expire(key, PRESENCE_TTL_SEC);
    }
    catch (err) {
        console.error(`[live-map] redis heartbeat touch failed: ${err?.message || "unknown"}`);
    }
    return next;
}
async function readDriverPresence(driverId) {
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (redis) {
            const hash = await redis.hgetall(getPresenceRedisKey(driverId));
            const parsed = parseDriverPresenceHash(hash, driverId);
            if (parsed) {
                writeMemoryPresence(parsed);
                return parsed;
            }
        }
    }
    catch (err) {
        console.error(`[live-map] redis read presence failed: ${err?.message || "unknown"}`);
    }
    return readMemoryPresence(driverId);
}
async function readDriverPresences(driverIds) {
    const result = new Map();
    if (driverIds.length === 0)
        return result;
    const keyByIndex = [];
    const redisKeys = driverIds.map((driverId) => {
        keyByIndex.push(driverId);
        return getPresenceRedisKey(driverId);
    });
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (redis) {
            const pipe = redis.pipeline();
            redisKeys.forEach((key) => pipe.hgetall(key));
            const rows = await pipe.exec();
            if (rows) {
                rows.forEach((entry, index) => {
                    const [err, hash] = entry ?? [];
                    if (err || !hash || typeof hash !== "object")
                        return;
                    const parsed = parseDriverPresenceHash(hash, keyByIndex[index]);
                    if (!parsed)
                        return;
                    result.set(keyByIndex[index], parsed);
                    writeMemoryPresence(parsed);
                });
            }
        }
    }
    catch (err) {
        console.error(`[live-map] redis pipeline presence read failed: ${err?.message || "unknown"}`);
    }
    for (const driverId of driverIds) {
        if (result.has(driverId))
            continue;
        const memoryHit = readMemoryPresence(driverId);
        if (memoryHit) {
            result.set(driverId, memoryHit);
        }
    }
    return result;
}
async function publishLiveMapEvent(event) {
    liveMapEmitter.emit("live-map-event", event);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        await redis.xadd(getEventsStream(), "MAXLEN", "~", "10000", "*", "type", event.type, "data", JSON.stringify(event));
    }
    catch (err) {
        console.error(`[live-map] redis stream publish failed: ${err?.message || "unknown"}`);
    }
}
function subscribeLiveMapEvents(handler) {
    liveMapEmitter.on("live-map-event", handler);
    if (!streamConsumerStarted) {
        streamConsumerStarted = true;
        void startStreamConsumer();
    }
    return () => {
        liveMapEmitter.off("live-map-event", handler);
    };
}
