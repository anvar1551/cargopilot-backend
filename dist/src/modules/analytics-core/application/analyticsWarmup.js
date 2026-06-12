"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAnalyticsWarmupLoop = startAnalyticsWarmupLoop;
const analyticsV2_1 = require("./analyticsV2");
const analyticsConfig_1 = require("../config/analyticsConfig");
const analyticsLogger_1 = require("../config/analyticsLogger");
const defaultScope = {
    role: "manager",
    warehouseId: null,
    userId: null,
};
const warmupRangeDays = analyticsConfig_1.analyticsConfig.defaults.rangeDays;
const warmupStaleHours = analyticsConfig_1.analyticsConfig.defaults.staleHours;
const warmupQueuePageSize = analyticsConfig_1.analyticsConfig.defaults.queuePageSize;
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
    const enabled = analyticsConfig_1.analyticsConfig.warmup.enabled;
    if (!enabled)
        return;
    const intervalMs = analyticsConfig_1.analyticsConfig.warmup.intervalMs;
    const trigger = async (source) => {
        try {
            await runWarmupPass();
            if (source === "startup") {
                analyticsLogger_1.analyticsLogger.info("warmup startup pass completed");
            }
        }
        catch (err) {
            analyticsLogger_1.analyticsLogger.throttledError(`warmup-${source}-failed`, `${source} warmup pass failed`, {
                error: err,
                throttleMs: 60000,
            });
        }
    };
    const startupDelayMs = analyticsConfig_1.analyticsConfig.warmup.startupDelayMs;
    const startupTimer = setTimeout(() => {
        void trigger("startup");
    }, startupDelayMs);
    startupTimer.unref();
    const timer = setInterval(() => {
        void trigger("interval");
    }, intervalMs);
    timer.unref();
}
