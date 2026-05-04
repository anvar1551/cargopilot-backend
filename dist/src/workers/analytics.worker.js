"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAnalyticsWorker = startAnalyticsWorker;
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const redis_1 = require("../config/redis");
const analyticsEvents_1 = require("../features/manager/analyticsEvents");
const analyticsV2_1 = require("../features/manager/analyticsV2");
const analyticsV2Cache_1 = require("../features/manager/analyticsV2Cache");
const analyticsReadModel_1 = require("../features/manager/analyticsReadModel");
const analyticsV2Realtime_1 = require("../features/manager/analyticsV2Realtime");
const opsMetrics_1 = require("../features/observability/opsMetrics");
const GROUP_NAME = process.env.ANALYTICS_WORKER_GROUP || "cp_analytics_workers";
const CONSUMER_NAME = process.env.ANALYTICS_WORKER_CONSUMER ||
    `${process.env.HOSTNAME || "analytics"}-${process.pid}`;
const STREAM_KEY = (0, analyticsEvents_1.getDomainEventsStreamKey)();
const DEDUPE_TTL_SEC = Math.max(60, Number(process.env.ANALYTICS_WORKER_DEDUPE_TTL_SEC || 24 * 60 * 60));
const FLUSH_DEBOUNCE_MS = Math.max(250, Number(process.env.ANALYTICS_WORKER_FLUSH_DEBOUNCE_MS || 1500));
const HEALTH_LOG_MS = Math.max(10000, Number(process.env.ANALYTICS_WORKER_HEALTH_LOG_MS || 60000));
const LEADER_LOCK_KEY = process.env.ANALYTICS_WORKER_LEADER_LOCK_KEY || `${(0, redis_1.getRedisPrefix)()}:cp:analytics:worker:lock`;
const LEADER_LOCK_TTL_SEC = Math.max(10, Number(process.env.ANALYTICS_WORKER_LEADER_LOCK_TTL_SEC || 30));
const dirtySections = new Set();
let flushTimer = null;
let lastEventAt = 0;
let totalConsumed = 0;
let totalRebuilds = 0;
let lastHealthLogAt = 0;
function sectionForEventType(type) {
    switch (type) {
        case "order_created":
        case "order_status_changed":
            return ["summary", "trend", "warnings", "finance-queue"];
        case "cash_handoff":
        case "cash_settled":
            return ["summary", "warnings", "finance-queue"];
        case "manual_refresh":
            return ["summary", "trend", "warnings", "finance-queue"];
        case "driver_location_upsert":
        case "driver_presence_update":
            return [];
        default:
            return [];
    }
}
function toReadModelSection(section) {
    return section;
}
async function ensureConsumerGroup() {
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return;
    try {
        await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
    }
    catch (err) {
        const message = String(err?.message || "");
        if (!message.includes("BUSYGROUP")) {
            throw err;
        }
    }
}
function parseDomainEvent(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed?.type || !parsed?.id)
            return null;
        return {
            id: String(parsed.id),
            type: parsed.type,
            occurredAt: String(parsed.occurredAt || new Date().toISOString()),
            tenantScope: String(parsed.tenantScope || "global"),
            entityId: parsed.entityId ? String(parsed.entityId) : null,
            schemaVersion: 1,
            payload: parsed.payload && typeof parsed.payload === "object"
                ? parsed.payload
                : {},
        };
    }
    catch {
        return null;
    }
}
async function markEventDeduped(eventId) {
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return true;
    const key = `${(0, redis_1.getRedisPrefix)()}:cp:analytics:dedupe:${eventId}`;
    const inserted = await redis.set(key, "1", "EX", DEDUPE_TTL_SEC, "NX");
    return Boolean(inserted);
}
function scheduleFlush() {
    if (flushTimer)
        return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void rebuildDirtySections();
    }, FLUSH_DEBOUNCE_MS);
    flushTimer.unref();
}
async function rebuildDirtySections() {
    if (dirtySections.size === 0)
        return;
    const sections = Array.from(dirtySections);
    dirtySections.clear();
    try {
        const shouldClearBeforeRebuild = process.env.ANALYTICS_WORKER_CLEAR_BEFORE_REBUILD === "true";
        if (shouldClearBeforeRebuild) {
            for (const section of sections) {
                await (0, analyticsV2Cache_1.invalidateNamespaceCaches)(section);
                await (0, analyticsReadModel_1.clearAnalyticsReadModelBySection)(toReadModelSection(section));
            }
        }
        const defaultRangeDays = Math.max(7, Math.min(180, Number(process.env.ANALYTICS_V3_DEFAULT_RANGE_DAYS || 30)));
        const defaultPageSize = Math.max(5, Math.min(200, Number(process.env.ANALYTICS_V3_DEFAULT_QUEUE_PAGE_SIZE || 20)));
        const scope = { role: "manager", warehouseId: null, userId: null };
        if (sections.includes("summary")) {
            await (0, analyticsV2_1.getAnalyticsSummaryV2)({ rangeDays: defaultRangeDays, scope });
        }
        if (sections.includes("trend")) {
            await (0, analyticsV2_1.getAnalyticsTrendV2)({ rangeDays: defaultRangeDays, scope });
        }
        if (sections.includes("warnings")) {
            await (0, analyticsV2_1.getAnalyticsWarningsV2)({ rangeDays: defaultRangeDays, scope });
        }
        if (sections.includes("finance-queue")) {
            await (0, analyticsV2_1.getAnalyticsFinanceQueueV2)({
                queuePage: 1,
                queuePageSize: defaultPageSize,
                queueStatuses: [],
                queueKinds: [],
                queueHolderTypes: [],
                scope,
            });
        }
        if (!shouldClearBeforeRebuild) {
            for (const section of sections) {
                await (0, analyticsV2Cache_1.invalidateNamespaceCaches)(section);
            }
        }
        totalRebuilds += 1;
        (0, opsMetrics_1.recordAnalyticsWorkerRebuild)();
        await (0, analyticsV2Realtime_1.publishAnalyticsInvalidation)("worker_rebuild", {
            scope: "role:manager",
            keys: sections,
            source: "worker",
        });
    }
    catch (err) {
        (0, opsMetrics_1.recordAnalyticsWorkerError)();
        console.error(`[analytics-worker] rebuild failed: ${err?.message || "unknown"}`);
    }
}
async function logHealthMaybe() {
    const now = Date.now();
    if (now - lastHealthLogAt < HEALTH_LOG_MS)
        return;
    lastHealthLogAt = now;
    const lagMs = lastEventAt > 0 ? now - lastEventAt : 0;
    console.log(`[analytics-worker] consumed=${totalConsumed} rebuilds=${totalRebuilds} lagMs=${lagMs} dirty=${dirtySections.size}`);
}
async function isLeaderOrAcquire(args) {
    if (!args.enabled)
        return true;
    const redis = await (0, redis_1.getRedisClient)();
    if (!redis)
        return false;
    const acquired = await redis.set(LEADER_LOCK_KEY, CONSUMER_NAME, "EX", LEADER_LOCK_TTL_SEC, "NX");
    if (acquired)
        return true;
    const owner = await redis.get(LEADER_LOCK_KEY);
    if (owner === CONSUMER_NAME) {
        await redis.expire(LEADER_LOCK_KEY, LEADER_LOCK_TTL_SEC);
        return true;
    }
    return false;
}
async function startAnalyticsWorker(args) {
    const useLeaderLock = Boolean(args?.leaderLock);
    console.log(`[analytics-worker] starting consumer=${CONSUMER_NAME} group=${GROUP_NAME}`);
    await ensureConsumerGroup();
    while (true) {
        try {
            const leader = await isLeaderOrAcquire({ enabled: useLeaderLock });
            if (!leader) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
            const redis = await (0, redis_1.getRedisClient)();
            if (!redis) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
            const results = (await redis.xreadgroup("GROUP", GROUP_NAME, CONSUMER_NAME, "COUNT", 100, "BLOCK", 2000, "STREAMS", STREAM_KEY, ">"));
            if (!results) {
                await logHealthMaybe();
                continue;
            }
            for (const [, entries] of results) {
                for (const [streamEntryId, fields] of entries) {
                    const dataIdx = fields.indexOf("data");
                    const raw = dataIdx >= 0 ? fields[dataIdx + 1] : null;
                    const event = raw ? parseDomainEvent(raw) : null;
                    let shouldProcess = false;
                    if (event) {
                        shouldProcess = await markEventDeduped(event.id);
                        if (shouldProcess) {
                            for (const section of sectionForEventType(event.type)) {
                                dirtySections.add(section);
                            }
                            lastEventAt = Date.now();
                            const occurredAtTs = new Date(event.occurredAt).getTime();
                            const lagMs = Number.isFinite(occurredAtTs)
                                ? Math.max(0, Date.now() - occurredAtTs)
                                : 0;
                            (0, opsMetrics_1.recordAnalyticsWorkerConsumed)({
                                lagMs,
                                occurredAt: event.occurredAt,
                            });
                        }
                    }
                    await redis.xack(STREAM_KEY, GROUP_NAME, streamEntryId);
                    if (shouldProcess)
                        totalConsumed += 1;
                }
            }
            scheduleFlush();
            await logHealthMaybe();
        }
        catch (err) {
            (0, opsMetrics_1.recordAnalyticsWorkerError)();
            console.error(`[analytics-worker] stream error: ${err?.message || "unknown"}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}
if (require.main === module) {
    void startAnalyticsWorker({ leaderLock: false });
}
process.on("SIGTERM", async () => {
    console.log("[analytics-worker] shutting down");
    await prismaClient_1.default.$disconnect().catch(() => undefined);
    process.exit(0);
});
process.on("SIGINT", async () => {
    console.log("[analytics-worker] interrupted");
    await prismaClient_1.default.$disconnect().catch(() => undefined);
    process.exit(0);
});
