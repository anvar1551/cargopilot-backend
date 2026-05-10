import { createHash } from "crypto";
import { getRedisClient, getRedisPrefix } from "../../config/redis";

type CacheEntry<T> = {
  expiresAt: number;
  staleUntil: number;
  payload: T;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();
const refreshInFlight = new Map<string, Promise<void>>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (now >= entry.staleUntil) memoryCache.delete(key);
  }
}, 60_000);
cleanupTimer.unref();

function digest(input: string) {
  return createHash("sha1").update(input).digest("hex");
}

function dataKey(namespace: string, key: string) {
  return `${getRedisPrefix()}:support:${namespace}:${digest(key)}`;
}

function lockKey(namespace: string, key: string) {
  return `${getRedisPrefix()}:support:lock:${namespace}:${digest(key)}`;
}

function memoryKey(namespace: string, key: string) {
  return `${namespace}:${key}`;
}

function withJitter(ttlMs: number) {
  const jitter = ttlMs * 0.15;
  return Math.max(1000, Math.floor(ttlMs - jitter + Math.random() * jitter * 2));
}

function readMemory<T>(key: string): { payload: T; isFresh: boolean } | null {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  const now = Date.now();
  if (now >= hit.staleUntil) {
    memoryCache.delete(key);
    return null;
  }
  return { payload: hit.payload as T, isFresh: now < hit.expiresAt };
}

function writeMemory<T>(key: string, payload: T, ttlMs: number) {
  const staleMs = Math.max(ttlMs, Number(process.env.SUPPORT_CACHE_STALE_MS || 10 * 60_000));
  const now = Date.now();
  memoryCache.set(key, {
    payload,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
  });
}

function refreshMemoryInBackground<T>(
  cacheKey: string,
  ttlMs: number,
  compute: () => Promise<T>,
) {
  if (refreshInFlight.has(cacheKey)) return;
  const task = compute()
    .then((payload) => {
      writeMemory(cacheKey, payload, ttlMs);
    })
    .catch((err: any) => {
      console.error(`[support] stale refresh failed: ${err?.message || "unknown"}`);
    })
    .finally(() => {
      refreshInFlight.delete(cacheKey);
    });
  refreshInFlight.set(cacheKey, task);
}

async function deleteRedisPattern(pattern: string) {
  const redis = await getRedisClient();
  if (!redis) return;

  let cursor = "0";
  do {
    const [nextCursor, keys] = (await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      250,
    )) as [string, string[]];
    cursor = nextCursor;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
}

export async function invalidateSupportCache(ticketId?: string | null) {
  try {
    await deleteRedisPattern(`${getRedisPrefix()}:support:list:*`);
    await deleteRedisPattern(`${getRedisPrefix()}:support:summary:*`);
    if (ticketId) {
      await deleteRedisPattern(`${getRedisPrefix()}:support:detail:${digest(ticketId)}*`);
    } else {
      await deleteRedisPattern(`${getRedisPrefix()}:support:detail:*`);
    }
  } catch (err: any) {
    console.error(`[support] cache invalidation failed: ${err?.message || "unknown"}`);
  }

  for (const key of memoryCache.keys()) {
    if (
      key.startsWith("list:") ||
      key.startsWith("summary:") ||
      key.startsWith("detail:")
    ) {
      memoryCache.delete(key);
    }
  }
}

export async function getOrComputeSupportCached<T>(args: {
  namespace: "list" | "detail" | "summary";
  key: string;
  ttlMs: number;
  compute: () => Promise<T>;
}): Promise<{ payload: T; cacheHit: boolean }> {
  const memKey = memoryKey(args.namespace, args.key);
  const memHit = readMemory<T>(memKey);
  if (memHit?.isFresh) return { payload: memHit.payload, cacheHit: true };

  const ttlMs = withJitter(args.ttlMs);
  if (memHit) {
    refreshMemoryInBackground(memKey, ttlMs, args.compute);
    return { payload: memHit.payload, cacheHit: true };
  }

  const redisDataKey = dataKey(args.namespace, args.key);
  const redisLockKey = lockKey(args.namespace, args.key);
  const lockMs = 2500;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      const payload = await args.compute();
      writeMemory(memKey, payload, ttlMs);
      return { payload, cacheHit: false };
    }

    const redisHit = await redis.get(redisDataKey);
    if (redisHit) {
      const payload = JSON.parse(redisHit) as T;
      writeMemory(memKey, payload, ttlMs);
      return { payload, cacheHit: true };
    }

    const lockValue = `${Date.now()}-${Math.random()}`;
    const locked = await redis.set(redisLockKey, lockValue, "PX", lockMs, "NX");
    if (locked) {
      try {
        const payload = await args.compute();
        await redis.set(redisDataKey, JSON.stringify(payload), "EX", Math.max(1, Math.floor(ttlMs / 1000)));
        writeMemory(memKey, payload, ttlMs);
        return { payload, cacheHit: false };
      } finally {
        const current = await redis.get(redisLockKey);
        if (current === lockValue) await redis.del(redisLockKey);
      }
    }

    const started = Date.now();
    const waitMs = Math.min(
      lockMs,
      Math.max(100, Number(process.env.SUPPORT_CACHE_LOCK_WAIT_MS || 350)),
    );
    while (Date.now() - started < waitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const retryHit = await redis.get(redisDataKey);
      if (retryHit) {
        const payload = JSON.parse(retryHit) as T;
        writeMemory(memKey, payload, ttlMs);
        return { payload, cacheHit: true };
      }
    }

    const payload = await args.compute();
    await redis.set(redisDataKey, JSON.stringify(payload), "EX", Math.max(1, Math.floor(ttlMs / 1000)));
    writeMemory(memKey, payload, ttlMs);
    return { payload, cacheHit: false };
  } catch (err: any) {
    console.error(`[support] cache fallback compute: ${err?.message || "unknown"}`);
    const payload = await args.compute();
    writeMemory(memKey, payload, ttlMs);
    return { payload, cacheHit: false };
  }
}
