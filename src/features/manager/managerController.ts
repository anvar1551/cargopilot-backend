import { Request, Response } from "express";
import { DriverType } from "@prisma/client";
import { createHash } from "crypto";
import prisma from "../../config/prismaClient";
import { getRedisClient, getRedisPrefix } from "../../config/redis";
import { getManagerAnalyticsSummary } from "./managerAnalytics";

type AnalyticsSummaryPayload = Awaited<ReturnType<typeof getManagerAnalyticsSummary>>;
type ManagerOverviewPayload = {
  totalOrders: number;
  pending: number;
  inTransit: number;
  delivered: number;
  totalRevenue: number;
};
type DriverListPayload = Array<{
  id: string;
  name: string;
  email: string;
  warehouseId: string | null;
  warehouseIds: string[];
  driverType: "linehaul" | "local";
}>;
const analyticsCache = new Map<
  string,
  { expiresAt: number; payload: AnalyticsSummaryPayload }
>();
const overviewCache = new Map<
  string,
  { expiresAt: number; payload: ManagerOverviewPayload }
>();
const driversCache = new Map<
  string,
  { expiresAt: number; payload: DriverListPayload }
>();

function pruneExpired<T>(cache: Map<string, { expiresAt: number; payload: T }>) {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now >= entry.expiresAt) cache.delete(key);
  }
}

const cacheGcTimer = setInterval(() => {
  pruneExpired(analyticsCache);
  pruneExpired(overviewCache);
  pruneExpired(driversCache);
}, 60_000);
cacheGcTimer.unref();

function getAnalyticsRedisKey(rawKey: string) {
  const digest = createHash("sha1").update(rawKey).digest("hex");
  return `${getRedisPrefix()}:analytics:summary:${digest}`;
}
function getOverviewRedisKey(rawKey: string) {
  const digest = createHash("sha1").update(rawKey).digest("hex");
  return `${getRedisPrefix()}:manager:overview:${digest}`;
}
function getDriversRedisKey(rawKey: string) {
  const digest = createHash("sha1").update(rawKey).digest("hex");
  return `${getRedisPrefix()}:manager:drivers:${digest}`;
}

function readAnalyticsCacheMemory(key: string) {
  const hit = analyticsCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    analyticsCache.delete(key);
    return null;
  }
  return hit.payload;
}

async function readAnalyticsCache(
  key: string,
): Promise<AnalyticsSummaryPayload | null> {
  try {
    const redis = await getRedisClient();
    if (redis) {
      const redisValue = await redis.get(getAnalyticsRedisKey(key));
      if (redisValue) {
        return JSON.parse(redisValue) as AnalyticsSummaryPayload;
      }
    }
  } catch (err: any) {
    console.error(`[analytics-cache] redis read failed: ${err?.message || "unknown"}`);
  }
  return readAnalyticsCacheMemory(key);
}

function writeAnalyticsCacheMemory(
  key: string,
  payload: AnalyticsSummaryPayload,
  ttlMs: number,
) {
  analyticsCache.set(key, {
    payload,
    expiresAt: Date.now() + ttlMs,
  });
}

async function writeAnalyticsCache(
  key: string,
  payload: AnalyticsSummaryPayload,
  ttlMs: number,
) {
  writeAnalyticsCacheMemory(key, payload, ttlMs);
  try {
    const redis = await getRedisClient();
    if (!redis) return;

    const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
    await redis.set(getAnalyticsRedisKey(key), JSON.stringify(payload), "EX", ttlSec);
  } catch (err: any) {
    console.error(`[analytics-cache] redis write failed: ${err?.message || "unknown"}`);
  }
}

