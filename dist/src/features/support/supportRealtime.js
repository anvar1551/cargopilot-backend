"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureSupportRefreshConsumer = ensureSupportRefreshConsumer;
exports.publishSupportRefresh = publishSupportRefresh;
exports.replaySupportRefreshSince = replaySupportRefreshSince;
exports.replaySupportRefreshFromRedis = replaySupportRefreshFromRedis;
exports.subscribeSupportRefresh = subscribeSupportRefresh;
const events_1 = require("events");
const redis_1 = require("../../config/redis");
const emitter = new events_1.EventEmitter();
const STREAM_MAX_LEN = 10000;
const EVENT_BUFFER_LIMIT = Math.max(100, Number(process.env.SUPPORT_STREAM_REPLAY_BUFFER || 1000));
let consumerStarted = false;
let streamLastId = "$";
let localEventSeq = 0;
const recentEvents = [];
function getSupportEventsStream() {
    return `${(0, redis_1.getRedisPrefix)()}:support:events`;
}
function safeParseEvent(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.type !== "support.refresh")
            return null;
        return {
            id: parsed.id ? String(parsed.id) : undefined,
            type: "support.refresh",
            at: String(parsed.at || new Date().toISOString()),
            reason: parsed.reason || "ticket_updated",
            ticketId: parsed.ticketId ?? null,
            keys: Array.isArray(parsed.keys) && parsed.keys.length
                ? parsed.keys
                : ["list", "summary", "detail"],
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
            const results = (await redis.xread("COUNT", 100, "BLOCK", 2000, "STREAMS", getSupportEventsStream(), streamLastId));
            if (!results)
                continue;
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
                        emitter.emit("support.refresh", event);
                    }
                }
            }
        }
        catch (err) {
            console.error(`[support] stream read error: ${err?.message || "unknown"}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}
function ensureSupportRefreshConsumer() {
    if (consumerStarted)
        return;
    consumerStarted = true;
    void startStreamConsumer();
}
async function publishSupportRefresh(reason, options) {
    const event = {
        id: String(++localEventSeq),
        type: "support.refresh",
        at: new Date().toISOString(),
        reason,
        ticketId: options?.ticketId ?? null,
        keys: options?.keys?.length ? options.keys : ["list", "summary", "detail"],
    };
    emitter.emit("support.refresh", event);
    appendRecentEvent(event);
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return;
        await redis.xadd(getSupportEventsStream(), "MAXLEN", "~", String(STREAM_MAX_LEN), "*", "type", event.type, "reason", event.reason, "ticketId", event.ticketId ?? "", "keys", JSON.stringify(event.keys), "data", JSON.stringify(event));
    }
    catch (err) {
        console.error(`[support] stream publish failed: ${err?.message || "unknown"}`);
    }
}
function replaySupportRefreshSince(lastEventId) {
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
async function replaySupportRefreshFromRedis(args) {
    const lastEventId = String(args.lastEventId || "").trim();
    if (!lastEventId)
        return [];
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return [];
    try {
        const entries = (await redis.call("XRANGE", getSupportEventsStream(), `(${lastEventId}`, "+", "COUNT", String(Math.max(1, Math.min(args.limit ?? 200, 1000)))));
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
        console.error(`[support] replay from redis failed: ${err?.message || "unknown"}`);
        return [];
    }
}
function subscribeSupportRefresh(handler) {
    emitter.on("support.refresh", handler);
    ensureSupportRefreshConsumer();
    return () => {
        emitter.off("support.refresh", handler);
    };
}
