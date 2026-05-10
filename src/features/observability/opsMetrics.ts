type AnalyticsEndpoint =
  | "analytics.summary"
  | "analytics.trend"
  | "analytics.warnings"
  | "analytics.finance-queue";

type SseStream = "analytics" | "live-map" | "support";

type EndpointStats = {
  total: number;
  hits: number;
  misses: number;
  errors: number;
  durationSamples: number[];
};

type SseStats = {
  active: number;
  totalConnects: number;
  totalDisconnects: number;
  reconnectSpikes: number;
  lastConnectByClient: Map<string, number>;
};

const MAX_SAMPLES = Math.max(
  200,
  Math.min(20_000, Number(process.env.OPS_MAX_DURATION_SAMPLES || 2000)),
);
const SSE_RECONNECT_WINDOW_MS = Math.max(
  2000,
  Number(process.env.OPS_SSE_RECONNECT_WINDOW_MS || 12_000),
);
const SSE_CLIENT_KEEP_MS = Math.max(
  60_000,
  Number(process.env.OPS_SSE_CLIENT_KEEP_MS || 6 * 60_000),
);
const WORKER_LAG_ALERT_MS = Math.max(
  5_000,
  Number(process.env.OPS_WORKER_LAG_ALERT_MS || 30_000),
);
const ANALYTICS_P95_ALERT_MS = Math.max(
  200,
  Number(process.env.OPS_ANALYTICS_P95_ALERT_MS || 1500),
);
const CACHE_HIT_ALERT_RATIO = Math.min(
  0.99,
  Math.max(0.1, Number(process.env.OPS_CACHE_HIT_ALERT_RATIO || 0.7)),
);

const endpointStats = new Map<AnalyticsEndpoint, EndpointStats>();
const sseStats = new Map<SseStream, SseStats>([
  [
    "analytics",
    {
      active: 0,
      totalConnects: 0,
      totalDisconnects: 0,
      reconnectSpikes: 0,
      lastConnectByClient: new Map<string, number>(),
    },
  ],
  [
    "live-map",
    {
      active: 0,
      totalConnects: 0,
      totalDisconnects: 0,
      reconnectSpikes: 0,
      lastConnectByClient: new Map<string, number>(),
    },
  ],
  [
    "support",
    {
      active: 0,
      totalConnects: 0,
      totalDisconnects: 0,
      reconnectSpikes: 0,
      lastConnectByClient: new Map<string, number>(),
    },
  ],
]);

const workerState = {
  eventsConsumed: 0,
  rebuildCount: 0,
  errorCount: 0,
  lastEventAt: null as string | null,
  lastLagMs: 0,
  lastHeartbeatAt: null as string | null,
};

function getEndpoint(endpoint: AnalyticsEndpoint): EndpointStats {
  const existing = endpointStats.get(endpoint);
  if (existing) return existing;
  const created: EndpointStats = {
    total: 0,
    hits: 0,
    misses: 0,
    errors: 0,
    durationSamples: [],
  };
  endpointStats.set(endpoint, created);
  return created;
}

function pushSample(samples: number[], value: number) {
  if (!Number.isFinite(value) || value < 0) return;
  samples.push(value);
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
}

