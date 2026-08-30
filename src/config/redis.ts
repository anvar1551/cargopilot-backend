// Modernized: ioredis + Hash storage + Redis Streams
import Redis from "ioredis";

type RedisClient = Redis;
type RedisHealthSnapshot = {
  enabled: boolean;
  sharedClientStatus: string;
  cooldownActive: boolean;
  cooldownRemainingMs: number;
  lastUnavailableReason: string | null;
  stats: {
    connectAttempts: number;
    connectFailures: number;
    cooldownHits: number;
    operationTimeouts: number;
    notReadyErrors: number;
    recycledClients: number;
  };
};

let redisClient: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;
let hasLoggedDisabled = false;
let lastRecycleAt = 0;
let recycleInFlight = false;
let redisUnavailableUntil = 0;
let lastUnavailableReason = "";
const redisStats = {
  connectAttempts: 0,
  connectFailures: 0,
  cooldownHits: 0,
  operationTimeouts: 0,
  notReadyErrors: 0,
  recycledClients: 0,
};

export function isRedisEnabled() {
  return process.env.REDIS_ENABLED !== "false" && Boolean(process.env.REDIS_URL);
}

export function getRedisPrefix() {
  return process.env.REDIS_PREFIX?.trim() || "cargopilot";
}

function parseRedisConfig(redisUrl: string) {
  try {
    const normalized = redisUrl.includes("://") ? redisUrl : `redis://${redisUrl}`;
    const parsed = new URL(normalized);
    const host = parsed.hostname || "127.0.0.1";
    const port = Number(parsed.port || "6379");
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? parsed.password : undefined;
    const dbRaw = parsed.pathname?.replace("/", "").trim();
    const db = dbRaw ? Number(dbRaw) : undefined;
    const tls = parsed.protocol === "rediss:" ? {} : undefined;

    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : 6379,
      username,
      password,
      db: Number.isFinite(db) && (db as number) >= 0 ? (db as number) : undefined,
      tls,
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: 6379,
      username: undefined as string | undefined,
      password: undefined as string | undefined,
      db: undefined as number | undefined,
      tls: undefined as Record<string, never> | undefined,
    };
  }
}

export function createRedisClient(
  options?: {
    connectTimeout?: number;
    enableOfflineQueue?: boolean;
    maxRetriesPerRequest?: number | null;
    lazyConnect?: boolean;
    commandTimeout?: number | null;
  },
) {
  if (!isRedisEnabled()) return null;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  const { host, port, username, password, db, tls } = parseRedisConfig(url);
  const hasCommandTimeoutOverride = Object.prototype.hasOwnProperty.call(
    options ?? {},
    "commandTimeout",
  );
  const commandTimeoutRaw = hasCommandTimeoutOverride
    ? options?.commandTimeout
    : Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 1200);
  const commandTimeout =
    typeof commandTimeoutRaw === "number" &&
    Number.isFinite(commandTimeoutRaw) &&
    commandTimeoutRaw > 0
      ? Math.max(100, Math.trunc(commandTimeoutRaw))
      : undefined;

  const client = new Redis({
    host,
    port,
    username,
    password,
    db,
    tls,
    connectTimeout: Math.max(500, options?.connectTimeout ?? 3000),
    enableOfflineQueue: options?.enableOfflineQueue ?? false,
    maxRetriesPerRequest: options?.maxRetriesPerRequest ?? 1,
    lazyConnect: options?.lazyConnect ?? false,
    ...(commandTimeout ? { commandTimeout } : {}),
    retryStrategy: (t) => Math.min(t * 200, 2000),
  });

  client.on("ready", () => {
    console.log("[redis] ready");
  });
  client.on("error", (err) => {
    console.error(`[redis] error: ${err?.message || "unknown"}`);
  });
  client.on("reconnecting", () => {
    console.warn("[redis] reconnecting");
  });

  return client;
}

function buildRedisClient() {
  return createRedisClient({
    connectTimeout: Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000)),
    commandTimeout: Math.max(100, Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 1200)),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
}

function getReadyWaitMs() {
  return Math.max(200, Number(process.env.REDIS_READY_WAIT_MS || 1500));
}

