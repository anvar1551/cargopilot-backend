"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureSupportRefreshConsumer = ensureSupportRefreshConsumer;
exports.publishSupportRefresh = publishSupportRefresh;
exports.subscribeSupportRefresh = subscribeSupportRefresh;
const events_1 = require("events");
const redis_1 = require("../../config/redis");
const emitter = new events_1.EventEmitter();
const STREAM_MAX_LEN = 10000;
let consumerStarted = false;
let streamLastId = "$";
function getSupportEventsStream() {
    return `${(0, redis_1.getRedisPrefix)()}:support:events`;
}
function safeParseEvent(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.type !== "support.refresh")
            return null;
        return {
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
                    if (event)
                        emitter.emit("support.refresh", event);
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
        type: "support.refresh",
        at: new Date().toISOString(),
        reason,
        ticketId: options?.ticketId ?? null,
        keys: options?.keys?.length ? options.keys : ["list", "summary", "detail"],
    };
    emitter.emit("support.refresh", event);
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
function subscribeSupportRefresh(handler) {
    emitter.on("support.refresh", handler);
    ensureSupportRefreshConsumer();
    return () => {
        emitter.off("support.refresh", handler);
    };
}
