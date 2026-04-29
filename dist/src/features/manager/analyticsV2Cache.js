"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeScopeKey = makeScopeKey;
exports.invalidateNamespaceCaches = invalidateNamespaceCaches;
exports.getOrComputeCached = getOrComputeCached;
const crypto_1 = require("crypto");
const redis_1 = require("../../config/redis");
const memoryCache = new Map();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryCache.entries()) {
        if (now >= entry.expiresAt)
            memoryCache.delete(key);
    }
}, 60000);
cleanupTimer.unref();
function digestKey(input) {
    return (0, crypto_1.createHash)("sha1").update(input).digest("hex");
}
function asRedisKey(namespace, key) {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v2:${namespace}:${digestKey(key)}`;
}
function asLockKey(namespace, key) {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v2:lock:${namespace}:${digestKey(key)}`;
}
function withJitter(ttlMs) {
    const jitterPct = Math.min(Math.max(Number(process.env.ANALYTICS_V2_CACHE_JITTER_PCT || 0.15), 0), 0.45);
    const jitter = ttlMs * jitterPct;
    const min = ttlMs - jitter;
    const max = ttlMs + jitter;
    return Math.max(1000, Math.floor(min + Math.random() * Math.max(1, max - min)));
}
function readMemory(cacheKey) {
    const hit = memoryCache.get(cacheKey);
    if (!hit)
        return null;
    if (Date.now() >= hit.expiresAt) {
        memoryCache.delete(cacheKey);
        return null;
    }
    return hit.payload;
}
function writeMemory(cacheKey, payload, ttlMs) {
    memoryCache.set(cacheKey, { payload, expiresAt: Date.now() + ttlMs });
}
function makeScopeKey(args) {
    if (args.role === "warehouse" && args.warehouseId) {
        return `warehouse:${args.warehouseId}`;
    }
    return `role:${args.role || "manager"}`;
}
async function invalidateNamespaceCaches(namespace) {
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        const pattern = `${(0, redis_1.getRedisPrefix)()}:analytics:v2:${namespace}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
            await redis.del(...keys);
        }
    }
    catch (err) {
        console.error(`[analytics-v2] invalidate ${namespace} failed: ${err?.message || "unknown"}`);
    }
    for (const key of memoryCache.keys()) {
        if (key.startsWith(`${namespace}:`)) {
            memoryCache.delete(key);
        }
    }
}
async function getOrComputeCached(args) {
    const memoryKey = `${args.namespace}:${args.key}`;
    const memoryHit = readMemory(memoryKey);
    if (memoryHit) {
        return { payload: memoryHit, cacheHit: true };
    }
    const ttlMs = withJitter(Math.max(1000, args.ttlMs));
    const lockMs = Math.max(500, args.lockMs ?? 4000);
    const redisDataKey = asRedisKey(args.namespace, args.key);
    const redisLockKey = asLockKey(args.namespace, args.key);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis) {
            const payload = await args.compute();
            writeMemory(memoryKey, payload, ttlMs);
            return { payload, cacheHit: false };
        }
        const redisHit = await redis.get(redisDataKey);
        if (redisHit) {
            const payload = JSON.parse(redisHit);
            writeMemory(memoryKey, payload, ttlMs);
            return { payload, cacheHit: true };
        }
        const lockValue = `${Date.now()}-${Math.random()}`;
        const lockAcquired = await redis.set(redisLockKey, lockValue, "PX", lockMs, "NX");
        if (lockAcquired) {
            try {
                const payload = await args.compute();
                const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
                await redis.set(redisDataKey, JSON.stringify(payload), "EX", ttlSec);
                writeMemory(memoryKey, payload, ttlMs);
                return { payload, cacheHit: false };
            }
            finally {
                const current = await redis.get(redisLockKey);
                if (current === lockValue) {
                    await redis.del(redisLockKey);
                }
            }
        }
        const waitMaxMs = Math.min(3000, lockMs);
        const started = Date.now();
        while (Date.now() - started < waitMaxMs) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            const retryHit = await redis.get(redisDataKey);
            if (retryHit) {
                const payload = JSON.parse(retryHit);
                writeMemory(memoryKey, payload, ttlMs);
                return { payload, cacheHit: true };
            }
        }
        const payload = await args.compute();
        const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
        await redis.set(redisDataKey, JSON.stringify(payload), "EX", ttlSec);
        writeMemory(memoryKey, payload, ttlMs);
        return { payload, cacheHit: false };
    }
    catch (err) {
        console.error(`[analytics-v2] cache fallback compute: ${err?.message || "unknown"}`);
        const payload = await args.compute();
        writeMemory(memoryKey, payload, ttlMs);
        return { payload, cacheHit: false };
    }
}
