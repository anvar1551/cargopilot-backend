"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDomainEventsStreamKey = getDomainEventsStreamKey;
exports.buildCargoPilotDomainEvent = buildCargoPilotDomainEvent;
exports.appendCargoPilotDomainEvent = appendCargoPilotDomainEvent;
exports.publishCargoPilotDomainEvent = publishCargoPilotDomainEvent;
const crypto_1 = require("crypto");
const redis_1 = require("../../config/redis");
const STREAM_MAX_LEN = 100000;
function getDomainEventsStreamKey() {
    return `${(0, redis_1.getRedisPrefix)()}:cp:events`;
}
function buildCargoPilotDomainEvent(partial) {
    return {
        id: partial.id || (0, crypto_1.randomUUID)(),
        type: partial.type,
        occurredAt: partial.occurredAt || new Date().toISOString(),
        tenantScope: partial.tenantScope || "global",
        entityId: partial.entityId ?? null,
        schemaVersion: 1,
        payload: partial.payload && typeof partial.payload === "object" ? partial.payload : {},
    };
}
async function appendCargoPilotDomainEvent(event) {
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis) {
        throw new Error("Redis unavailable");
    }
    await redis.xadd(getDomainEventsStreamKey(), "MAXLEN", "~", String(STREAM_MAX_LEN), "*", "eventId", event.id, "type", event.type, "tenantScope", event.tenantScope, "entityId", event.entityId ?? "", "schemaVersion", String(event.schemaVersion), "data", JSON.stringify(event));
}
async function publishCargoPilotDomainEvent(partial) {
    const event = buildCargoPilotDomainEvent(partial);
    try {
        await appendCargoPilotDomainEvent(event);
    }
    catch (err) {
        console.error(`[analytics-events] publish failed: ${err?.message || "unknown"}`);
    }
}
