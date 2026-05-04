"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAnalyticsRequest = recordAnalyticsRequest;
exports.recordSseConnected = recordSseConnected;
exports.recordSseDisconnected = recordSseDisconnected;
exports.recordAnalyticsWorkerConsumed = recordAnalyticsWorkerConsumed;
exports.recordAnalyticsWorkerRebuild = recordAnalyticsWorkerRebuild;
exports.recordAnalyticsWorkerError = recordAnalyticsWorkerError;
exports.getOpsMetricsSnapshot = getOpsMetricsSnapshot;
const MAX_SAMPLES = Math.max(200, Math.min(20000, Number(process.env.OPS_MAX_DURATION_SAMPLES || 2000)));
const SSE_RECONNECT_WINDOW_MS = Math.max(2000, Number(process.env.OPS_SSE_RECONNECT_WINDOW_MS || 12000));
const SSE_CLIENT_KEEP_MS = Math.max(60000, Number(process.env.OPS_SSE_CLIENT_KEEP_MS || 6 * 60000));
const WORKER_LAG_ALERT_MS = Math.max(5000, Number(process.env.OPS_WORKER_LAG_ALERT_MS || 30000));
const ANALYTICS_P95_ALERT_MS = Math.max(200, Number(process.env.OPS_ANALYTICS_P95_ALERT_MS || 1500));
const CACHE_HIT_ALERT_RATIO = Math.min(0.99, Math.max(0.1, Number(process.env.OPS_CACHE_HIT_ALERT_RATIO || 0.7)));
const endpointStats = new Map();
const sseStats = new Map([
    [
        "analytics",
        {
            active: 0,
            totalConnects: 0,
            totalDisconnects: 0,
            reconnectSpikes: 0,
            lastConnectByClient: new Map(),
        },
    ],
    [
        "live-map",
        {
            active: 0,
            totalConnects: 0,
            totalDisconnects: 0,
            reconnectSpikes: 0,
            lastConnectByClient: new Map(),
        },
    ],
]);
const workerState = {
    eventsConsumed: 0,
    rebuildCount: 0,
    errorCount: 0,
    lastEventAt: null,
    lastLagMs: 0,
    lastHeartbeatAt: null,
};
function getEndpoint(endpoint) {
    const existing = endpointStats.get(endpoint);
    if (existing)
        return existing;
    const created = {
        total: 0,
        hits: 0,
        misses: 0,
        errors: 0,
        durationSamples: [],
    };
    endpointStats.set(endpoint, created);
    return created;
}
function pushSample(samples, value) {
    if (!Number.isFinite(value) || value < 0)
        return;
    samples.push(value);
    if (samples.length > MAX_SAMPLES) {
        samples.splice(0, samples.length - MAX_SAMPLES);
    }
}
function percentile(values, q) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
    return sorted[idx];
}
function recordAnalyticsRequest(args) {
    const stats = getEndpoint(args.endpoint);
    stats.total += 1;
    if (args.cacheHit)
        stats.hits += 1;
    else
        stats.misses += 1;
    if (args.isError)
        stats.errors += 1;
    pushSample(stats.durationSamples, args.durationMs);
}
function recordSseConnected(args) {
    const stats = sseStats.get(args.stream);
    if (!stats)
        return;
    const now = Date.now();
    stats.active += 1;
    stats.totalConnects += 1;
    const previous = stats.lastConnectByClient.get(args.clientKey);
    if (previous && now - previous <= SSE_RECONNECT_WINDOW_MS) {
        stats.reconnectSpikes += 1;
    }
    stats.lastConnectByClient.set(args.clientKey, now);
}
function recordSseDisconnected(stream) {
    const stats = sseStats.get(stream);
    if (!stats)
        return;
    stats.active = Math.max(0, stats.active - 1);
    stats.totalDisconnects += 1;
}
function recordAnalyticsWorkerConsumed(args) {
    workerState.eventsConsumed += 1;
    workerState.lastLagMs = Math.max(0, Number(args.lagMs) || 0);
    workerState.lastEventAt = args.occurredAt;
    workerState.lastHeartbeatAt = new Date().toISOString();
}
function recordAnalyticsWorkerRebuild() {
    workerState.rebuildCount += 1;
    workerState.lastHeartbeatAt = new Date().toISOString();
}
function recordAnalyticsWorkerError() {
    workerState.errorCount += 1;
    workerState.lastHeartbeatAt = new Date().toISOString();
}
function summarizeEndpoint(stats) {
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
function getOpsMetricsSnapshot() {
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
    ].reduce((acc, row) => {
        acc.total += row.total;
        acc.hits += row.hits;
        acc.misses += row.misses;
        acc.errors += row.errors;
        return acc;
    }, { total: 0, hits: 0, misses: 0, errors: 0 });
    const cacheHitRatio = analyticsTotal.total > 0 ? analyticsTotal.hits / analyticsTotal.total : 0;
    const worker = {
        ...workerState,
        lagAlert: workerState.lastLagMs > WORKER_LAG_ALERT_MS,
    };
    const alerts = {
        cacheHitBelowThreshold: analyticsTotal.total > 0 && cacheHitRatio < CACHE_HIT_ALERT_RATIO,
        summaryP95Slow: analytics.summary.p95Ms > ANALYTICS_P95_ALERT_MS,
        trendP95Slow: analytics.trend.p95Ms > ANALYTICS_P95_ALERT_MS,
        warningsP95Slow: analytics.warnings.p95Ms > ANALYTICS_P95_ALERT_MS,
        financeQueueP95Slow: analytics.financeQueue.p95Ms > ANALYTICS_P95_ALERT_MS,
        workerLagHigh: worker.lagAlert,
        analyticsReconnectSpike: (sseStats.get("analytics")?.reconnectSpikes ?? 0) > 0,
        liveMapReconnectSpike: (sseStats.get("live-map")?.reconnectSpikes ?? 0) > 0,
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
        },
        worker,
        alerts,
    };
}