function markRedisUnavailable(reason: string, cooldownMs = Math.max(500, Number(process.env.REDIS_UNAVAILABLE_COOLDOWN_MS || 5000))) {
  redisUnavailableUntil = Date.now() + cooldownMs;
  lastUnavailableReason = reason;
}

async function waitForReady(client: RedisClient, timeoutMs: number) {
  if (client.status === "ready") return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(client.status === "ready");
    }, timeoutMs);

    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(client.status === "ready");
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("end", onEnd);
      if (timer) clearTimeout(timer);
      timer = null;
    };

    client.once("ready", onReady);
    client.once("error", onError);
    client.once("end", onEnd);
  });
}

export async function getRedisClient() {
  if (!isRedisEnabled()) {
    if (!hasLoggedDisabled) {
      hasLoggedDisabled = true;
      console.warn("[redis] disabled, using in-memory fallback");
    }
    return null;
  }

  if (Date.now() < redisUnavailableUntil) {
    redisStats.cooldownHits += 1;
    return null;
  }

  if (redisClient?.status === "ready") return redisClient;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      redisStats.connectAttempts += 1;
      if (!redisClient) {
        redisClient = buildRedisClient();
      }
      if (!redisClient) return null;

      if (redisClient.status === "wait") {
        await redisClient.connect().catch(() => undefined);
      }

      if (redisClient.status !== "ready") {
        const ready = await waitForReady(redisClient, getReadyWaitMs());
        if (!ready) {
          await recycleRedisClient("connect-not-ready");
          markRedisUnavailable("connect-not-ready");
          return null;
        }
      }

      if (redisClient.status !== "ready") {
        markRedisUnavailable(`status-${redisClient.status}`);
        return null;
      }

      return redisClient;
    } catch (err: any) {
      redisStats.connectFailures += 1;
      console.error(
        `[redis] init failed, using in-memory fallback: ${err?.message || "unknown"}`,
      );
      markRedisUnavailable(err?.message || "init-failed");
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

export async function withRedisTimeout<T>(
  operation: string,
  work: () => Promise<T>,
  timeoutMs = Math.max(50, Number(process.env.REDIS_OP_TIMEOUT_MS || 300)),
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const guardedWork = work().catch(async (err: any) => {
    const message = String(err?.message || "").toLowerCase();
    if (
      message.includes("stream isn't writeable") ||
      message.includes("connection is closed") ||
      message.includes("not ready")
    ) {
      redisStats.notReadyErrors += 1;
      await recycleRedisClient(`not-ready:${operation}`);
      markRedisUnavailable(`not-ready:${operation}`);
    }
    throw err;
  });
  try {
    return await Promise.race([
      guardedWork,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          redisStats.operationTimeouts += 1;
          reject(new Error(`[redis] ${operation} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recycleRedisClient(reason: string) {
  if (recycleInFlight) return;
  const now = Date.now();
  if (now - lastRecycleAt < 3_000) return;
  if (!redisClient) return;

  recycleInFlight = true;
  lastRecycleAt = now;
  const current = redisClient;
  redisClient = null;
  connectPromise = null;

  try {
    current.removeAllListeners();
    await current.quit();
  } catch {
    current.disconnect();
  } finally {
    redisStats.recycledClients += 1;
    recycleInFlight = false;
    markRedisUnavailable(reason);
    console.warn(`[redis] recycled client after ${reason}`);
  }
}

export async function getRedisHealthSnapshot(): Promise<RedisHealthSnapshot> {
  const now = Date.now();
  const cooldownRemainingMs = Math.max(0, redisUnavailableUntil - now);
  return {
    enabled: isRedisEnabled(),
    sharedClientStatus: redisClient?.status || "none",
    cooldownActive: cooldownRemainingMs > 0,
    cooldownRemainingMs,
    lastUnavailableReason: lastUnavailableReason || null,
    stats: {
      connectAttempts: redisStats.connectAttempts,
      connectFailures: redisStats.connectFailures,
      cooldownHits: redisStats.cooldownHits,
      operationTimeouts: redisStats.operationTimeouts,
      notReadyErrors: redisStats.notReadyErrors,
      recycledClients: redisStats.recycledClients,
    },
  };
}
