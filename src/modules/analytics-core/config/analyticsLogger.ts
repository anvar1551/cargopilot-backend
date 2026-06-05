import { analyticsConfig } from "./analyticsConfig";

type Level = "debug" | "info" | "warn" | "error";

const levelWeight: Record<Level | "off", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
};

const throttleState = new Map<string, { lastAt: number; suppressed: number }>();

function enabled(level: Level) {
  return levelWeight[level] >= levelWeight[analyticsConfig.logLevel];
}

function normalizeError(err: unknown) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
    };
  }
  return { message: String(err) };
}

function write(level: Level, message: string, meta?: Record<string, unknown>, error?: unknown) {
  if (!enabled(level)) return;
  const payload = {
    ts: new Date().toISOString(),
    scope: "analytics",
    level,
    message,
    ...(meta ? { meta } : {}),
    ...(error ? { error: normalizeError(error) } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function throttled(level: Level, key: string, message: string, args?: {
  throttleMs?: number;
  meta?: Record<string, unknown>;
  error?: unknown;
}) {
  const throttleMs = Math.max(1000, args?.throttleMs ?? 30_000);
  const now = Date.now();
  const current = throttleState.get(key);
  if (current && now - current.lastAt < throttleMs) {
    current.suppressed += 1;
    throttleState.set(key, current);
    return;
  }

  const suppressed = current?.suppressed ?? 0;
  throttleState.set(key, { lastAt: now, suppressed: 0 });
  write(level, message, { ...(args?.meta || {}), suppressed }, args?.error);
}

export const analyticsLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, error?: unknown, meta?: Record<string, unknown>) =>
    write("error", message, meta, error),
  throttledWarn: (
    key: string,
    message: string,
    args?: { throttleMs?: number; meta?: Record<string, unknown>; error?: unknown },
  ) => throttled("warn", key, message, args),
  throttledError: (
    key: string,
    message: string,
    args?: { throttleMs?: number; meta?: Record<string, unknown>; error?: unknown },
  ) => throttled("error", key, message, args),
};

