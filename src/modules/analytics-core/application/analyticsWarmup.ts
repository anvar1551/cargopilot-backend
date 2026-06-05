import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "./analyticsV2";
import { analyticsConfig } from "../config/analyticsConfig";
import { analyticsLogger } from "../config/analyticsLogger";

const defaultScope = {
  role: "manager",
  warehouseId: null as string | null,
  userId: null as string | null,
};

const warmupRangeDays = analyticsConfig.defaults.rangeDays;
const warmupStaleHours = analyticsConfig.defaults.staleHours;
const warmupQueuePageSize = analyticsConfig.defaults.queuePageSize;

let warmupInFlight = false;

async function runWarmupPass() {
  if (warmupInFlight) return;
  warmupInFlight = true;
  try {
    // Sequential warmup avoids cold-start DB burst on small instances.
    await getAnalyticsSummaryV2({
      rangeDays: warmupRangeDays,
      staleHours: warmupStaleHours,
      scope: defaultScope,
    });
    await getAnalyticsTrendV2({
      rangeDays: warmupRangeDays,
      scope: defaultScope,
    });
    await getAnalyticsWarningsV2({
      rangeDays: warmupRangeDays,
      staleHours: warmupStaleHours,
      scope: defaultScope,
    });
    await getAnalyticsFinanceQueueV2({
      queuePage: 1,
      queuePageSize: warmupQueuePageSize,
      queueStatuses: [],
      queueKinds: [],
      queueHolderTypes: [],
      scope: defaultScope,
    });
  } finally {
    warmupInFlight = false;
  }
}

export function startAnalyticsWarmupLoop() {
  const enabled = analyticsConfig.warmup.enabled;
  if (!enabled) return;

  const intervalMs = analyticsConfig.warmup.intervalMs;

  const trigger = async (source: "startup" | "interval") => {
    try {
      await runWarmupPass();
      if (source === "startup") {
        analyticsLogger.info("warmup startup pass completed");
      }
    } catch (err: any) {
      analyticsLogger.throttledError(`warmup-${source}-failed`, `${source} warmup pass failed`, {
        error: err,
        throttleMs: 60_000,
      });
    }
  };

  const startupDelayMs = analyticsConfig.warmup.startupDelayMs;
  const startupTimer = setTimeout(() => {
    void trigger("startup");
  }, startupDelayMs);
  startupTimer.unref();
  const timer = setInterval(() => {
    void trigger("interval");
  }, intervalMs);
  timer.unref();
}
