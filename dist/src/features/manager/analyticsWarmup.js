"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAnalyticsWarmupLoop = startAnalyticsWarmupLoop;
const analyticsV2_1 = require("./analyticsV2");
const defaultScope = {
    role: "manager",
    warehouseId: null,
    userId: null,
};
const warmupRangeDays = Math.max(7, Math.min(180, Number(process.env.ANALYTICS_V3_DEFAULT_RANGE_DAYS || 30)));
const warmupStaleHours = Math.max(6, Math.min(720, Number(process.env.ANALYTICS_WARMUP_STALE_HOURS || 48)));
const warmupQueuePageSize = Math.max(5, Math.min(200, Number(process.env.ANALYTICS_V3_DEFAULT_QUEUE_PAGE_SIZE || 20)));
let warmupInFlight = false;
async function runWarmupPass() {
    if (warmupInFlight)
        return;
    warmupInFlight = true;
    try {
        // Sequential warmup avoids cold-start DB burst on small instances.
        await (0, analyticsV2_1.getAnalyticsSummaryV2)({
            rangeDays: warmupRangeDays,
            staleHours: warmupStaleHours,
            scope: defaultScope,
        });
        await (0, analyticsV2_1.getAnalyticsTrendV2)({
            rangeDays: warmupRangeDays,
            scope: defaultScope,
        });
        await (0, analyticsV2_1.getAnalyticsWarningsV2)({
            rangeDays: warmupRangeDays,
            staleHours: warmupStaleHours,
            scope: defaultScope,
        });
        await (0, analyticsV2_1.getAnalyticsFinanceQueueV2)({
            queuePage: 1,
            queuePageSize: warmupQueuePageSize,
            queueStatuses: [],
            queueKinds: [],
            queueHolderTypes: [],
            scope: defaultScope,
        });
    }
    finally {
        warmupInFlight = false;
    }
}
function startAnalyticsWarmupLoop() {
    const enabled = process.env.ANALYTICS_WARMUP_ENABLED !== "false";
    if (!enabled)
        return;
    const intervalMs = Math.max(60000, Number(process.env.ANALYTICS_WARMUP_INTERVAL_MS || 240000));
    const trigger = async (source) => {
        try {
            await runWarmupPass();
            if (source === "startup") {
                console.log("[analytics-warmup] startup pass completed");
            }
        }
        catch (err) {
            console.error(`[analytics-warmup] ${source} pass failed: ${err?.message || "unknown"}`);
        }
    };
    const startupDelayMs = Math.max(0, Number(process.env.ANALYTICS_WARMUP_STARTUP_DELAY_MS || 30000));
    const startupTimer = setTimeout(() => {
        void trigger("startup");
    }, startupDelayMs);
    startupTimer.unref();
    const timer = setInterval(() => {
        void trigger("interval");
    }, intervalMs);
    timer.unref();
}
