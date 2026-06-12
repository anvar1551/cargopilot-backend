"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAnalyticsWorker = startAnalyticsWorker;
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const redis_1 = require("../config/redis");
const analyticsConfig_1 = require("../modules/analytics-core/config/analyticsConfig");
const analyticsLogger_1 = require("../modules/analytics-core/config/analyticsLogger");
const analyticsEvents_1 = require("../modules/analytics-core/realtime/analyticsEvents");
const analyticsV2_1 = require("../modules/analytics-core/application/analyticsV2");
const analyticsReadModel_1 = require("../modules/analytics-core/infrastructure/analyticsReadModel");
const analyticsV2Realtime_1 = require("../modules/analytics-core/realtime/analyticsV2Realtime");
const opsMetrics_1 = require("../modules/observability-core/application/opsMetrics");
const supportCache_1 = require("../modules/support-core/infrastructure/supportCache");
const supportRealtime_1 = require("../modules/support-core/realtime/supportRealtime");
const GROUP_NAME = analyticsConfig_1.analyticsConfig.worker.group;
const CONSUMER_NAME = analyticsConfig_1.analyticsConfig.worker.consumer;
const STREAM_KEY = (0, analyticsEvents_1.getDomainEventsStreamKey)();
const DEDUPE_TTL_SEC = analyticsConfig_1.analyticsConfig.worker.dedupeTtlSec;
const FLUSH_DEBOUNCE_MS = analyticsConfig_1.analyticsConfig.worker.flushDebounceMs;
const HEALTH_LOG_MS = analyticsConfig_1.analyticsConfig.worker.healthLogMs;
const HEALTH_LOG_ENABLED = analyticsConfig_1.analyticsConfig.worker.healthLogEnabled;
const LEADER_LOCK_KEY = analyticsConfig_1.analyticsConfig.worker.leaderLockKey || `${(0, redis_1.getRedisPrefix)()}:cp:analytics:worker:lock`;
const LEADER_LOCK_TTL_SEC = analyticsConfig_1.analyticsConfig.worker.leaderLockTtlSec;
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
        case "support_ticket_changed":
            return [];
        default:
            return [];
    }
}
function asSupportRefreshReason(value) {
    const raw = String(value || "").trim();
    if (raw === "ticket_created" ||
        raw === "ticket_updated" ||
        raw === "message_added" ||
        raw === "note_added" ||
        raw === "ticket_archived") {
        return raw;
    }
    return "ticket_updated";
}
async function handleSupportTicketChanged(event) {
    const reason = asSupportRefreshReason(event.payload?.reason);
    await (0, supportCache_1.invalidateSupportCache)(event.entityId);
    await (0, supportRealtime_1.publishSupportRefresh)(reason, {
        ticketId: event.entityId,
        keys: ["list", "summary", "detail"],
    });
}
function toReadModelSection(section) {
    return section;
}
async function ensureConsumerGroup() {
    const redis = (0, redis_1.createRedisClient)({
        connectTimeout: 3000,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        lazyConnect: true,
        commandTimeout: null,
    });
    if (!redis)
        return;
    await redis.connect().catch(() => undefined);
    try {
        await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
    }
    catch (err) {
        const message = String(err?.message || "");
        if (!message.includes("BUSYGROUP")) {
            throw err;
        }
    }
    finally {
        await redis.quit().catch(() => undefined);
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
        for (const section of sections) {
            await (0, analyticsReadModel_1.clearAnalyticsReadModelBySection)(toReadModelSection(section));
        }
        const defaultRangeDays = analyticsConfig_1.analyticsConfig.defaults.rangeDays;
        const defaultPageSize = analyticsConfig_1.analyticsConfig.defaults.queuePageSize;
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
        analyticsLogger_1.analyticsLogger.throttledError("worker-rebuild-failed", "analytics worker rebuild failed", {
            error: err,
            throttleMs: 30000,
        });
    }
}
async function logHealthMaybe() {
    if (!HEALTH_LOG_ENABLED)
        return;
    const now = Date.now();
    if (now - lastHealthLogAt < HEALTH_LOG_MS)
        return;
    lastHealthLogAt = now;
    const lagMs = lastEventAt > 0 ? now - lastEventAt : 0;
    analyticsLogger_1.analyticsLogger.info("analytics worker health", {
        consumed: totalConsumed,
        rebuilds: totalRebuilds,
        lagMs,
        dirtySections: dirtySections.size,
    });
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
    analyticsLogger_1.analyticsLogger.info("analytics worker starting", {
        consumer: CONSUMER_NAME,
        group: GROUP_NAME,
        leaderLock: useLeaderLock,
    });
    await ensureConsumerGroup();
    const createStreamRedis = () => (0, redis_1.createRedisClient)({
        connectTimeout: 3000,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        lazyConnect: true,
        commandTimeout: null,
    });
    let streamRedis = createStreamRedis();
    if (!streamRedis) {
        analyticsLogger_1.analyticsLogger.error("analytics worker stream redis unavailable at startup");
        return;
    }
    await streamRedis.connect().catch(() => undefined);
    while (true) {
        try {
            if (!streamRedis) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                streamRedis = createStreamRedis();
                if (streamRedis) {
                    await streamRedis.connect().catch(() => undefined);
                }
                continue;
            }
            const leader = await isLeaderOrAcquire({ enabled: useLeaderLock });
            if (!leader) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
            if (streamRedis.status !== "ready") {
                await streamRedis.connect().catch(() => undefined);
            }
            if (streamRedis.status !== "ready") {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
            const results = (await streamRedis.xreadgroup("GROUP", GROUP_NAME, CONSUMER_NAME, "COUNT", 100, "BLOCK", 2000, "STREAMS", STREAM_KEY, ">"));
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
                            if (event.type === "support_ticket_changed") {
                                await handleSupportTicketChanged(event);
                            }
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
                    await streamRedis.xack(STREAM_KEY, GROUP_NAME, streamEntryId);
                    if (shouldProcess)
                        totalConsumed += 1;
                }
            }
            scheduleFlush();
            await logHealthMaybe();
        }
        catch (err) {
            (0, opsMetrics_1.recordAnalyticsWorkerError)();
            analyticsLogger_1.analyticsLogger.throttledError("worker-stream-error", "analytics worker stream error", {
                error: err,
                throttleMs: 30000,
            });
            try {
                streamRedis?.disconnect();
            }
            catch {
                // noop
            }
            streamRedis = createStreamRedis();
            if (streamRedis) {
                await streamRedis.connect().catch(() => undefined);
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}
if (require.main === module) {
    void startAnalyticsWorker({ leaderLock: false });
}
process.on("SIGTERM", async () => {
    analyticsLogger_1.analyticsLogger.info("analytics worker shutting down");
    await prismaClient_1.default.$disconnect().catch(() => undefined);
    process.exit(0);
});
process.on("SIGINT", async () => {
    analyticsLogger_1.analyticsLogger.info("analytics worker interrupted");
    await prismaClient_1.default.$disconnect().catch(() => undefined);
    process.exit(0);
});
