import { DriverType } from "@prisma/client";
import { createHash } from "crypto";
import prisma from "../../../config/prismaClient";
import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../../config/redis";
import { getAnalyticsSummaryV2 } from "../../analytics-core/application/analyticsV2";
import { analyticsConfig } from "../../analytics-core/config/analyticsConfig";
import { analyticsLogger } from "../../analytics-core/config/analyticsLogger";
import type { AppUser } from "../../../types/app-user";

export type ManagerOverviewPayload = {
  totalOrders: number;
  pending: number;
  inTransit: number;
  delivered: number;
  totalRevenue: number | null;
  overdueOpenOrders: number;
  dueSoonOpenOrders: number;
  staleOpenOrders: number;
  exceptionOpenOrders: number;
  slaRiskOrders: number;
};

export type DriverListPayload = Array<{
  id: string;
  name: string;
  email: string;
  warehouseId: string | null;
  warehouseIds: string[];
  driverType: "linehaul" | "local";
}>;

type ManagerActor = {
  id?: string | null;
  roleCodes?: string[];
  permissionCodes?: string[];
  warehouseId?: string | null;
};

function hasPermission(actor: ManagerActor, permission: string) {
  return Array.isArray(actor.permissionCodes) && actor.permissionCodes.includes(permission);
}

const driversCache = new Map<
  string,
  { expiresAt: number; staleUntil: number; payload: DriverListPayload }
>();
const driverBuilds = new Map<string, Promise<DriverListPayload>>();

function pruneExpired<T>(cache: Map<string, { expiresAt: number; staleUntil: number; payload: T }>) {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now >= entry.staleUntil) cache.delete(key);
  }
}

const cacheGcTimer = setInterval(() => {
  pruneExpired(driversCache);
}, 60_000);
cacheGcTimer.unref();

function getDriversRedisKey(rawKey: string) {
  const digest = createHash("sha1").update(rawKey).digest("hex");
  return `${getRedisPrefix()}:manager:drivers:${digest}`;
}

function writeDriversMemory(key: string, payload: DriverListPayload, ttlMs: number) {
  const staleMs = Math.max(ttlMs, Number(process.env.MANAGER_DRIVERS_STALE_MS || 15 * 60_000));
  const now = Date.now();
  driversCache.set(key, {
    payload,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
  });
}

async function buildManagerOverviewPayload(actor: AppUser): Promise<ManagerOverviewPayload> {
  const summary = await getAnalyticsSummaryV2({
    rangeDays: analyticsConfig.defaults.rangeDays,
    actor,
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
    slaRiskOrders:
      summaryPayload.sla.overdueOpenOrders +
      summaryPayload.operations.staleOpenOrders +
      summaryPayload.overview.exceptionOpenOrders,
  };
}

async function buildDriverListPayload(args: {
  actor: ManagerActor;
  warehouseId?: string | null;
}): Promise<DriverListPayload> {
  const warehouseScoped =
    Boolean(args.actor.warehouseId) && !hasPermission(args.actor, "drivers.manage");
  const drivers = await prisma.user.findMany({
    where: {
      driverType: { not: null },
      ...(warehouseScoped
        ? args.warehouseId
          ? {
              OR: [
                { driverType: DriverType.linehaul },
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
}

export async function getManagerOverviewPayload(args: { actor: AppUser }): Promise<{ payload: ManagerOverviewPayload; cache: "MISS"; ttlMs: number }> {
  return { payload: await buildManagerOverviewPayload(args.actor), cache: "MISS", ttlMs: 0 };
}

export async function listDriversPayload(args: {
  actor: ManagerActor;
}): Promise<{ payload: DriverListPayload; cache: "HIT" | "MISS" | "STALE"; ttlMs: number }> {
  const warehouseScoped =
    Boolean(args.actor.warehouseId) && !hasPermission(args.actor, "drivers.manage");
  const warehouseId = args.actor.warehouseId ?? null;
  const cacheKey = JSON.stringify({ warehouseScoped, warehouseId });
  const cacheTtlMs = Math.min(
    Math.max(Number(process.env.MANAGER_DRIVERS_CACHE_TTL_MS || 120_000), 5_000),
    300_000,
  );

  const memoryHit = driversCache.get(cacheKey);
  if (memoryHit && Date.now() < memoryHit.expiresAt) {
    return { payload: memoryHit.payload, cache: "HIT", ttlMs: cacheTtlMs };
  }
  if (memoryHit && Date.now() < memoryHit.staleUntil) {
    if (!driverBuilds.has(cacheKey)) {
      const build = buildDriverListPayload({ actor: args.actor, warehouseId })
        .then(async (payload) => {
          writeDriversMemory(cacheKey, payload, cacheTtlMs);
          const redis = await getRedisClient();
          if (redis) {
            await withRedisTimeout("manager:drivers:bg-set", () =>
              redis.set(
                getDriversRedisKey(cacheKey),
                JSON.stringify(payload),
                "EX",
                Math.max(1, Math.floor(cacheTtlMs / 1000)),
              ),
            );
          }
          return payload;
        })
        .catch((err: any) => {
          analyticsLogger.throttledWarn(
            "manager-drivers-background-refresh-failed",
            "manager drivers background refresh failed",
            { error: err, throttleMs: 60_000 },
          );
          return memoryHit.payload;
        })
        .finally(() => {
          driverBuilds.delete(cacheKey);
        });
      driverBuilds.set(cacheKey, build);
    }
    return { payload: memoryHit.payload, cache: "STALE", ttlMs: cacheTtlMs };
  }
  if (memoryHit) driversCache.delete(cacheKey);

  try {
    const redis = await getRedisClient();
    if (redis) {
      const redisHit = await withRedisTimeout("manager:drivers:get", () =>
        redis.get(getDriversRedisKey(cacheKey)),
      );
      if (redisHit) {
        const payload = JSON.parse(redisHit) as DriverListPayload;
        writeDriversMemory(cacheKey, payload, cacheTtlMs);
        return { payload, cache: "HIT", ttlMs: cacheTtlMs };
      }
    }
  } catch (err: any) {
    analyticsLogger.throttledWarn(
      "manager-drivers-redis-read-failed",
      "manager drivers redis read failed",
      { error: err, throttleMs: 60_000 },
    );
  }

  let build = driverBuilds.get(cacheKey);
  if (!build) {
    build = buildDriverListPayload({ actor: args.actor, warehouseId }).finally(() => {
      driverBuilds.delete(cacheKey);
    });
    driverBuilds.set(cacheKey, build);
  }

  const payload = await build;
  writeDriversMemory(cacheKey, payload, cacheTtlMs);

  try {
    const redis = await getRedisClient();
    if (redis) {
      await withRedisTimeout("manager:drivers:set", () =>
        redis.set(
          getDriversRedisKey(cacheKey),
          JSON.stringify(payload),
          "EX",
          Math.max(1, Math.floor(cacheTtlMs / 1000)),
        ),
      );
    }
  } catch (err: any) {
    analyticsLogger.throttledWarn(
      "manager-drivers-redis-write-failed",
      "manager drivers redis write failed",
      { error: err, throttleMs: 60_000 },
    );
  }

  return { payload, cache: "MISS", ttlMs: cacheTtlMs };
}
