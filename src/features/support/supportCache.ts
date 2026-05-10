import { createHash } from "crypto";
import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../config/redis";

type CacheEntry<T> = {
  expiresAt: number;
  staleUntil: number;
  payload: T;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();
const refreshInFlight = new Map<string, Promise<void>>();
const versionCache = new Map<string, { value: number; expiresAt: number }>();
const VERSION_TTL_MS = 5000;

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

function versionKey(namespace: "list" | "detail" | "summary") {
  return `${getRedisPrefix()}:support:version:${namespace}`;
}

async function getNamespaceVersion(namespace: "list" | "detail" | "summary") {
  const mem = versionCache.get(namespace);
  if (mem && Date.now() < mem.expiresAt) return mem.value;
  try {
    const redis = await getRedisClient();
    if (!redis) return mem?.value ?? 1;
    const raw = await withRedisTimeout("support:version:get", () => redis.get(versionKey(namespace)));
    const parsed = Math.max(1, Number(raw || mem?.value || 1));
    versionCache.set(namespace, { value: parsed, expiresAt: Date.now() + VERSION_TTL_MS });
    return parsed;
  } catch (err: any) {
    const fallback = mem?.value ?? 1;
    versionCache.set(namespace, { value: fallback, expiresAt: Date.now() + VERSION_TTL_MS });
    console.error(`[support] namespace version fallback ${namespace}: ${err?.message || "unknown"}`);
    return fallback;
  }
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

export async function invalidateSupportCache(ticketId?: string | null) {
  try {
    const redis = await getRedisClient();
    if (redis) {
      const namespaces: Array<"list" | "summary" | "detail"> = ["list", "summary", "detail"];
      for (const ns of namespaces) {
        const next = await withRedisTimeout("support:version:incr", () => redis.incr(versionKey(ns)));
        versionCache.set(ns, { value: Math.max(1, Number(next || 1)), expiresAt: Date.now() + VERSION_TTL_MS });
      }
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
  const namespaceVersion = await getNamespaceVersion(args.namespace);
  const versionedKey = `v${namespaceVersion}:${args.key}`;
  const memKey = memoryKey(args.namespace, versionedKey);
  const memHit = readMemory<T>(memKey);
  if (memHit?.isFresh) return { payload: memHit.payload, cacheHit: true };

  const ttlMs = withJitter(args.ttlMs);
  if (memHit) {
    refreshMemoryInBackground(memKey, ttlMs, args.compute);
    return { payload: memHit.payload, cacheHit: true };
  }

  const redisDataKey = dataKey(args.namespace, versionedKey);
  const redisLockKey = lockKey(args.namespace, versionedKey);
  const lockMs = 2500;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      const payload = await args.compute();
      writeMemory(memKey, payload, ttlMs);
      return { payload, cacheHit: false };
    }

    const redisHit = await withRedisTimeout("support:cache:get", () => redis.get(redisDataKey));
    if (redisHit) {
      const payload = JSON.parse(redisHit) as T;
      writeMemory(memKey, payload, ttlMs);
      return { payload, cacheHit: true };
    }

    const lockValue = `${Date.now()}-${Math.random()}`;
    const locked = await withRedisTimeout("support:lock:set", () =>
      redis.set(redisLockKey, lockValue, "PX", lockMs, "NX"));
    if (locked) {
      try {
        const payload = await args.compute();
        writeMemory(memKey, payload, ttlMs);
        try {
          await withRedisTimeout("support:cache:set", () =>
            redis.set(redisDataKey, JSON.stringify(payload), "EX", Math.max(1, Math.floor(ttlMs / 1000))));
        } catch (err: any) {
          console.error(`[support] redis cache set skipped: ${err?.message || "unknown"}`);
        }
        return { payload, cacheHit: false };
      } finally {
        try {
          const current = await withRedisTimeout("support:lock:get", () => redis.get(redisLockKey));
          if (current === lockValue) await withRedisTimeout("support:lock:del", () => redis.del(redisLockKey));
        } catch (err: any) {
          console.error(`[support] lock release skipped: ${err?.message || "unknown"}`);
        }
      }
    }

    const started = Date.now();
    const waitMs = Math.min(
      lockMs,
      Math.max(100, Number(process.env.SUPPORT_CACHE_LOCK_WAIT_MS || 350)),
    );
    while (Date.now() - started < waitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const retryHit = await withRedisTimeout("support:cache:retry-get", () => redis.get(redisDataKey));
      if (retryHit) {
        const payload = JSON.parse(retryHit) as T;
        writeMemory(memKey, payload, ttlMs);
        return { payload, cacheHit: true };
      }
    }

    const payload = await args.compute();
    writeMemory(memKey, payload, ttlMs);
    try {
      await withRedisTimeout("support:cache:late-set", () =>
        redis.set(redisDataKey, JSON.stringify(payload), "EX", Math.max(1, Math.floor(ttlMs / 1000))));
    } catch (err: any) {
      console.error(`[support] redis cache late-set skipped: ${err?.message || "unknown"}`);
    }
    return { payload, cacheHit: false };
  } catch (err: any) {
    console.error(`[support] cache fallback compute: ${err?.message || "unknown"}`);
    const payload = await args.compute();
    writeMemory(memKey, payload, ttlMs);
    return { payload, cacheHit: false };
  }
}
