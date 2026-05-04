"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAnalyticsOutboxPublisher = startAnalyticsOutboxPublisher;
const prismaClient_1 = __importDefault(require("../../config/prismaClient"));
const redis_1 = require("../../config/redis");
const analyticsEvents_1 = require("./analyticsEvents");
const OUTBOX_BATCH_SIZE = Math.max(10, Math.min(500, Number(process.env.ANALYTICS_OUTBOX_BATCH_SIZE || 100)));
const OUTBOX_IDLE_MS = Math.max(250, Number(process.env.ANALYTICS_OUTBOX_IDLE_MS || 1500));
const OUTBOX_LOCK_KEY = process.env.ANALYTICS_OUTBOX_LOCK_KEY || `${(0, redis_1.getRedisPrefix)()}:cp:analytics:outbox:publisher:lock`;
const OUTBOX_LOCK_TTL_SEC = Math.max(10, Number(process.env.ANALYTICS_OUTBOX_LOCK_TTL_SEC || 30));
const OUTBOX_CONSUMER_ID = process.env.ANALYTICS_OUTBOX_CONSUMER || `${process.env.HOSTNAME || "api"}-${process.pid}`;
const outboxRepo = prismaClient_1.default.analyticsDomainEventOutbox;
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
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return false;
    const inserted = await redis.set(OUTBOX_LOCK_KEY, OUTBOX_CONSUMER_ID, "EX", OUTBOX_LOCK_TTL_SEC, "NX");
    if (inserted)
        return true;
    const owner = await redis.get(OUTBOX_LOCK_KEY);
    if (owner === OUTBOX_CONSUMER_ID) {
        await redis.expire(OUTBOX_LOCK_KEY, OUTBOX_LOCK_TTL_SEC);
        return true;
    }
    return false;
}
async function startAnalyticsOutboxPublisher() {
    if (process.env.ANALYTICS_OUTBOX_ENABLED === "false") {
        console.log("[analytics-outbox] disabled");
        return;
    }
    console.log(`[analytics-outbox] starting publisher=${OUTBOX_CONSUMER_ID}`);
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
            console.error(`[analytics-outbox] loop error: ${err?.message || "unknown"}`);
            await sleep(2000);
        }
    }
}
