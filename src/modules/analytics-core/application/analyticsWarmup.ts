import { analyticsLogger } from "../config/analyticsLogger";
export function startAnalyticsWarmupLoop() {
  analyticsLogger.throttledWarn("analytics-warmup-contained", "Analytics warmup unavailable: durable selected execution authority required", { throttleMs: 60000 });
}
