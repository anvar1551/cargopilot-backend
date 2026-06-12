"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAnalyticsOutboxPublisher = startAnalyticsOutboxPublisher;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const redis_1 = require("../../../config/redis");
const analyticsConfig_1 = require("../config/analyticsConfig");
const analyticsLogger_1 = require("../config/analyticsLogger");
const analyticsEvents_1 = require("../realtime/analyticsEvents");
const OUTBOX_BATCH_SIZE = analyticsConfig_1.analyticsConfig.outbox.batchSize;
const OUTBOX_IDLE_MS = analyticsConfig_1.analyticsConfig.outbox.idleMs;
const OUTBOX_LOCK_KEY = analyticsConfig_1.analyticsConfig.outbox.lockKey || `${(0, redis_1.getRedisPrefix)()}:cp:analytics:outbox:publisher:lock`;
const OUTBOX_LOCK_TTL_SEC = analyticsConfig_1.analyticsConfig.outbox.lockTtlSec;
const OUTBOX_CONSUMER_ID = analyticsConfig_1.analyticsConfig.outbox.consumerId || `${process.env.HOSTNAME || "api"}-${process.pid}`;
const outboxRepo = prismaClient_1.default.analyticsDomainEventOutbox;
const OUTBOX_LOCK_TIMEOUT_MS = Math.max(1000, Number(process.env.ANALYTICS_OUTBOX_LOCK_TIMEOUT_MS || 4000));
const OUTBOX_LOCK_ACQUIRE_OR_REFRESH_SCRIPT = `
local key = KEYS[1]
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local current = redis.call('GET', key)
if not current then
  redis.call('SET', key, owner, 'EX', ttl, 'NX')
  current = redis.call('GET', key)
  if current == owner then
    return 1
  end
  return 0
end
if current == owner then
  redis.call('EXPIRE', key, ttl)
  return 1
end
return 0
`;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function parsePayload(value) {
    return value && typeof value === "object" ? value : {};
}
function toDomainEvent(row) {
    if (!row.eventId || !row.type || !row.tenantScope)
        return null;
    const parsedType = row.type;
    return {
        id: row.eventId,
        type: parsedType,
        tenantScope: row.tenantScope,
        entityId: row.entityId ?? null,
        schemaVersion: 1,
        occurredAt: row.occurredAt.toISOString(),
        payload: parsePayload(row.payload),
    };
}
async function acquireLeaderLock() {
    if (!analyticsConfig_1.analyticsConfig.outbox.leaderLockEnabled)
        return true;
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis)
            return false;
        const acquired = await (0, redis_1.withRedisTimeout)("analytics:outbox:lock:acquire-or-refresh", () => redis.eval(OUTBOX_LOCK_ACQUIRE_OR_REFRESH_SCRIPT, 1, OUTBOX_LOCK_KEY, OUTBOX_CONSUMER_ID, String(OUTBOX_LOCK_TTL_SEC)), OUTBOX_LOCK_TIMEOUT_MS);
        return Number(acquired) === 1;
    }
    catch (err) {
        const message = String(err?.message || "").toLowerCase();
        if (message.includes("timed out")) {
            analyticsLogger_1.analyticsLogger.throttledWarn("outbox-lock-timeout", "outbox leader lock timeout", {
                error: err,
                throttleMs: 120000,
            });
            return false;
        }
        analyticsLogger_1.analyticsLogger.throttledWarn("outbox-lock-failed", "outbox leader lock failed", {
            error: err,
            throttleMs: 120000,
        });
        return false;
    }
}
async function startAnalyticsOutboxPublisher() {
    if (!analyticsConfig_1.analyticsConfig.outbox.enabled) {
        analyticsLogger_1.analyticsLogger.info("outbox publisher disabled");
        return;
    }
    analyticsLogger_1.analyticsLogger.info("outbox publisher started", { consumerId: OUTBOX_CONSUMER_ID });
    while (true) {
        try {
            const leader = await acquireLeaderLock();
            if (!leader) {
                await sleep(2000);
                continue;
            }
            const batch = await outboxRepo.findMany({
                where: { publishedAt: null },
                orderBy: { createdAt: "asc" },
                take: OUTBOX_BATCH_SIZE,
            });
            if (batch.length === 0) {
                await sleep(OUTBOX_IDLE_MS);
                continue;
            }
            for (const row of batch) {
                const event = toDomainEvent(row);
                if (!event) {
                    await outboxRepo.update({
                        where: { id: row.id },
                        data: {
                            attempts: { increment: 1 },
                            publishedAt: new Date(),
                            lastError: "Invalid outbox payload shape",
                        },
                    });
                    continue;
                }
                try {
                    await (0, analyticsEvents_1.appendCargoPilotDomainEvent)(event);
                    await outboxRepo.update({
                        where: { id: row.id },
                        data: {
                            attempts: { increment: 1 },
                            publishedAt: new Date(),
                            lastError: null,
                        },
                    });
                }
                catch (err) {
                    await outboxRepo.update({
                        where: { id: row.id },
                        data: {
                            attempts: { increment: 1 },
                            lastError: String(err?.message || "Unknown outbox publish error").slice(0, 1000),
                        },
                    });
                }
            }
        }
        catch (err) {
            const message = String(err?.message || "");
            if (message.toLowerCase().includes("timed out")) {
                analyticsLogger_1.analyticsLogger.throttledWarn("outbox-loop-timeout", "outbox publisher loop timeout", {
                    error: err,
                    throttleMs: 30000,
                });
            }
            else {
                analyticsLogger_1.analyticsLogger.throttledError("outbox-loop-error", "outbox publisher loop error", {
                    error: err,
                    throttleMs: 30000,
                });
            }
            await sleep(2000);
        }
    }
}
