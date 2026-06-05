type LogLevel = "info" | "warn" | "error";

const scope = "integrations-outbox";
const throttleMap = new Map<string, number>();

function toMessage(message: string, meta?: Record<string, unknown>) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    scope,
    message,
    ...(meta ? { meta } : {}),
  });
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const line = toMessage(message, meta);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export const integrationOutboxLogger = {
  info(message: string, meta?: Record<string, unknown>) {
    log("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    log("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    log("error", message, meta);
  },
  throttledWarn(key: string, message: string, throttleMs: number, meta?: Record<string, unknown>) {
    const now = Date.now();
    const last = throttleMap.get(key) || 0;
    if (now - last < throttleMs) return;
    throttleMap.set(key, now);
    log("warn", message, meta);
  },
  throttledError(key: string, message: string, throttleMs: number, meta?: Record<string, unknown>) {
    const now = Date.now();
    const last = throttleMap.get(key) || 0;
    if (now - last < throttleMs) return;
    throttleMap.set(key, now);
    log("error", message, meta);
  },
};

