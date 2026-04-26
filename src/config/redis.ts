// Modernized: ioredis + Hash storage + Redis Streams
import Redis from "ioredis";

type RedisClient = Redis;

let redisClient: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;
let hasLoggedDisabled = false;

export function isRedisEnabled() {
  return process.env.REDIS_ENABLED !== "false" && Boolean(process.env.REDIS_URL);
}

export function getRedisPrefix() {
  return process.env.REDIS_PREFIX?.trim() || "cargopilot";
}

function parseRedisConfig(redisUrl: string) {
  try {
    const parsed = new URL(redisUrl);
    const host = parsed.hostname || "127.0.0.1";
    const port = Number(parsed.port || "6379");
    const password = parsed.password ? parsed.password : undefined;

    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : 6379,
      password,
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: 6379,
      password: undefined as string | undefined,
    };
  }
}

function buildRedisClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const { host, port, password } = parseRedisConfig(url);
  const client = new Redis({
    host,
    port,
    password,
    connectTimeout: 3000,
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

export async function getRedisClient() {
  if (!isRedisEnabled()) {
    if (!hasLoggedDisabled) {
      hasLoggedDisabled = true;
      console.warn("[redis] disabled, using in-memory fallback");
    }
    return null;
  }

  if (redisClient) return redisClient;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      if (!redisClient) {
        redisClient = buildRedisClient();
      }
      if (!redisClient) return null;
      return redisClient;
    } catch (err: any) {
      console.error(
        `[redis] init failed, using in-memory fallback: ${err?.message || "unknown"}`,
      );
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

