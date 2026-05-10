"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSummaryReadModelKey = getSummaryReadModelKey;
exports.getTrendReadModelKey = getTrendReadModelKey;
exports.getWarningsReadModelKey = getWarningsReadModelKey;
exports.getFinanceQueueReadModelKey = getFinanceQueueReadModelKey;
exports.readAnalyticsReadModel = readAnalyticsReadModel;
exports.writeAnalyticsReadModel = writeAnalyticsReadModel;
exports.clearAnalyticsReadModelBySection = clearAnalyticsReadModelBySection;
const redis_1 = require("../../config/redis");
const memoryStore = new Map();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryStore.entries()) {
        if (now >= entry.staleUntil)
            memoryStore.delete(key);
    }
}, 60000);
cleanupTimer.unref();
async function deleteByPatternScan(pattern) {
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return;
    let cursor = "0";
    do {
        const [nextCursor, keys] = (await redis.scan(cursor, "MATCH", pattern, "COUNT", 200));
        cursor = nextCursor;
        if (Array.isArray(keys) && keys.length > 0) {
            await redis.del(...keys);
        }
    } while (cursor !== "0");
}
function withJitter(ttlMs) {
    const jitterPct = Math.min(Math.max(Number(process.env.ANALYTICS_V3_CACHE_JITTER_PCT || 0.15), 0), 0.45);
    const jitter = ttlMs * jitterPct;
    const min = ttlMs - jitter;
    const max = ttlMs + jitter;
    return Math.max(1000, Math.floor(min + Math.random() * Math.max(1, max - min)));
}
function makeKey(section, suffix) {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v3:${section}:${suffix}`;
}
function getSummaryReadModelKey(args) {
    return makeKey("summary", `${args.scope}:${args.rangeDays}:${args.staleHours}`);
}
function getTrendReadModelKey(args) {
    return makeKey("trend", `${args.scope}:${args.rangeDays}`);
}
function getWarningsReadModelKey(args) {
    return makeKey("warnings", `${args.scope}:${args.rangeDays}:${args.staleHours}`);
}
function getFinanceQueueReadModelKey(args) {
    return makeKey("finance-queue", `${args.scope}:${args.filterHash}:${args.page}`);
}
async function readAnalyticsReadModel(key) {
    const memoryHit = memoryStore.get(key);
    if (memoryHit && Date.now() < memoryHit.staleUntil) {
        return memoryHit.payload;
    }
    if (memoryHit)
        memoryStore.delete(key);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return null;
        const raw = await redis.get(key);
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    catch (err) {
        console.error(`[analytics-v3] read model read failed: ${err?.message || "unknown"}`);
        return null;
    }
}
async function writeAnalyticsReadModel(args) {
    const ttlMs = withJitter(Math.max(1000, args.ttlMs));
    const staleMs = Math.max(ttlMs, Number(process.env.ANALYTICS_V3_READ_MODEL_STALE_MS || 15 * 60000));
    const now = Date.now();
    memoryStore.set(args.key, {
        payload: args.payload,
        expiresAt: now + ttlMs,
        staleUntil: now + ttlMs + staleMs,
    });
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        await redis.set(args.key, JSON.stringify(args.payload), "EX", Math.max(1, Math.floor(ttlMs / 1000)));
    }
    catch (err) {
        console.error(`[analytics-v3] read model write failed: ${err?.message || "unknown"}`);
    }
}
async function clearAnalyticsReadModelBySection(section) {
    for (const key of memoryStore.keys()) {
        if (key.includes(`:analytics:v3:${section}:`)) {
            memoryStore.delete(key);
        }
    }
    try {
        const pattern = `${(0, redis_1.getRedisPrefix)()}:analytics:v3:${section}:*`;
        await deleteByPatternScan(pattern);
    }
    catch (err) {
        console.error(`[analytics-v3] clear section failed: ${err?.message || "unknown"}`);
    }
}