function percentile(values: number[], q: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

export function recordAnalyticsRequest(args: {
  endpoint: AnalyticsEndpoint;
  cacheHit: boolean;
  durationMs: number;
  isError?: boolean;
}) {
  const stats = getEndpoint(args.endpoint);
  stats.total += 1;
  if (args.cacheHit) stats.hits += 1;
  else stats.misses += 1;
  if (args.isError) stats.errors += 1;
  pushSample(stats.durationSamples, args.durationMs);
}

export function recordSseConnected(args: {
  stream: SseStream;
  clientKey: string;
}) {
  const stats = sseStats.get(args.stream);
  if (!stats) return;
  const now = Date.now();
  stats.active += 1;
  stats.totalConnects += 1;
  const previous = stats.lastConnectByClient.get(args.clientKey);
  if (previous && now - previous <= SSE_RECONNECT_WINDOW_MS) {
    stats.reconnectSpikes += 1;
  }
  stats.lastConnectByClient.set(args.clientKey, now);
}

export function recordSseDisconnected(stream: SseStream) {
  const stats = sseStats.get(stream);
  if (!stats) return;
  stats.active = Math.max(0, stats.active - 1);
  stats.totalDisconnects += 1;
}

export function recordAnalyticsWorkerConsumed(args: {
  lagMs: number;
  occurredAt: string | null;
}) {
  workerState.eventsConsumed += 1;
  workerState.lastLagMs = Math.max(0, Number(args.lagMs) || 0);
  workerState.lastEventAt = args.occurredAt;
  workerState.lastHeartbeatAt = new Date().toISOString();
}

export function recordAnalyticsWorkerRebuild() {
  workerState.rebuildCount += 1;
  workerState.lastHeartbeatAt = new Date().toISOString();
}

export function recordAnalyticsWorkerError() {
  workerState.errorCount += 1;
  workerState.lastHeartbeatAt = new Date().toISOString();
}

function summarizeEndpoint(stats: EndpointStats) {
  const hitRatio = stats.total > 0 ? stats.hits / stats.total : 0;
  return {
    total: stats.total,
    hits: stats.hits,
    misses: stats.misses,
    errors: stats.errors,
    hitRatio,
    p50Ms: percentile(stats.durationSamples, 0.5),
    p95Ms: percentile(stats.durationSamples, 0.95),
  };
}

export function getOpsMetricsSnapshot() {
  const now = Date.now();
  for (const stats of sseStats.values()) {
    for (const [key, value] of stats.lastConnectByClient.entries()) {
      if (now - value > SSE_CLIENT_KEEP_MS) {
        stats.lastConnectByClient.delete(key);
      }
    }
  }

  const analytics = {
    summary: summarizeEndpoint(getEndpoint("analytics.summary")),
    trend: summarizeEndpoint(getEndpoint("analytics.trend")),
    warnings: summarizeEndpoint(getEndpoint("analytics.warnings")),
    financeQueue: summarizeEndpoint(getEndpoint("analytics.finance-queue")),
  };

  const analyticsTotal = [
    analytics.summary,
    analytics.trend,
    analytics.warnings,
    analytics.financeQueue,
  ].reduce(
    (acc, row) => {
      acc.total += row.total;
      acc.hits += row.hits;
      acc.misses += row.misses;
      acc.errors += row.errors;
      return acc;
    },
    { total: 0, hits: 0, misses: 0, errors: 0 },
  );
  const cacheHitRatio =
    analyticsTotal.total > 0 ? analyticsTotal.hits / analyticsTotal.total : 0;

  const worker = {
    ...workerState,
    lagAlert: workerState.lastLagMs > WORKER_LAG_ALERT_MS,
  };

  const alerts = {
    cacheHitBelowThreshold:
      analyticsTotal.total > 0 && cacheHitRatio < CACHE_HIT_ALERT_RATIO,
    summaryP95Slow: analytics.summary.p95Ms > ANALYTICS_P95_ALERT_MS,
    trendP95Slow: analytics.trend.p95Ms > ANALYTICS_P95_ALERT_MS,
    warningsP95Slow: analytics.warnings.p95Ms > ANALYTICS_P95_ALERT_MS,
    financeQueueP95Slow: analytics.financeQueue.p95Ms > ANALYTICS_P95_ALERT_MS,
    workerLagHigh: worker.lagAlert,
    analyticsReconnectSpike:
      (sseStats.get("analytics")?.reconnectSpikes ?? 0) > 0,
    liveMapReconnectSpike:
      (sseStats.get("live-map")?.reconnectSpikes ?? 0) > 0,
    supportReconnectSpike:
      (sseStats.get("support")?.reconnectSpikes ?? 0) > 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    analytics: {
      ...analytics,
      totals: {
        ...analyticsTotal,
        cacheHitRatio,
      },
    },
    sse: {
      analytics: (() => {
        const stats = sseStats.get("analytics");
        return {
          active: stats?.active ?? 0,
          totalConnects: stats?.totalConnects ?? 0,
          totalDisconnects: stats?.totalDisconnects ?? 0,
          reconnectSpikes: stats?.reconnectSpikes ?? 0,
        };
      })(),
      liveMap: (() => {
        const stats = sseStats.get("live-map");
        return {
          active: stats?.active ?? 0,
          totalConnects: stats?.totalConnects ?? 0,
          totalDisconnects: stats?.totalDisconnects ?? 0,
          reconnectSpikes: stats?.reconnectSpikes ?? 0,
        };
      })(),
      support: (() => {
        const stats = sseStats.get("support");
        return {
          active: stats?.active ?? 0,
          totalConnects: stats?.totalConnects ?? 0,
          totalDisconnects: stats?.totalDisconnects ?? 0,
          reconnectSpikes: stats?.reconnectSpikes ?? 0,
        };
      })(),
    },
    worker,
    alerts,
  };
}
