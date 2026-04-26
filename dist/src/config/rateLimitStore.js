"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRateLimitStore = createRateLimitStore;
const rate_limit_redis_1 = require("rate-limit-redis");
const redis_1 = require("./redis");
function createRateLimitStore(namespace) {
    if (!(0, redis_1.isRedisEnabled)())
        return undefined;
    const prefixRoot = process.env.REDIS_RATE_LIMIT_PREFIX?.trim() || `${(0, redis_1.getRedisPrefix)()}:ratelimit`;
    return new rate_limit_redis_1.RedisStore({
        prefix: `${prefixRoot}:${namespace}:`,
        sendCommand: (async (...args) => {
            const client = await (0, redis_1.getRedisClient)();
            if (!client) {
                throw new Error("Redis client unavailable");
            }
            return client.call(...args);
        }),
    });
}
