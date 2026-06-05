type LogLevel = "debug" | "info" | "warn" | "error" | "off";

function readString(keys: string[], fallback: string) {
  for (const key of keys) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return value;
  }
  return fallback;
}

function readNumber(keys: string[], fallback: number) {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw == null || raw === "") continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readBool(keys: string[], fallback: boolean) {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw == null || raw === "") continue;
    const normalized = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function clampInt(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export const analyticsConfig = {
  logLevel: (() => {
    const value = readString(["ANALYTICS_LOG_LEVEL"], "warn").toLowerCase();
    return ["debug", "info", "warn", "error", "off"].includes(value)
      ? (value as LogLevel)
      : ("warn" as LogLevel);
  })(),

  cache: {
    summaryTtlMs: clampInt(
      readNumber(["ANALYTICS_CACHE_TTL_MS", "ANALYTICS_V2_SUMMARY_TTL_MS"], 60_000),
      5_000,
      300_000,
    ),
    trendTtlMs: clampInt(
      readNumber(["ANALYTICS_CACHE_TTL_MS", "ANALYTICS_V2_TREND_TTL_MS"], 60_000),
      5_000,
      300_000,
    ),
    warningsTtlMs: clampInt(
      readNumber(["ANALYTICS_CACHE_TTL_MS", "ANALYTICS_V2_WARNINGS_TTL_MS"], 60_000),
      5_000,
      300_000,
    ),
    financeQueueTtlMs: clampInt(
      readNumber(["ANALYTICS_CACHE_TTL_MS", "ANALYTICS_V2_FINANCE_QUEUE_TTL_MS"], 60_000),
      5_000,
      300_000,
    ),
    jitterPct: clampNumber(
      readNumber(["ANALYTICS_CACHE_JITTER_PCT", "ANALYTICS_V3_CACHE_JITTER_PCT"], 0.15),
      0,
      0.45,
    ),
    memoryTtlMs: clampInt(
      readNumber(["ANALYTICS_MEMORY_TTL_MS", "ANALYTICS_V3_MEMORY_TTL_MS"], 30_000),
      1_000,
      300_000,
    ),
    staleMs: clampInt(
      readNumber(["ANALYTICS_READ_MODEL_STALE_MS", "ANALYTICS_V3_READ_MODEL_STALE_MS"], 15 * 60_000),
      10_000,
      60 * 60_000,
    ),
    lockWaitMs: clampInt(
      readNumber(["ANALYTICS_LOCK_WAIT_MS", "ANALYTICS_V3_LOCK_WAIT_MS"], 800),
      100,
      4_000,
    ),
  },

  defaults: {
    rangeDays: clampInt(
      readNumber(["ANALYTICS_DEFAULT_RANGE_DAYS", "ANALYTICS_V3_DEFAULT_RANGE_DAYS"], 30),
      7,
      180,
    ),
    queuePageSize: clampInt(
      readNumber(["ANALYTICS_DEFAULT_QUEUE_PAGE_SIZE", "ANALYTICS_V3_DEFAULT_QUEUE_PAGE_SIZE"], 20),
      5,
      200,
    ),
    staleHours: clampInt(
      readNumber(["ANALYTICS_STALE_HOURS", "ANALYTICS_WARMUP_STALE_HOURS"], 48),
      6,
      720,
    ),
  },

  stream: {
    replayBufferLimit: clampInt(
      readNumber(["ANALYTICS_STREAM_REPLAY_BUFFER", "ANALYTICS_V2_STREAM_REPLAY_BUFFER"], 1000),
      100,
      10_000,
    ),
    replayMaxEvents: clampInt(
      readNumber(["ANALYTICS_STREAM_REPLAY_MAX_EVENTS", "ANALYTICS_V2_STREAM_REPLAY_MAX_EVENTS"], 250),
      10,
      2_000,
    ),
    heartbeatMs: clampInt(
      readNumber(["ANALYTICS_STREAM_HEARTBEAT_MS", "ANALYTICS_V2_STREAM_HEARTBEAT_MS"], 25_000),
      10_000,
      120_000,
    ),
    refreshMs: (() => {
      const value = readNumber(["ANALYTICS_STREAM_REFRESH_MS", "ANALYTICS_V2_STREAM_REFRESH_MS"], 0);
      return value > 0 ? clampInt(value, 30_000, 10 * 60_000) : 0;
    })(),
  },

  warmup: {
    enabled: readBool(["ANALYTICS_WARMUP_ENABLED"], true),
    intervalMs: clampInt(readNumber(["ANALYTICS_WARMUP_INTERVAL_MS"], 240_000), 60_000, 60 * 60_000),
    startupDelayMs: clampInt(readNumber(["ANALYTICS_WARMUP_STARTUP_DELAY_MS"], 30_000), 0, 15 * 60_000),
    inApi: readBool(["ANALYTICS_WARMUP_IN_API"], true),
  },

  slaPolicyDbEnabled: readBool(["ANALYTICS_SLA_POLICY_DB_ENABLED"], false),

  outbox: {
    enabled: readBool(["ANALYTICS_OUTBOX_ENABLED"], true),
    inApi: readBool(["ANALYTICS_OUTBOX_IN_API"], false),
    leaderLockEnabled: readBool(["ANALYTICS_OUTBOX_LEADER_LOCK_ENABLED"], true),
    batchSize: clampInt(readNumber(["ANALYTICS_OUTBOX_BATCH_SIZE"], 100), 10, 500),
    idleMs: clampInt(readNumber(["ANALYTICS_OUTBOX_IDLE_MS"], 1500), 250, 60_000),
    lockKey: readString(["ANALYTICS_OUTBOX_LOCK_KEY"], ""),
    lockTtlSec: clampInt(readNumber(["ANALYTICS_OUTBOX_LOCK_TTL_SEC"], 30), 10, 300),
    consumerId: readString(["ANALYTICS_OUTBOX_CONSUMER"], ""),
  },

  worker: {
    group: readString(["ANALYTICS_WORKER_GROUP"], "cp_analytics_workers"),
    consumer: readString(
      ["ANALYTICS_WORKER_CONSUMER"],
      `${process.env.HOSTNAME || "analytics"}-${process.pid}`,
    ),
    dedupeTtlSec: clampInt(
      readNumber(["ANALYTICS_WORKER_DEDUPE_TTL_SEC"], 24 * 60 * 60),
      60,
      7 * 24 * 60 * 60,
    ),
    flushDebounceMs: clampInt(readNumber(["ANALYTICS_WORKER_FLUSH_DEBOUNCE_MS"], 750), 250, 10_000),
    healthLogMs: clampInt(readNumber(["ANALYTICS_WORKER_HEALTH_LOG_MS"], 60_000), 10_000, 15 * 60_000),
    healthLogEnabled: readBool(["ANALYTICS_WORKER_HEALTH_LOG_ENABLED"], false),
    leaderLockKey: readString(["ANALYTICS_WORKER_LEADER_LOCK_KEY"], ""),
    leaderLockTtlSec: clampInt(readNumber(["ANALYTICS_WORKER_LEADER_LOCK_TTL_SEC"], 30), 10, 300),
    inProcess: (() => {
      const value = String(process.env.ANALYTICS_WORKER_IN_PROCESS ?? "").trim().toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      return process.env.NODE_ENV !== "production";
    })(),
  },
};
