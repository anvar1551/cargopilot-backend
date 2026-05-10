"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeScopeKey = makeScopeKey;
exports.invalidateNamespaceCaches = invalidateNamespaceCaches;
exports.getOrComputeCached = getOrComputeCached;
const crypto_1 = require("crypto");
const redis_1 = require("../../config/redis");
const memoryCache = new Map();
const refreshInFlight = new Map();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryCache.entries()) {
        if (now >= entry.staleUntil)
            memoryCache.delete(key);
    }
}, 60000);
cleanupTimer.unref();
const versionCache = new Map();
const VERSION_TTL_MS = 5000;
function digestKey(input) {
    return (0, crypto_1.createHash)("sha1").update(input).digest("hex");
}
function asRedisKey(namespace, key) {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v2:${namespace}:${digestKey(key)}`;
}
function asLockKey(namespace, key) {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v2:lock:${namespace}:${digestKey(key)}`;
}
function asVersionKey(namespace) {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v2:version:${namespace}`;
}
async function readNamespaceVersion(namespace) {
    const mem = versionCache.get(namespace);
    if (mem && Date.now() < mem.expiresAt)
        return mem.value;
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return mem?.value ?? 1;
        const raw = await (0, redis_1.withRedisTimeout)("analytics:version:get", () => redis.get(asVersionKey(namespace)));
        const parsed = Math.max(1, Number(raw || mem?.value || 1));
        versionCache.set(namespace, { value: parsed, expiresAt: Date.now() + VERSION_TTL_MS });
        return parsed;
    }
    catch (err) {
        const fallback = mem?.value ?? 1;
        versionCache.set(namespace, { value: fallback, expiresAt: Date.now() + VERSION_TTL_MS });
        console.error(`[analytics-v2] namespace version fallback ${namespace}: ${err?.message || "unknown"}`);
        return fallback;
    }
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
    const now = Date.now();
    if (now >= hit.staleUntil) {
        memoryCache.delete(cacheKey);
        return null;
    }
    return { payload: hit.payload, isFresh: now < hit.expiresAt };
}
function writeMemory(cacheKey, payload, ttlMs) {
    const staleMs = Math.max(ttlMs, Number(process.env.ANALYTICS_V2_CACHE_STALE_MS || 10 * 60000));
    const now = Date.now();
    memoryCache.set(cacheKey, {
        payload,
        expiresAt: now + ttlMs,
        staleUntil: now + ttlMs + staleMs,
    });
}
function refreshMemoryInBackground(cacheKey, ttlMs, compute) {
    if (refreshInFlight.has(cacheKey))
        return;
    const task = compute()
        .then((payload) => {
        writeMemory(cacheKey, payload, ttlMs);
    })
        .catch((err) => {
        console.error(`[analytics-v2] stale refresh failed: ${err?.message || "unknown"}`);
    })
        .finally(() => {
        refreshInFlight.delete(cacheKey);
    });
    refreshInFlight.set(cacheKey, task);
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
        if (redis) {
            const next = await (0, redis_1.withRedisTimeout)("analytics:version:incr", () => redis.incr(asVersionKey(namespace)));
            versionCache.set(namespace, { value: Math.max(1, Number(next || 1)), expiresAt: Date.now() + VERSION_TTL_MS });
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
    const namespaceVersion = await readNamespaceVersion(args.namespace);
    const versionedLogicalKey = `v${namespaceVersion}:${args.key}`;
    const memoryKey = `${args.namespace}:${versionedLogicalKey}`;
    const memoryHit = readMemory(memoryKey);
    if (memoryHit?.isFresh) {
        return { payload: memoryHit.payload, cacheHit: true };
    }
    const ttlMs = withJitter(Math.max(1000, args.ttlMs));
    if (memoryHit) {
        refreshMemoryInBackground(memoryKey, ttlMs, args.compute);
        return { payload: memoryHit.payload, cacheHit: true };
    }
    const lockMs = Math.max(500, args.lockMs ?? 4000);
    const redisDataKey = asRedisKey(args.namespace, versionedLogicalKey);
    const redisLockKey = asLockKey(args.namespace, versionedLogicalKey);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis) {
            const payload = await args.compute();
            writeMemory(memoryKey, payload, ttlMs);
            return { payload, cacheHit: false };
        }
        const redisHit = await (0, redis_1.withRedisTimeout)("analytics:cache:get", () => redis.get(redisDataKey));
        if (redisHit) {
            const payload = JSON.parse(redisHit);
            writeMemory(memoryKey, payload, ttlMs);
            return { payload, cacheHit: true };
        }
        const lockValue = `${Date.now()}-${Math.random()}`;
        const lockAcquired = await (0, redis_1.withRedisTimeout)("analytics:lock:set", () => redis.set(redisLockKey, lockValue, "PX", lockMs, "NX"));
        if (lockAcquired) {
            try {
                const payload = await args.compute();
                const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
                writeMemory(memoryKey, payload, ttlMs);
                try {
                    await (0, redis_1.withRedisTimeout)("analytics:cache:set", () => redis.set(redisDataKey, JSON.stringify(payload), "EX", ttlSec));
                }
                catch (err) {
                    console.error(`[analytics-v2] redis cache set skipped: ${err?.message || "unknown"}`);
                }
                return { payload, cacheHit: false };
            }
            finally {
                try {
                    const current = await (0, redis_1.withRedisTimeout)("analytics:lock:get", () => redis.get(redisLockKey));
                    if (current === lockValue) {
                        await (0, redis_1.withRedisTimeout)("analytics:lock:del", () => redis.del(redisLockKey));
                    }
                }
                catch (err) {
                    console.error(`[analytics-v2] lock release skipped: ${err?.message || "unknown"}`);
                }
            }
        }
        const configuredWaitMs = Math.max(100, Number(process.env.ANALYTICS_V2_CACHE_LOCK_WAIT_MS || 800));
        const waitMaxMs = Math.min(configuredWaitMs, lockMs);
        const started = Date.now();
        while (Date.now() - started < waitMaxMs) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            const retryHit = await (0, redis_1.withRedisTimeout)("analytics:cache:retry-get", () => redis.get(redisDataKey));
            if (retryHit) {
                const payload = JSON.parse(retryHit);
                writeMemory(memoryKey, payload, ttlMs);
                return { payload, cacheHit: true };
            }
        }
        const payload = await args.compute();
        const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
        writeMemory(memoryKey, payload, ttlMs);
        try {
            await (0, redis_1.withRedisTimeout)("analytics:cache:late-set", () => redis.set(redisDataKey, JSON.stringify(payload), "EX", ttlSec));
        }
        catch (err) {
            console.error(`[analytics-v2] redis cache late-set skipped: ${err?.message || "unknown"}`);
        }
        return { payload, cacheHit: false };
    }
    catch (err) {
        console.error(`[analytics-v2] cache fallback compute: ${err?.message || "unknown"}`);
        const payload = await args.compute();
        writeMemory(memoryKey, payload, ttlMs);
        return { payload, cacheHit: false };
    }
}
