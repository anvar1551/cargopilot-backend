import { RedisStore } from "rate-limit-redis";
import { getRedisClient, getRedisPrefix, isRedisEnabled } from "./redis";

export function createRateLimitStore(namespace: string) {
  const redisStoreEnabled = process.env.RATE_LIMIT_REDIS_STORE_ENABLED === "true";
  if (!redisStoreEnabled) return undefined;
  if (!isRedisEnabled()) return undefined;

  const prefixRoot =
    process.env.REDIS_RATE_LIMIT_PREFIX?.trim() || `${getRedisPrefix()}:ratelimit`;

  return new RedisStore({
    prefix: `${prefixRoot}:${namespace}:`,
    sendCommand: (async (command: string, ...args: string[]) => {
      const client = await getRedisClient();
      if (!client) {
        throw new Error("Redis client unavailable");
      }
      return (client as any).call(command, ...args);
    }) as any,
  });
}
