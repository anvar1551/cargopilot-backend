"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAnalyticsInvalidationConsumer = ensureAnalyticsInvalidationConsumer;
exports.publishAnalyticsInvalidation = publishAnalyticsInvalidation;
exports.subscribeAnalyticsInvalidation = subscribeAnalyticsInvalidation;
const events_1 = require("events");
const redis_1 = require("../../config/redis");
const emitter = new events_1.EventEmitter();
const STREAM_MAX_LEN = 10000;
let consumerStarted = false;
let streamLastId = "$";
function getAnalyticsEventsStream() {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v2:events`;
}
function safeParseEvent(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.type !== "analytics.invalidate")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
async function startStreamConsumer() {
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return;
    while (true) {
        try {
            const results = (await redis.xread("COUNT", 100, "BLOCK", 2000, "STREAMS", getAnalyticsEventsStream(), streamLastId));
            if (results) {
                for (const [, entries] of results) {
                    for (const [id, fields] of entries) {
                        streamLastId = id;
                        const dataIdx = fields.indexOf("data");
                        if (dataIdx === -1)
                            continue;
                        const raw = fields[dataIdx + 1];
                        if (!raw)
                            continue;
                        const event = safeParseEvent(raw);
                        if (event)
                            emitter.emit("analytics.invalidate", event);
                    }
                }
            }
        }
        catch (err) {
            console.error(`[analytics-v2] stream read error: ${err?.message || "unknown"}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}
function ensureAnalyticsInvalidationConsumer() {
    if (consumerStarted)
        return;
    consumerStarted = true;
    void startStreamConsumer();
}
async function publishAnalyticsInvalidation(reason) {
    const event = {
        type: "analytics.invalidate",
        at: new Date().toISOString(),
        reason,
        scope: "global",
    };
    emitter.emit("analytics.invalidate", event);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        await redis.xadd(getAnalyticsEventsStream(), "MAXLEN", "~", String(STREAM_MAX_LEN), "*", "type", event.type, "reason", event.reason, "scope", event.scope, "data", JSON.stringify(event));
    }
    catch (err) {
        console.error(`[analytics-v2] stream publish failed: ${err?.message || "unknown"}`);
    }
}
function subscribeAnalyticsInvalidation(handler) {
    emitter.on("analytics.invalidate", handler);
    ensureAnalyticsInvalidationConsumer();
    return () => {
        emitter.off("analytics.invalidate", handler);
    };
}
