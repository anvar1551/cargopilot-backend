"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRedisEnabled = isRedisEnabled;
exports.getRedisPrefix = getRedisPrefix;
exports.getRedisClient = getRedisClient;
const redis_1 = require("redis");
let redisClient = null;
let connectPromise = null;
let hasLoggedDisabled = false;
function isRedisEnabled() {
    return process.env.REDIS_ENABLED !== "false" && Boolean(process.env.REDIS_URL);
}
function getRedisPrefix() {
    return process.env.REDIS_PREFIX?.trim() || "cargopilot";
}
function buildRedisClient() {
    const url = process.env.REDIS_URL;
    if (!url)
        return null;
    const client = (0, redis_1.createClient)({
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
async function getRedisClient() {
    if (!isRedisEnabled()) {
        if (!hasLoggedDisabled) {
            hasLoggedDisabled = true;
            console.warn("[redis] disabled, using in-memory fallback");
        }
        return null;
    }
    if (redisClient?.isOpen)
        return redisClient;
    if (connectPromise)
        return connectPromise;
    connectPromise = (async () => {
        try {
            if (!redisClient) {
                redisClient = buildRedisClient();
            }
            if (!redisClient)
                return null;
            if (!redisClient.isOpen) {
                await redisClient.connect();
            }
            return redisClient;
        }
        catch (err) {
            console.error(`[redis] connect failed, using in-memory fallback: ${err?.message || "unknown"}`);
            return null;
        }
        finally {
            connectPromise = null;
        }
    })();
    return connectPromise;
}
