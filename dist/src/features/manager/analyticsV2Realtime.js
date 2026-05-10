"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAnalyticsInvalidationConsumer = ensureAnalyticsInvalidationConsumer;
exports.publishAnalyticsInvalidation = publishAnalyticsInvalidation;
exports.replayAnalyticsInvalidationSince = replayAnalyticsInvalidationSince;
exports.replayAnalyticsInvalidationFromRedis = replayAnalyticsInvalidationFromRedis;
exports.subscribeAnalyticsInvalidation = subscribeAnalyticsInvalidation;
const events_1 = require("events");
const redis_1 = require("../../config/redis");
const emitter = new events_1.EventEmitter();
const STREAM_MAX_LEN = 10000;
const EVENT_BUFFER_LIMIT = Math.max(100, Number(process.env.ANALYTICS_V2_STREAM_REPLAY_BUFFER || 1000));
let consumerStarted = false;
let streamLastId = "$";
let localEventSeq = 0;
const recentEvents = [];
function getAnalyticsEventsStream() {
    return `${(0, redis_1.getRedisPrefix)()}:analytics:v2:events`;
}
function safeParseEvent(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.type !== "analytics.invalidate")
            return null;
        return {
            id: parsed.id ? String(parsed.id) : undefined,
            type: "analytics.invalidate",
            at: String(parsed.at || new Date().toISOString()),
            reason: parsed.reason || "manual_refresh",
            scope: String(parsed.scope || "global"),
            keys: Array.isArray(parsed.keys) && parsed.keys.length > 0
                ? parsed.keys
                : ["summary", "trend", "warnings", "finance-queue"],
            source: parsed.source === "worker" ? "worker" : "api",
        };
    }
    catch {
        return null;
    }
}
function appendRecentEvent(event) {
    recentEvents.push(event);
    if (recentEvents.length > EVENT_BUFFER_LIMIT) {
        recentEvents.splice(0, recentEvents.length - EVENT_BUFFER_LIMIT);
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
                        if (event) {
                            appendRecentEvent(event);
                            emitter.emit("analytics.invalidate", event);
                        }
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
async function publishAnalyticsInvalidation(reason, options) {
    const event = {
        id: String(++localEventSeq),
        type: "analytics.invalidate",
        at: new Date().toISOString(),
        reason,
        scope: options?.scope || "global",
        keys: options?.keys?.length
            ? options.keys
            : ["summary", "trend", "warnings", "finance-queue"],
        source: options?.source || "api",
    };
    emitter.emit("analytics.invalidate", event);
    appendRecentEvent(event);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        await redis.xadd(getAnalyticsEventsStream(), "MAXLEN", "~", String(STREAM_MAX_LEN), "*", "type", event.type, "reason", event.reason, "scope", event.scope, "keys", JSON.stringify(event.keys), "source", event.source || "api", "data", JSON.stringify(event));
    }
    catch (err) {
        console.error(`[analytics-v2] stream publish failed: ${err?.message || "unknown"}`);
    }
}
function replayAnalyticsInvalidationSince(lastEventId) {
    if (!lastEventId)
        return [];
    const normalized = String(lastEventId).trim();
    if (!normalized)
        return [];
    const idx = recentEvents.findIndex((event) => String(event.id || "") === normalized);
    if (idx < 0)
        return [];
    return recentEvents.slice(idx + 1);
}
async function replayAnalyticsInvalidationFromRedis(args) {
    const lastEventId = String(args.lastEventId || "").trim();
    if (!lastEventId)
        return [];
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return [];
    try {
        const entries = (await redis.call("XRANGE", getAnalyticsEventsStream(), `(${lastEventId}`, "+", "COUNT", String(Math.max(1, Math.min(args.limit ?? 250, 1000)))));
        return entries
            .map(([, fields]) => {
            const dataIdx = fields.indexOf("data");
            if (dataIdx === -1)
                return null;
            const raw = fields[dataIdx + 1];
            return raw ? safeParseEvent(raw) : null;
        })
            .filter((item) => Boolean(item));
    }
    catch (err) {
        console.error(`[analytics-v2] replay from redis failed: ${err?.message || "unknown"}`);
        return [];
    }
}
function subscribeAnalyticsInvalidation(handler) {
    emitter.on("analytics.invalidate", handler);
    ensureAnalyticsInvalidationConsumer();
    return () => {
        emitter.off("analytics.invalidate", handler);
    };
}
