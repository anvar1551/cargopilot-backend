import { createHash } from "crypto";
import { getRedisClient, getRedisPrefix } from "../../config/redis";

type CacheEntry<T> = {
  expiresAt: number;
  payload: T;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (now >= entry.expiresAt) memoryCache.delete(key);
  }
}, 60_000);
cleanupTimer.unref();

async function deleteByPatternScan(pattern: string) {
  const redis = await getRedisClient();
  if (!redis) return;

  let cursor = "0";
  do {
    const [nextCursor, keys] = (await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      200,
    )) as [string, string[]];
    cursor = nextCursor;
    if (Array.isArray(keys) && keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== "0");
}

function digestKey(input: string) {
  return createHash("sha1").update(input).digest("hex");
}

function asRedisKey(namespace: string, key: string) {
  return `${getRedisPrefix()}:analytics:v2:${namespace}:${digestKey(key)}`;
}

function asLockKey(namespace: string, key: string) {
  return `${getRedisPrefix()}:analytics:v2:lock:${namespace}:${digestKey(key)}`;
}

function withJitter(ttlMs: number) {
  const jitterPct = Math.min(
    Math.max(Number(process.env.ANALYTICS_V2_CACHE_JITTER_PCT || 0.15), 0),
    0.45,
  );
  const jitter = ttlMs * jitterPct;
  const min = ttlMs - jitter;
  const max = ttlMs + jitter;
  return Math.max(1_000, Math.floor(min + Math.random() * Math.max(1, max - min)));
}

function readMemory<T>(cacheKey: string): T | null {
  const hit = memoryCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    memoryCache.delete(cacheKey);
    return null;
  }
  return hit.payload as T;
}

function writeMemory<T>(cacheKey: string, payload: T, ttlMs: number) {
  memoryCache.set(cacheKey, { payload, expiresAt: Date.now() + ttlMs });
}

export function makeScopeKey(args: {
  role?: string | null;
  warehouseId?: string | null;
  userId?: string | null;
}) {
  if (args.role === "warehouse" && args.warehouseId) {
    return `warehouse:${args.warehouseId}`;
  }
  return `role:${args.role || "manager"}`;
}

export async function invalidateNamespaceCaches(namespace: string) {
  try {
    const pattern = `${getRedisPrefix()}:analytics:v2:${namespace}:*`;
    await deleteByPatternScan(pattern);
  } catch (err: any) {
    console.error(`[analytics-v2] invalidate ${namespace} failed: ${err?.message || "unknown"}`);
  }

  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${namespace}:`)) {
      memoryCache.delete(key);
    }
  }
}

export async function getOrComputeCached<T>(args: {
  namespace: string;
  key: string;
  ttlMs: number;
  lockMs?: number;
  compute: () => Promise<T>;
}): Promise<{ payload: T; cacheHit: boolean }> {
  const memoryKey = `${args.namespace}:${args.key}`;
  const memoryHit = readMemory<T>(memoryKey);
  if (memoryHit) {
    return { payload: memoryHit, cacheHit: true };
  }

  const ttlMs = withJitter(Math.max(1_000, args.ttlMs));
  const lockMs = Math.max(500, args.lockMs ?? 4_000);
  const redisDataKey = asRedisKey(args.namespace, args.key);
  const redisLockKey = asLockKey(args.namespace, args.key);

  try {
    const redis = await getRedisClient();
    if (!redis) {
      const payload = await args.compute();
      writeMemory(memoryKey, payload, ttlMs);
      return { payload, cacheHit: false };
    }

    const redisHit = await redis.get(redisDataKey);
    if (redisHit) {
      const payload = JSON.parse(redisHit) as T;
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
      } finally {
        const current = await redis.get(redisLockKey);
        if (current === lockValue) {
          await redis.del(redisLockKey);
        }
      }
    }

    const configuredWaitMs = Math.max(
      100,
      Number(process.env.ANALYTICS_V2_CACHE_LOCK_WAIT_MS || 800),
    );
    const waitMaxMs = Math.min(configuredWaitMs, lockMs);
    const started = Date.now();
    while (Date.now() - started < waitMaxMs) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const retryHit = await redis.get(redisDataKey);
      if (retryHit) {
        const payload = JSON.parse(retryHit) as T;
        writeMemory(memoryKey, payload, ttlMs);
        return { payload, cacheHit: true };
      }
    }

    const payload = await args.compute();
    const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
    await redis.set(redisDataKey, JSON.stringify(payload), "EX", ttlSec);
    writeMemory(memoryKey, payload, ttlMs);
    return { payload, cacheHit: false };
  } catch (err: any) {
    console.error(`[analytics-v2] cache fallback compute: ${err?.message || "unknown"}`);
    const payload = await args.compute();
    writeMemory(memoryKey, payload, ttlMs);
    return { payload, cacheHit: false };
  }
}

