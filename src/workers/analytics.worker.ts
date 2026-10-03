import { analyticsLogger } from "../modules/analytics-core/config/analyticsLogger";
/** Legacy work stays unconsumed/unacknowledged until durable execution ownership exists. */
export async function startAnalyticsWorker(_options?: { leaderLock?: boolean }) {
  analyticsLogger.throttledWarn("analytics-worker-contained", "Analytics rebuild unavailable: durable selected execution authority required", { throttleMs: 60000 });
}
if (require.main === module) void startAnalyticsWorker();
