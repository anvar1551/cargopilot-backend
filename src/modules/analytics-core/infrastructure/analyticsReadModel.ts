import { createHash } from "crypto";
import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../../config/redis";

export type AnalyticsReadSection = "summary" | "trend" | "warnings" | "finance-queue";

type MemoryEntry<T> = {
  expiresAt: number;
  staleUntil: number;
  payload: T;
};

type SectionVersionEntry = {
  value: number;
  expiresAt: number;
};

const ANALYTICS_PREFIX = `${getRedisPrefix()}:analytics:v3:`;
const SECTION_VERSION_TTL_MS = 5_000;
const memoryStore = new Map<string, MemoryEntry<unknown>>();
const sectionVersionMemory = new Map<AnalyticsReadSection, SectionVersionEntry>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (now >= entry.staleUntil) memoryStore.delete(key);
  }
  for (const [section, entry] of sectionVersionMemory.entries()) {
    if (now >= entry.expiresAt) sectionVersionMemory.delete(section);
  }
}, 60_000);
cleanupTimer.unref();

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
  return `${ANALYTICS_PREFIX}${section}:${suffix}`;
}

function getSectionVersionKey(section: AnalyticsReadSection) {
  return `${ANALYTICS_PREFIX}version:${section}`;
}

function digest(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

function parseKey(key: string): { section: AnalyticsReadSection; suffix: string } | null {
  if (!key.startsWith(ANALYTICS_PREFIX)) return null;
  const rest = key.slice(ANALYTICS_PREFIX.length);
  const splitIdx = rest.indexOf(":");
  if (splitIdx <= 0) return null;
  const section = rest.slice(0, splitIdx) as AnalyticsReadSection;
  if (
    section !== "summary" &&
    section !== "trend" &&
    section !== "warnings" &&
    section !== "finance-queue"
  ) {
    return null;
  }
  const suffix = rest.slice(splitIdx + 1);
  return suffix ? { section, suffix } : null;
}

function toVersionedKey(args: { section: AnalyticsReadSection; suffix: string; version: number }) {
  return `${ANALYTICS_PREFIX}${args.section}:v${Math.max(1, args.version)}:${args.suffix}`;
}

async function getSectionVersion(section: AnalyticsReadSection) {
  const mem = sectionVersionMemory.get(section);
  if (mem && Date.now() < mem.expiresAt) return mem.value;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      const fallback = mem?.value ?? 1;
      sectionVersionMemory.set(section, {
        value: fallback,
        expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
      });
      return fallback;
    }
    const raw = await withRedisTimeout("analytics:section-version:get", () =>
      redis.get(getSectionVersionKey(section)),
    );
    const value = Math.max(1, Number(raw || mem?.value || 1));
    sectionVersionMemory.set(section, {
      value,
      expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
    });
    return value;
  } catch (err: any) {
    const fallback = mem?.value ?? 1;
    sectionVersionMemory.set(section, {
      value: fallback,
      expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
    });
    console.error(
      `[analytics-v3] version fallback ${section}: ${err?.message || "unknown"}`,
    );
    return fallback;
  }
}

async function resolveVersionedKey(baseKey: string): Promise<string> {
  const parsed = parseKey(baseKey);
  if (!parsed) return baseKey;
  const version = await getSectionVersion(parsed.section);
  return toVersionedKey({ section: parsed.section, suffix: parsed.suffix, version });
}

function writeMemory<T>(key: string, payload: T, ttlMs: number) {
  const staleMs = Math.max(
    ttlMs,
    Number(process.env.ANALYTICS_V3_READ_MODEL_STALE_MS || 15 * 60_000),
  );
  const now = Date.now();
  memoryStore.set(key, {
    payload,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
  });
}

function readMemory<T>(key: string): { payload: T; isFresh: boolean } | null {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now >= entry.staleUntil) {
    memoryStore.delete(key);
    return null;
  }
  return { payload: entry.payload as T, isFresh: now < entry.expiresAt };
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

export async function readAnalyticsReadModel<T>(baseKey: string): Promise<T | null> {
  const key = await resolveVersionedKey(baseKey);
  const memoryHit = readMemory<T>(key);
  if (memoryHit?.isFresh) {
    return memoryHit.payload;
  }

  try {
    const redis = await getRedisClient();
    if (!redis) {
      return memoryHit?.payload ?? null;
    }
    const raw = await withRedisTimeout("analytics:read-model:get", () => redis.get(key));
    if (!raw) {
      return memoryHit?.payload ?? null;
    }
    const parsed = JSON.parse(raw) as T;
    writeMemory(key, parsed, Math.max(1_000, Number(process.env.ANALYTICS_V3_MEMORY_TTL_MS || 30_000)));
    return parsed;
  } catch (err: any) {
    console.error(`[analytics-v3] read model read failed: ${err?.message || "unknown"}`);
    return memoryHit?.payload ?? null;
  }
}

