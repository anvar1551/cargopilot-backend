import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../config/redis";

export type AnalyticsReadSection = "summary" | "trend" | "warnings" | "finance-queue";

type MemoryEntry<T> = {
  expiresAt: number;
  staleUntil: number;
  payload: T;
};

const memoryStore = new Map<string, MemoryEntry<unknown>>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (now >= entry.staleUntil) memoryStore.delete(key);
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

function withJitter(ttlMs: number) {
  const jitterPct = Math.min(
    Math.max(Number(process.env.ANALYTICS_V3_CACHE_JITTER_PCT || 0.15), 0),
    0.45,
  );
  const jitter = ttlMs * jitterPct;
  const min = ttlMs - jitter;
  const max = ttlMs + jitter;
  return Math.max(1_000, Math.floor(min + Math.random() * Math.max(1, max - min)));
}

function makeKey(section: AnalyticsReadSection, suffix: string) {
  return `${getRedisPrefix()}:analytics:v3:${section}:${suffix}`;
}

export function getSummaryReadModelKey(args: {
  scope: string;
  rangeDays: number;
  staleHours: number;
}) {
  return makeKey("summary", `${args.scope}:${args.rangeDays}:${args.staleHours}`);
}

export function getTrendReadModelKey(args: { scope: string; rangeDays: number }) {
  return makeKey("trend", `${args.scope}:${args.rangeDays}`);
}

export function getWarningsReadModelKey(args: {
  scope: string;
  rangeDays: number;
  staleHours: number;
}) {
  return makeKey("warnings", `${args.scope}:${args.rangeDays}:${args.staleHours}`);
}

export function getFinanceQueueReadModelKey(args: {
  scope: string;
  filterHash: string;
  page: number;
}) {
  return makeKey("finance-queue", `${args.scope}:${args.filterHash}:${args.page}`);
}

export async function readAnalyticsReadModel<T>(key: string): Promise<T | null> {
  const memoryHit = memoryStore.get(key);
  if (memoryHit && Date.now() < memoryHit.staleUntil) {
    return memoryHit.payload as T;
  }
  if (memoryHit) memoryStore.delete(key);

  try {
    const redis = await getRedisClient();
    if (!redis) return null;
    const raw = await withRedisTimeout("analytics:read-model:get", () => redis.get(key));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err: any) {
    console.error(`[analytics-v3] read model read failed: ${err?.message || "unknown"}`);
    return null;
  }
}

export async function writeAnalyticsReadModel<T>(args: {
  key: string;
  payload: T;
  ttlMs: number;
}) {
  const ttlMs = withJitter(Math.max(1_000, args.ttlMs));
  const staleMs = Math.max(
    ttlMs,
    Number(process.env.ANALYTICS_V3_READ_MODEL_STALE_MS || 15 * 60_000),
  );
  const now = Date.now();
  memoryStore.set(args.key, {
    payload: args.payload,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
  });

  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await withRedisTimeout("analytics:read-model:set", () =>
      redis.set(args.key, JSON.stringify(args.payload), "EX", Math.max(1, Math.floor(ttlMs / 1000))),
    );
  } catch (err: any) {
    console.error(`[analytics-v3] read model write failed: ${err?.message || "unknown"}`);
  }
}

export async function clearAnalyticsReadModelBySection(section: AnalyticsReadSection) {
  for (const key of memoryStore.keys()) {
    if (key.includes(`:analytics:v3:${section}:`)) {
      memoryStore.delete(key);
    }
  }

  try {
    const pattern = `${getRedisPrefix()}:analytics:v3:${section}:*`;
    await deleteByPatternScan(pattern);
  } catch (err: any) {
    console.error(`[analytics-v3] clear section failed: ${err?.message || "unknown"}`);
  }
}