export async function getManagerOverview(req: Request, res: Response) {
  try {
    const cacheKey = "overview-v1";
    const cacheTtlMs = Math.min(
      Math.max(Number(process.env.MANAGER_OVERVIEW_CACHE_TTL_MS || 30_000), 5_000),
      300_000,
    );

    const memoryHit = overviewCache.get(cacheKey);
    if (memoryHit && Date.now() < memoryHit.expiresAt) {
      res.setHeader("X-Overview-Cache", "HIT");
      res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
      return res.json(memoryHit.payload);
    }
    if (memoryHit) overviewCache.delete(cacheKey);

    try {
      const redis = await getRedisClient();
      if (redis) {
        const redisHit = await redis.get(getOverviewRedisKey(cacheKey));
        if (redisHit) {
          const payload = JSON.parse(redisHit) as ManagerOverviewPayload;
          overviewCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
          res.setHeader("X-Overview-Cache", "HIT");
          res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
          return res.json(payload);
        }
      }
    } catch (err: any) {
      console.error(`[overview-cache] redis read failed: ${err?.message || "unknown"}`);
    }

    const totalOrders = await prisma.order.count();
    const [pending, inTransit, delivered] = await Promise.all([
      prisma.order.count({ where: { status: "pending" } }),
      prisma.order.count({ where: { status: "in_transit" } }),
      prisma.order.count({ where: { status: "delivered" } }),
    ]);
    const paidInvoices = await prisma.invoice.aggregate({
      _sum: { amount: true },
      where: { status: "paid" },
    });

    const payload: ManagerOverviewPayload = {
      totalOrders,
      pending,
      inTransit,
      delivered,
      totalRevenue: paidInvoices._sum.amount || 0,
    };

    overviewCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
    try {
      const redis = await getRedisClient();
      if (redis) {
        await redis.set(
          getOverviewRedisKey(cacheKey),
          JSON.stringify(payload),
          "EX",
          Math.max(1, Math.floor(cacheTtlMs / 1000)),
        );
      }
    } catch (err: any) {
      console.error(`[overview-cache] redis write failed: ${err?.message || "unknown"}`);
    }

    res.setHeader("X-Overview-Cache", "MISS");
    res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
    return res.json(payload);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

export async function listDrivers(req: Request, res: Response) {
  try {
    const role = req.user?.role;
    const warehouseId = req.user?.warehouseId ?? null;
    const cacheKey = JSON.stringify({
      role: role ?? null,
      warehouseId,
    });
    const cacheTtlMs = Math.min(
      Math.max(Number(process.env.MANAGER_DRIVERS_CACHE_TTL_MS || 30_000), 5_000),
      300_000,
    );

    const memoryHit = driversCache.get(cacheKey);
    if (memoryHit && Date.now() < memoryHit.expiresAt) {
      res.setHeader("X-Drivers-Cache", "HIT");
      res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
      return res.json(memoryHit.payload);
    }
    if (memoryHit) driversCache.delete(cacheKey);

    try {
      const redis = await getRedisClient();
      if (redis) {
        const redisHit = await redis.get(getDriversRedisKey(cacheKey));
        if (redisHit) {
          const payload = JSON.parse(redisHit) as DriverListPayload;
          driversCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
          res.setHeader("X-Drivers-Cache", "HIT");
          res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
          return res.json(payload);
        }
      }
    } catch (err: any) {
      console.error(`[drivers-cache] redis read failed: ${err?.message || "unknown"}`);
    }

    const drivers = await prisma.user.findMany({
      where: {
        role: "driver",
        ...(role === "warehouse"
          ? warehouseId
            ? {
                OR: [
                  { driverType: DriverType.linehaul },
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

    const payload: DriverListPayload = drivers.map((driver) => {
      const warehouseIds = Array.from(
        new Set(
          [
            driver.warehouseId ?? null,
            ...driver.warehouseAccesses.map((item) => item.warehouseId),
          ].filter((value): value is string => Boolean(value)),
        ),
      );

      return {
        id: driver.id,
        name: driver.name,
        email: driver.email,
        warehouseId: driver.warehouseId ?? null,
        warehouseIds,
        driverType: driver.driverType === DriverType.linehaul ? "linehaul" : "local",
      };
    });

    driversCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheTtlMs });
    try {
      const redis = await getRedisClient();
      if (redis) {
        await redis.set(
          getDriversRedisKey(cacheKey),
          JSON.stringify(payload),
          "EX",
          Math.max(1, Math.floor(cacheTtlMs / 1000)),
        );
      }
    } catch (err: any) {
      console.error(`[drivers-cache] redis write failed: ${err?.message || "unknown"}`);
    }

    res.setHeader("X-Drivers-Cache", "MISS");
    res.setHeader("Cache-Control", `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
    return res.json(payload);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

export async function getAnalyticsSummary(req: Request, res: Response) {
  try {
    const asStringArray = (value: unknown): string[] => {
      if (!value) return [];
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
    const parseDateStart = (value: unknown): Date | undefined => {
      if (typeof value !== "string" || !value.trim()) return undefined;
      const raw = value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}T00:00:00.000Z`);
        return Number.isNaN(date.getTime()) ? undefined : date;
      }
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? undefined : date;
    };
    const parseDateEndExclusive = (value: unknown): Date | undefined => {
      if (typeof value !== "string" || !value.trim()) return undefined;
      const raw = value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime())) return undefined;
        date.setUTCDate(date.getUTCDate() + 1);
        return date;
      }
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return undefined;
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
    const cacheTtlMs = Math.min(
      Math.max(Number(process.env.ANALYTICS_CACHE_TTL_MS || 30000), 5000),
      300000,
    );

    const cached = await readAnalyticsCache(cacheKey);
    if (cached) {
      res.setHeader("X-Analytics-Cache", "HIT");
      res.setHeader(
        "Cache-Control",
        `private, max-age=${Math.floor(cacheTtlMs / 1000)}`,
      );
      return res.json(cached);
    }

    const data = await getManagerAnalyticsSummary({
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
    res.setHeader(
      "Cache-Control",
      `private, max-age=${Math.floor(cacheTtlMs / 1000)}`,
    );
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