export async function writeAnalyticsReadModel<T>(args: {
  key: string;
  payload: T;
  ttlMs: number;
}) {
  const ttlMs = withJitter(Math.max(1_000, args.ttlMs));
  const versionedKey = await resolveVersionedKey(args.key);
  writeMemory(versionedKey, args.payload, ttlMs);

  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await withRedisTimeout("analytics:read-model:set", () =>
      redis.set(
        versionedKey,
        JSON.stringify(args.payload),
        "EX",
        Math.max(1, Math.floor(ttlMs / 1000)),
      ),
    );
  } catch (err: any) {
    console.error(`[analytics-v3] read model write failed: ${err?.message || "unknown"}`);
  }
}

export async function readThroughAnalyticsProjection<T>(args: {
  section: AnalyticsReadSection;
  key: string;
  ttlMs: number;
  lockMs?: number;
  buildFromDb: () => Promise<T>;
}): Promise<{ payload: T; cacheHit: boolean }> {
  const immediate = await readAnalyticsReadModel<T>(args.key);
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
  const lockMs = Math.max(500, args.lockMs ?? 4_000);
  const lockKey = `${ANALYTICS_PREFIX}lock:${args.section}:v${version}:${digest(parsed.suffix)}`;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      const payload = await args.buildFromDb();
      await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
      return { payload, cacheHit: false };
    }

    const lockValue = `${Date.now()}-${Math.random()}`;
    const acquired = await withRedisTimeout("analytics:projection:lock", () =>
      redis.set(lockKey, lockValue, "PX", lockMs, "NX"),
    );
    if (acquired) {
      try {
        const secondCheck = await readAnalyticsReadModel<T>(args.key);
        if (secondCheck !== null) {
          return { payload: secondCheck, cacheHit: true };
        }
        const payload = await args.buildFromDb();
        await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
        return { payload, cacheHit: false };
      } finally {
        try {
          const current = await withRedisTimeout("analytics:projection:unlock:get", () =>
            redis.get(lockKey),
          );
          if (current === lockValue) {
            await withRedisTimeout("analytics:projection:unlock:del", () => redis.del(lockKey));
          }
        } catch {
          // ignore unlock errors
        }
      }
    }

    const waitMaxMs = Math.min(
      lockMs,
      Math.max(100, Number(process.env.ANALYTICS_V3_LOCK_WAIT_MS || 800)),
    );
    const started = Date.now();
    while (Date.now() - started < waitMaxMs) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const retry = await readAnalyticsReadModel<T>(args.key);
      if (retry !== null) {
        return { payload: retry, cacheHit: true };
      }
    }

    const payload = await args.buildFromDb();
    await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
    return { payload, cacheHit: false };
  } catch (err: any) {
    console.error(`[analytics-v3] read-through fallback: ${err?.message || "unknown"}`);
    const payload = await args.buildFromDb();
    await writeAnalyticsReadModel({ key: args.key, payload, ttlMs: args.ttlMs });
    return { payload, cacheHit: false };
  }
}

export async function clearAnalyticsReadModelBySection(section: AnalyticsReadSection) {
  for (const key of memoryStore.keys()) {
    if (key.includes(`${ANALYTICS_PREFIX}${section}:`)) {
      memoryStore.delete(key);
    }
  }

  try {
    const redis = await getRedisClient();
    if (!redis) {
      const next = Math.max(1, (sectionVersionMemory.get(section)?.value ?? 1) + 1);
      sectionVersionMemory.set(section, {
        value: next,
        expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
      });
      return;
    }
    const next = await withRedisTimeout("analytics:section-version:incr", () =>
      redis.incr(getSectionVersionKey(section)),
    );
    sectionVersionMemory.set(section, {
      value: Math.max(1, Number(next || 1)),
      expiresAt: Date.now() + SECTION_VERSION_TTL_MS,
    });
  } catch (err: any) {
    console.error(`[analytics-v3] clear section failed: ${err?.message || "unknown"}`);
  }
}
