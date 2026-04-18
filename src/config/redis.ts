import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;
let hasLoggedDisabled = false;

export function isRedisEnabled() {
  return process.env.REDIS_ENABLED !== "false" && Boolean(process.env.REDIS_URL);
}

export function getRedisPrefix() {
  return process.env.REDIS_PREFIX?.trim() || "cargopilot";
}

function buildRedisClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const client = createClient({
    url,
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
    },
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

  if (redisClient?.isOpen) return redisClient;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      if (!redisClient) {
        redisClient = buildRedisClient();
      }
      if (!redisClient) return null;

      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      return redisClient;
    } catch (err: any) {
      console.error(
        `[redis] connect failed, using in-memory fallback: ${err?.message || "unknown"}`,
      );
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}
