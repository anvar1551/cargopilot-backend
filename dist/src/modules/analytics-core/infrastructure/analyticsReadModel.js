"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSummaryReadModelKey = getSummaryReadModelKey;
exports.getTrendReadModelKey = getTrendReadModelKey;
exports.getWarningsReadModelKey = getWarningsReadModelKey;
exports.getFinanceQueueReadModelKey = getFinanceQueueReadModelKey;
exports.readAnalyticsReadModel = readAnalyticsReadModel;
exports.writeAnalyticsReadModel = writeAnalyticsReadModel;
exports.readThroughAnalyticsProjection = readThroughAnalyticsProjection;
exports.clearAnalyticsReadModelBySection = clearAnalyticsReadModelBySection;
const crypto_1 = require("crypto");
const redis_1 = require("../../../config/redis");
const ANALYTICS_PREFIX = `${(0, redis_1.getRedisPrefix)()}:analytics:v3:`;
const SECTION_VERSION_TTL_MS = 5000;
const memoryStore = new Map();
const sectionVersionMemory = new Map();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryStore.entries()) {
        if (now >= entry.staleUntil)
            memoryStore.delete(key);
    }
    for (const [section, entry] of sectionVersionMemory.entries()) {
        if (now >= entry.expiresAt)
            sectionVersionMemory.delete(section);
    }
}, 60000);
cleanupTimer.unref();
function withJitter(ttlMs) {
    const jitterPct = Math.min(Math.max(Number(process.env.ANALYTICS_V3_CACHE_JITTER_PCT || 0.15), 0), 0.45);
    const jitter = ttlMs * jitterPct;
    const min = ttlMs - jitter;
    const max = ttlMs + jitter;
    return Math.max(1000, Math.floor(min + Math.random() * Math.max(1, max - min)));
}
function makeKey(section, suffix) {
    return `${ANALYTICS_PREFIX}${section}:${suffix}`;
}
function getSectionVersionKey(section) {
    return `${ANALYTICS_PREFIX}version:${section}`;
}
function digest(value) {
    return (0, crypto_1.createHash)("sha1").update(value).digest("hex");
}
function parseKey(key) {
    if (!key.startsWith(ANALYTICS_PREFIX))
        return null;
    const rest = key.slice(ANALYTICS_PREFIX.length);
    const splitIdx = rest.indexOf(":");
    if (splitIdx <= 0)
        return null;
    const section = rest.slice(0, splitIdx);
    if (section !== "summary" &&
        section !== "trend" &&
        section !== "warnings" &&
        section !== "finance-queue") {
        return null;
    }
    const suffix = rest.slice(splitIdx + 1);
    return suffix ? { section, suffix } : null;
}
function toVersionedKey(args) {
    return `${ANALYTICS_PREFIX}${args.section}:v${Math.max(1, args.version)}:${args.suffix}`;
}
async function getSectionVersion(section) {
    const mem = sectionVersionMemory.get(section);
    if (mem && Date.now() < mem.expiresAt)
        return mem.value;
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis) {
            const fallback = mem?.value ?? 1;
            sectionVersionMemory.set(section, {
                value: fallback,
                expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
            });
            return fallback;
        }
        const raw = await (0, redis_1.withRedisTimeout)("analytics:section-version:get", () => redis.get(getSectionVersionKey(section)));
        const value = Math.max(1, Number(raw || mem?.value || 1));
        sectionVersionMemory.set(section, {
            value,
            expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
        });
        return value;
    }
    catch (err) {
        const fallback = mem?.value ?? 1;
        sectionVersionMemory.set(section, {
            value: fallback,
            expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
        });
        console.error(`[analytics-v3] version fallback ${section}: ${err?.message || "unknown"}`);
        return fallback;
    }
}
async function resolveVersionedKey(baseKey) {
    const parsed = parseKey(baseKey);
    if (!parsed)
        return baseKey;
    const version = await getSectionVersion(parsed.section);
    return toVersionedKey({ section: parsed.section, suffix: parsed.suffix, version });
}
function writeMemory(key, payload, ttlMs) {
    const staleMs = Math.max(ttlMs, Number(process.env.ANALYTICS_V3_READ_MODEL_STALE_MS || 15 * 60000));
    const now = Date.now();
    memoryStore.set(key, {
        payload,
        expiresAt: now + ttlMs,
        staleUntil: now + ttlMs + staleMs,
    });
}
function readMemory(key) {
    const entry = memoryStore.get(key);
    if (!entry)
        return null;
    const now = Date.now();
    if (now >= entry.staleUntil) {
        memoryStore.delete(key);
        return null;
    }
    return { payload: entry.payload, isFresh: now < entry.expiresAt };
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
async function readAnalyticsReadModel(baseKey) {
    const key = await resolveVersionedKey(baseKey);
    const memoryHit = readMemory(key);
    if (memoryHit?.isFresh) {
        return memoryHit.payload;
    }
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis) {
            return memoryHit?.payload ?? null;
        }
        const raw = await (0, redis_1.withRedisTimeout)("analytics:read-model:get", () => redis.get(key));
        if (!raw) {
            return memoryHit?.payload ?? null;
        }
        const parsed = JSON.parse(raw);
        writeMemory(key, parsed, Math.max(1000, Number(process.env.ANALYTICS_V3_MEMORY_TTL_MS || 30000)));
        return parsed;
    }
    catch (err) {
        console.error(`[analytics-v3] read model read failed: ${err?.message || "unknown"}`);
        return memoryHit?.payload ?? null;
    }
}
async function writeAnalyticsReadModel(args) {
    const ttlMs = withJitter(Math.max(1000, args.ttlMs));
    const versionedKey = await resolveVersionedKey(args.key);
    writeMemory(versionedKey, args.payload, ttlMs);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        await (0, redis_1.withRedisTimeout)("analytics:read-model:set", () => redis.set(versionedKey, JSON.stringify(args.payload), "EX", Math.max(1, Math.floor(ttlMs / 1000))));
    }
    catch (err) {
        console.error(`[analytics-v3] read model write failed: ${err?.message || "unknown"}`);
    }
}
async function readThroughAnalyticsProjection(args) {
    const immediate = await readAnalyticsReadModel(args.key);
    if (immediate !== null) {
        return { payload: immediate, cacheHit: true };
    }
    const parsed = parseKey(args.key);
    if (!parsed) {
        const payload = await args.buildFromDb();
        await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
        return { payload, cacheHit: false };
    }
    const version = await getSectionVersion(args.section);
    const lockMs = Math.max(500, args.lockMs ?? 4000);
    const lockKey = `${ANALYTICS_PREFIX}lock:${args.section}:v${version}:${digest(parsed.suffix)}`;
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis) {
            const payload = await args.buildFromDb();
            await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
            return { payload, cacheHit: false };
        }
        const lockValue = `${Date.now()}-${Math.random()}`;
        const acquired = await (0, redis_1.withRedisTimeout)("analytics:projection:lock", () => redis.set(lockKey, lockValue, "PX", lockMs, "NX"));
        if (acquired) {
            try {
                const secondCheck = await readAnalyticsReadModel(args.key);
                if (secondCheck !== null) {
                    return { payload: secondCheck, cacheHit: true };
                }
                const payload = await args.buildFromDb();
                await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
                return { payload, cacheHit: false };
            }
            finally {
                try {
                    const current = await (0, redis_1.withRedisTimeout)("analytics:projection:unlock:get", () => redis.get(lockKey));
                    if (current === lockValue) {
                        await (0, redis_1.withRedisTimeout)("analytics:projection:unlock:del", () => redis.del(lockKey));
                    }
                }
                catch {
                    // ignore unlock errors
                }
            }
        }
        const waitMaxMs = Math.min(lockMs, Math.max(100, Number(process.env.ANALYTICS_V3_LOCK_WAIT_MS || 800)));
        const started = Date.now();
        while (Date.now() - started < waitMaxMs) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            const retry = await readAnalyticsReadModel(args.key);
            if (retry !== null) {
                return { payload: retry, cacheHit: true };
            }
        }
        const payload = await args.buildFromDb();
        await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
        return { payload, cacheHit: false };
    }
    catch (err) {
        console.error(`[analytics-v3] read-through fallback: ${err?.message || "unknown"}`);
        const payload = await args.buildFromDb();
        await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
        return { payload, cacheHit: false };
    }
}
async function clearAnalyticsReadModelBySection(section) {
    for (const key of memoryStore.keys()) {
        if (key.includes(`${ANALYTICS_PREFIX}${section}:`)) {
            memoryStore.delete(key);
        }
    }
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis) {
            const next = Math.max(1, (sectionVersionMemory.get(section)?.value ?? 1) + 1);
            sectionVersionMemory.set(section, {
                value: next,
                expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
            });
            return;
        }
        const next = await (0, redis_1.withRedisTimeout)("analytics:section-version:incr", () => redis.incr(getSectionVersionKey(section)));
        sectionVersionMemory.set(section, {
            value: Math.max(1, Number(next || 1)),
            expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
        });
    }
    catch (err) {
        console.error(`[analytics-v3] clear section failed: ${err?.message || "unknown"}`);
    }
}
