import { RedisStore } from "rate-limit-redis";
import { getRedisClient, getRedisPrefix, isRedisEnabled } from "./redis";

export function createRateLimitStore(namespace: string) {
  if (!isRedisEnabled()) return undefined;

  const prefixRoot =
    process.env.REDIS_RATE_LIMIT_PREFIX?.trim() || `${getRedisPrefix()}:ratelimit`;

  return new RedisStore({
    prefix: `${prefixRoot}:${namespace}:`,
    sendCommand: async (...args: string[]) => {
      const client = await getRedisClient();
      if (!client) {
        throw new Error("Redis client unavailable");
      }
      return client.sendCommand(args);
    },
  });
}

