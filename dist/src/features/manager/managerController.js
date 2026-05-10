"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManagerOverview = getManagerOverview;
exports.listDrivers = listDrivers;
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const redis_1 = require("../../config/redis");
const analyticsV2Realtime_1 = require("./analyticsV2Realtime");
const analyticsV2_1 = require("./analyticsV2");
const overviewCache = new Map();
const driversCache = new Map();
const overviewBuilds = new Map();
const driverBuilds = new Map();
function pruneExpired(cache) {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (now >= entry.staleUntil)
            cache.delete(key);
    }
}
const cacheGcTimer = setInterval(() => {
    pruneExpired(overviewCache);
    pruneExpired(driversCache);
}, 60000);
cacheGcTimer.unref();
function getOverviewRedisKey(rawKey) {
    const digest = (0, crypto_1.createHash)("sha1").update(rawKey).digest("hex");
    return `${(0, redis_1.getRedisPrefix)()}:manager:overview:${digest}`;
}
function getDriversRedisKey(rawKey) {
    const digest = (0, crypto_1.createHash)("sha1").update(rawKey).digest("hex");
    return `${(0, redis_1.getRedisPrefix)()}:manager:drivers:${digest}`;
}
function clearManagerOverviewCache() {
    overviewCache.clear();
    void (0, redis_1.getRedisClient)()
        .then((redis) => redis?.del(getOverviewRedisKey("overview-v1")))
        .catch((err) => {
        console.error(`[overview-cache] redis clear failed: ${err?.message || "unknown"}`);
    });
}
function writeOverviewMemory(key, payload, ttlMs) {
    const staleMs = Math.max(ttlMs, Number(process.env.MANAGER_OVERVIEW_STALE_MS || 10 * 60000));
    const now = Date.now();
    overviewCache.set(key, {
        payload,
        expiresAt: now + ttlMs,
        staleUntil: now + ttlMs + staleMs,
    });
}
function writeDriversMemory(key, payload, ttlMs) {
    const staleMs = Math.max(ttlMs, Number(process.env.MANAGER_DRIVERS_STALE_MS || 15 * 60000));
    const now = Date.now();
    driversCache.set(key, {
        payload,
        expiresAt: now + ttlMs,
        staleUntil: now + ttlMs + staleMs,
    });
}
async function buildManagerOverviewPayload(req) {
    const summary = await (0, analyticsV2_1.getAnalyticsSummaryV2)({
        rangeDays: Math.max(7, Math.min(180, Number(process.env.ANALYTICS_V3_DEFAULT_RANGE_DAYS || 30))),
        scope: {
            role: req.user?.role ?? "manager",
            warehouseId: req.user?.warehouseId ?? null,
            userId: req.user?.id ?? null,
        },
    });
    const summaryPayload = summary.payload;
    return {
        totalOrders: summaryPayload.overview.totalOrders,
        pending: summaryPayload.operations.pendingOrders,
        inTransit: summaryPayload.operations.inTransitOrders,
        delivered: summaryPayload.overview.deliveredInRange,
        totalRevenue: summaryPayload.finance.invoicedPaidAmount,
        overdueOpenOrders: summaryPayload.sla.overdueOpenOrders,
        dueSoonOpenOrders: summaryPayload.sla.dueSoonOpenOrders,
        staleOpenOrders: summaryPayload.operations.staleOpenOrders,
        exceptionOpenOrders: summaryPayload.overview.exceptionOpenOrders,
        slaRiskOrders: summaryPayload.sla.overdueOpenOrders +
            summaryPayload.operations.staleOpenOrders +
            summaryPayload.overview.exceptionOpenOrders,
    };
}
async function buildDriverListPayload(args) {
    const drivers = await prismaClient_1.default.user.findMany({
        where: {
            role: "driver",
            ...(args.role === "warehouse"
                ? args.warehouseId
                    ? {
                        OR: [
                            { driverType: client_1.DriverType.linehaul },
                            { warehouseId: args.warehouseId },
                            { warehouseAccesses: { some: { warehouseId: args.warehouseId } } },
                        ],
                    }
                    : { id: "__no_matching_driver__" }
                : {}),
        },
        select: {
            id: true,
            name: true,
            email: true,
            warehouseId: true,
            driverType: true,
            warehouseAccesses: {
                select: {
                    warehouseId: true,
                },
            },
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(Number(process.env.MANAGER_DRIVERS_LIST_LIMIT || 500), 20), 1000),
    });
    return drivers.map((driver) => {
        const warehouseIds = Array.from(new Set([
            driver.warehouseId ?? null,
            ...driver.warehouseAccesses.map((item) => item.warehouseId),
        ].filter((value) => Boolean(value))));
        return {
            id: driver.id,
            name: driver.name,
            email: driver.email,
            warehouseId: driver.warehouseId ?? null,
            warehouseIds,
            driverType: driver.driverType === client_1.DriverType.linehaul ? "linehaul" : "local",
        };
    });
}
(0, analyticsV2Realtime_1.subscribeAnalyticsInvalidation)((event) => {
    if (event.keys.includes("summary") ||
        event.keys.includes("trend") ||
        event.reason === "order_mutation" ||
        event.reason === "worker_rebuild") {
        clearManagerOverviewCache();
    }
});
async function getManagerOverview(req, res) {
    try {
        const cacheKey = "overview-v1";
        const cacheTtlMs = Math.min(Math.max(Number(process.env.MANAGER_OVERVIEW_CACHE_TTL_MS || 60000), 5000), 300000);
        const memoryHit = overviewCache.get(cacheKey);
        if (memoryHit && Date.now() < memoryHit.expiresAt) {
            res.setHeader("X-Overview-Cache", "HIT");
            res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
            return res.json(memoryHit.payload);
        }
        if (memoryHit && Date.now() < memoryHit.staleUntil) {
            res.setHeader("X-Overview-Cache", "STALE");
            res.setHeader("Cache-Control", "private, max-age=5");
            if (!overviewBuilds.has(cacheKey)) {
                const build = buildManagerOverviewPayload(req)
                    .then(async (payload) => {
                    writeOverviewMemory(cacheKey, payload, cacheTtlMs);
                    const redis = await (0, redis_1.getRedisClient)();
                    if (redis) {
                        await redis.set(getOverviewRedisKey(cacheKey), JSON.stringify(payload), "EX", Math.max(1, Math.floor(cacheTtlMs / 1000)));
                    }
                    return payload;
                })
                    .catch((err) => {
                    console.error(`[overview-cache] background refresh failed: ${err?.message || "unknown"}`);
                    return memoryHit.payload;
                })
                    .finally(() => {
                    overviewBuilds.delete(cacheKey);
                });
                overviewBuilds.set(cacheKey, build);
            }
            return res.json(memoryHit.payload);
        }
        if (memoryHit)
            overviewCache.delete(cacheKey);
        try {
            const redis = await (0, redis_1.getRedisClient)();
            if (redis) {
                const redisHit = await redis.get(getOverviewRedisKey(cacheKey));
                if (redisHit) {
                    const payload = JSON.parse(redisHit);
                    writeOverviewMemory(cacheKey, payload, cacheTtlMs);
                    res.setHeader("X-Overview-Cache", "HIT");
                    res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
                    return res.json(payload);
                }
            }
        }
        catch (err) {
            console.error(`[overview-cache] redis read failed: ${err?.message || "unknown"}`);
        }
        let build = overviewBuilds.get(cacheKey);
        if (!build) {
            build = buildManagerOverviewPayload(req).finally(() => {
                overviewBuilds.delete(cacheKey);
            });
            overviewBuilds.set(cacheKey, build);
        }
        const payload = await build;
        writeOverviewMemory(cacheKey, payload, cacheTtlMs);
        try {
            const redis = await (0, redis_1.getRedisClient)();
            if (redis) {
                await redis.set(getOverviewRedisKey(cacheKey), JSON.stringify(payload), "EX", Math.max(1, Math.floor(cacheTtlMs / 1000)));
            }
        }
        catch (err) {
            console.error(`[overview-cache] redis write failed: ${err?.message || "unknown"}`);
        }
        res.setHeader("X-Overview-Cache", "MISS");
        res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
        return res.json(payload);
    }
    catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
async function listDrivers(req, res) {
    try {
        const role = req.user?.role;
        const warehouseId = req.user?.warehouseId ?? null;
        const cacheKey = JSON.stringify({
            role: role ?? null,
            warehouseId,
        });
        const cacheTtlMs = Math.min(Math.max(Number(process.env.MANAGER_DRIVERS_CACHE_TTL_MS || 120000), 5000), 300000);
        const memoryHit = driversCache.get(cacheKey);
        if (memoryHit && Date.now() < memoryHit.expiresAt) {
            res.setHeader("X-Drivers-Cache", "HIT");
            res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
            return res.json(memoryHit.payload);
        }
        if (memoryHit && Date.now() < memoryHit.staleUntil) {
            res.setHeader("X-Drivers-Cache", "STALE");
            res.setHeader("Cache-Control", "private, max-age=5");
            if (!driverBuilds.has(cacheKey)) {
                const build = buildDriverListPayload({ role, warehouseId })
                    .then(async (payload) => {
                    writeDriversMemory(cacheKey, payload, cacheTtlMs);
                    const redis = await (0, redis_1.getRedisClient)();
                    if (redis) {
                        await redis.set(getDriversRedisKey(cacheKey), JSON.stringify(payload), "EX", Math.max(1, Math.floor(cacheTtlMs / 1000)));
                    }
                    return payload;
                })
                    .catch((err) => {
                    console.error(`[drivers-cache] background refresh failed: ${err?.message || "unknown"}`);
                    return memoryHit.payload;
                })
                    .finally(() => {
                    driverBuilds.delete(cacheKey);
                });
                driverBuilds.set(cacheKey, build);
            }
            return res.json(memoryHit.payload);
        }
        if (memoryHit)
            driversCache.delete(cacheKey);
        try {
            const redis = await (0, redis_1.getRedisClient)();
            if (redis) {
                const redisHit = await redis.get(getDriversRedisKey(cacheKey));
                if (redisHit) {
                    const payload = JSON.parse(redisHit);
                    writeDriversMemory(cacheKey, payload, cacheTtlMs);
                    res.setHeader("X-Drivers-Cache", "HIT");
                    res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
                    return res.json(payload);
                }
            }
        }
        catch (err) {
            console.error(`[drivers-cache] redis read failed: ${err?.message || "unknown"}`);
        }
        let build = driverBuilds.get(cacheKey);
        if (!build) {
            build = buildDriverListPayload({ role, warehouseId }).finally(() => {
                driverBuilds.delete(cacheKey);
            });
            driverBuilds.set(cacheKey, build);
        }
        const payload = await build;
        writeDriversMemory(cacheKey, payload, cacheTtlMs);
        try {
            const redis = await (0, redis_1.getRedisClient)();
            if (redis) {
                await redis.set(getDriversRedisKey(cacheKey), JSON.stringify(payload), "EX", Math.max(1, Math.floor(cacheTtlMs / 1000)));
            }
        }
        catch (err) {
            console.error(`[drivers-cache] redis write failed: ${err?.message || "unknown"}`);
        }
        res.setHeader("X-Drivers-Cache", "MISS");
        res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
        return res.json(payload);
    }
    catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
