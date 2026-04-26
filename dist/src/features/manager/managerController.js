"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManagerOverview = getManagerOverview;
exports.listDrivers = listDrivers;
exports.getAnalyticsSummary = getAnalyticsSummary;
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const redis_1 = require("../../config/redis");
const managerAnalytics_1 = require("./managerAnalytics");
const analyticsCache = new Map();
const overviewCache = new Map();
const driversCache = new Map();
function pruneExpired(cache) {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (now >= entry.expiresAt)
            cache.delete(key);
    }
}
const cacheGcTimer = setInterval(() => {
    pruneExpired(analyticsCache);
    pruneExpired(overviewCache);
    pruneExpired(driversCache);
}, 60000);
cacheGcTimer.unref();
function getAnalyticsRedisKey(rawKey) {
    const digest = (0, crypto_1.createHash)("sha1").update(rawKey).digest("hex");
    return `${(0, redis_1.getRedisPrefix)()}:analytics:summary:${digest}`;
}
function getOverviewRedisKey(rawKey) {
    const digest = (0, crypto_1.createHash)("sha1").update(rawKey).digest("hex");
    return `${(0, redis_1.getRedisPrefix)()}:manager:overview:${digest}`;
}
function getDriversRedisKey(rawKey) {
    const digest = (0, crypto_1.createHash)("sha1").update(rawKey).digest("hex");
    return `${(0, redis_1.getRedisPrefix)()}:manager:drivers:${digest}`;
}
function readAnalyticsCacheMemory(key) {
    const hit = analyticsCache.get(key);
    if (!hit)
        return null;
    if (Date.now() >= hit.expiresAt) {
        analyticsCache.delete(key);
        return null;
    }
    return hit.payload;
}
async function readAnalyticsCache(key) {
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (redis) {
            const redisValue = await redis.get(getAnalyticsRedisKey(key));
            if (redisValue) {
                return JSON.parse(redisValue);
            }
        }
    }
    catch (err) {
        console.error(`[analytics-cache] redis read failed: ${err?.message || "unknown"}`);
    }
    return readAnalyticsCacheMemory(key);
}
function writeAnalyticsCacheMemory(key, payload, ttlMs) {
    analyticsCache.set(key, {
        payload,
        expiresAt: Date.now() + ttlMs,
    });
}
async function writeAnalyticsCache(key, payload, ttlMs) {
    writeAnalyticsCacheMemory(key, payload, ttlMs);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
        await redis.set(getAnalyticsRedisKey(key), JSON.stringify(payload), "EX", ttlSec);
    }
    catch (err) {
        console.error(`[analytics-cache] redis write failed: ${err?.message || "unknown"}`);
    }
}
async function getManagerOverview(req, res) {
    try {
        const cacheKey = "overview-v1";
        const cacheTtlMs = Math.min(Math.max(Number(process.env.MANAGER_OVERVIEW_CACHE_TTL_MS || 30000), 5000), 300000);
        const memoryHit = overviewCache.get(cacheKey);
        if (memoryHit && Date.now() < memoryHit.expiresAt) {
            res.setHeader("X-Overview-Cache", "HIT");
            res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
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
                    overviewCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
                    res.setHeader("X-Overview-Cache", "HIT");
                    res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
                    return res.json(payload);
                }
            }
        }
        catch (err) {
            console.error(`[overview-cache] redis read failed: ${err?.message || "unknown"}`);
        }
        const totalOrders = await prismaClient_1.default.order.count();
        const [pending, inTransit, delivered] = await Promise.all([
            prismaClient_1.default.order.count({ where: { status: "pending" } }),
            prismaClient_1.default.order.count({ where: { status: "in_transit" } }),
            prismaClient_1.default.order.count({ where: { status: "delivered" } }),
        ]);
        const paidInvoices = await prismaClient_1.default.invoice.aggregate({
            _sum: { amount: true },
            where: { status: "paid" },
        });
        const payload = {
            totalOrders,
            pending,
            inTransit,
            delivered,
            totalRevenue: paidInvoices._sum.amount || 0,
        };
        overviewCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
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
        const cacheTtlMs = Math.min(Math.max(Number(process.env.MANAGER_DRIVERS_CACHE_TTL_MS || 30000), 5000), 300000);
        const memoryHit = driversCache.get(cacheKey);
        if (memoryHit && Date.now() < memoryHit.expiresAt) {
            res.setHeader("X-Drivers-Cache", "HIT");
            res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
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
                    driversCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
                    res.setHeader("X-Drivers-Cache", "HIT");
                    res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
                    return res.json(payload);
                }
            }
        }
        catch (err) {
            console.error(`[drivers-cache] redis read failed: ${err?.message || "unknown"}`);
        }
        const drivers = await prismaClient_1.default.user.findMany({
            where: {
                role: "driver",
                ...(role === "warehouse"
                    ? warehouseId
                        ? {
                            OR: [
                                { driverType: client_1.DriverType.linehaul },
                                { warehouseId },
                                { warehouseAccesses: { some: { warehouseId } } },
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
        });
        const payload = drivers.map((driver) => {
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
        driversCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
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
async function getAnalyticsSummary(req, res) {
    try {
        const asStringArray = (value) => {
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
        };
        const parseDateStart = (value) => {
            if (typeof value !== "string" || !value.trim())
                return undefined;
            const raw = value.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
                const date = new Date(`${raw}T00:00:00.000Z`);
                return Number.isNaN(date.getTime()) ? undefined : date;
            }
            const date = new Date(raw);
            return Number.isNaN(date.getTime()) ? undefined : date;
        };
        const parseDateEndExclusive = (value) => {
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
        };
        const rangeDays = Number(req.query.rangeDays);
        const staleHours = Number(req.query.staleHours);
        const queueLimit = Number(req.query.queueLimit);
        const queuePage = Number(req.query.queuePage);
        const queuePageSize = Number(req.query.queuePageSize);
        const queueStatuses = asStringArray(req.query.queueStatuses).sort();
        const queueKinds = asStringArray(req.query.queueKinds).sort();
        const queueHolderTypes = asStringArray(req.query.queueHolderTypes).sort();
        const cacheKey = JSON.stringify({
            rangeDays: Number.isFinite(rangeDays) ? rangeDays : null,
            staleHours: Number.isFinite(staleHours) ? staleHours : null,
            queueLimit: Number.isFinite(queueLimit) ? queueLimit : null,
            queuePage: Number.isFinite(queuePage) ? queuePage : null,
            queuePageSize: Number.isFinite(queuePageSize) ? queuePageSize : null,
            queueFrom: typeof req.query.queueFrom === "string" ? req.query.queueFrom : null,
            queueTo: typeof req.query.queueTo === "string" ? req.query.queueTo : null,
            queueStatuses,
            queueKinds,
            queueHolderTypes,
        });
        const cacheTtlMs = Math.min(Math.max(Number(process.env.ANALYTICS_CACHE_TTL_MS || 30000), 5000), 300000);
        const cached = await readAnalyticsCache(cacheKey);
        if (cached) {
            res.setHeader("X-Analytics-Cache", "HIT");
            res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
            return res.json(cached);
        }
        const data = await (0, managerAnalytics_1.getManagerAnalyticsSummary)({
            rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
            staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
            queueLimit: Number.isFinite(queueLimit) ? queueLimit : undefined,
            queuePage: Number.isFinite(queuePage) ? queuePage : undefined,
            queuePageSize: Number.isFinite(queuePageSize) ? queuePageSize : undefined,
            queueFrom: parseDateStart(req.query.queueFrom),
            queueTo: parseDateEndExclusive(req.query.queueTo),
            queueStatuses,
            queueKinds,
            queueHolderTypes,
        });
        await writeAnalyticsCache(cacheKey, data, cacheTtlMs);
        res.setHeader("X-Analytics-Cache", "MISS");
        res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
}
