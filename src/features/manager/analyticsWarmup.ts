import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "./analyticsV2";

const defaultScope = {
  role: "manager",
  warehouseId: null as string | null,
  userId: null as string | null,
};

const warmupRangeDays = Math.max(
  7,
  Math.min(180, Number(process.env.ANALYTICS_V3_DEFAULT_RANGE_DAYS || 30)),
);
const warmupStaleHours = Math.max(
  6,
  Math.min(720, Number(process.env.ANALYTICS_WARMUP_STALE_HOURS || 48)),
);
const warmupQueuePageSize = Math.max(
  5,
  Math.min(200, Number(process.env.ANALYTICS_V3_DEFAULT_QUEUE_PAGE_SIZE || 20)),
);

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
  const enabled = process.env.ANALYTICS_WARMUP_ENABLED !== "false";
  if (!enabled) return;

  const intervalMs = Math.max(
    60_000,
    Number(process.env.ANALYTICS_WARMUP_INTERVAL_MS || 240_000),
  );

  const trigger = async (source: "startup" | "interval") => {
    try {
      await runWarmupPass();
      if (source === "startup") {
        console.log("[analytics-warmup] startup pass completed");
      }
    } catch (err: any) {
      console.error(`[analytics-warmup] ${source} pass failed: ${err?.message || "unknown"}`);
    }
  };

  const startupDelayMs = Math.max(
    0,
    Number(process.env.ANALYTICS_WARMUP_STARTUP_DELAY_MS || 30_000),
  );
  const startupTimer = setTimeout(() => {
    void trigger("startup");
  }, startupDelayMs);
  startupTimer.unref();
  const timer = setInterval(() => {
    void trigger("interval");
  }, intervalMs);
  timer.unref();
}
