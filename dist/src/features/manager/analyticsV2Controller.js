"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAnalyticsSummaryV2Controller = getAnalyticsSummaryV2Controller;
exports.getAnalyticsTrendV2Controller = getAnalyticsTrendV2Controller;
exports.getAnalyticsWarningsV2Controller = getAnalyticsWarningsV2Controller;
exports.getAnalyticsFinanceQueueV2Controller = getAnalyticsFinanceQueueV2Controller;
exports.forceInvalidateAnalyticsV2Controller = forceInvalidateAnalyticsV2Controller;
exports.streamAnalyticsV2Controller = streamAnalyticsV2Controller;
const analyticsV2_1 = require("./analyticsV2");
const analyticsV2Realtime_1 = require("./analyticsV2Realtime");
const analyticsEvents_1 = require("./analyticsEvents");
const opsMetrics_1 = require("../observability/opsMetrics");
function asStringArray(value) {
    if (!value)
        return [];
    if (Array.isArray(value)) {
        return value
            .flatMap((entry) => String(entry ?? "").split(","))
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return String(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function parseDateStart(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const raw = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}T00:00:00.000Z`);
        return Number.isNaN(date.getTime()) ? undefined : date;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
}
function parseDateEndExclusive(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    const raw = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime()))
            return undefined;
        date.setUTCDate(date.getUTCDate() + 1);
        return date;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime()))
        return undefined;
    return date;
}
function getScope(req) {
    return {
        role: req.user?.role || "manager",
        warehouseId: req.user?.warehouseId ?? null,
        userId: req.user?.id ?? null,
    };
}
async function getAnalyticsSummaryV2Controller(req, res) {
    const startedAt = Date.now();
    try {
        const rangeDays = Number(req.query.rangeDays);
        const staleHours = Number(req.query.staleHours);
        const result = await (0, analyticsV2_1.getAnalyticsSummaryV2)({
            rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
            staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
            scope: getScope(req),
        });
        res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        const durationMs = Date.now() - startedAt;
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.summary",
            cacheHit: result.cacheHit,
            durationMs,
        });
        return res.json(result.payload);
    }
    catch (err) {
        const durationMs = Date.now() - startedAt;
        console.error(`[analytics-v2] summary failed: ${err?.message || "unknown"}`);
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.summary",
            cacheHit: false,
            durationMs,
            isError: true,
        });
        return res.status(500).json({ error: err?.message || "Failed to load summary" });
    }
}
async function getAnalyticsTrendV2Controller(req, res) {
    const startedAt = Date.now();
    try {
        const rangeDays = Number(req.query.rangeDays);
        const result = await (0, analyticsV2_1.getAnalyticsTrendV2)({
            rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
            scope: getScope(req),
        });
        res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        const durationMs = Date.now() - startedAt;
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.trend",
            cacheHit: result.cacheHit,
            durationMs,
        });
        return res.json(result.payload);
    }
    catch (err) {
        const durationMs = Date.now() - startedAt;
        console.error(`[analytics-v2] trend failed: ${err?.message || "unknown"}`);
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.trend",
            cacheHit: false,
            durationMs,
            isError: true,
        });
        return res.status(500).json({ error: err?.message || "Failed to load trend" });
    }
}
async function getAnalyticsWarningsV2Controller(req, res) {
    const startedAt = Date.now();
    try {
        const rangeDays = Number(req.query.rangeDays);
        const staleHours = Number(req.query.staleHours);
        const result = await (0, analyticsV2_1.getAnalyticsWarningsV2)({
            rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
            staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
            scope: getScope(req),
        });
        res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        const durationMs = Date.now() - startedAt;
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.warnings",
            cacheHit: result.cacheHit,
            durationMs,
        });
        return res.json(result.payload);
    }
    catch (err) {
        const durationMs = Date.now() - startedAt;
        console.error(`[analytics-v2] warnings failed: ${err?.message || "unknown"}`);
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.warnings",
            cacheHit: false,
            durationMs,
            isError: true,
        });
        return res.status(500).json({ error: err?.message || "Failed to load warnings" });
    }
}
async function getAnalyticsFinanceQueueV2Controller(req, res) {
    const startedAt = Date.now();
    try {
        const queuePage = Number(req.query.queuePage);
        const queuePageSize = Number(req.query.queuePageSize);
        const queueStatuses = asStringArray(req.query.queueStatuses).sort();
        const queueKinds = asStringArray(req.query.queueKinds).sort();
        const queueHolderTypes = asStringArray(req.query.queueHolderTypes).sort();
        const result = await (0, analyticsV2_1.getAnalyticsFinanceQueueV2)({
            queuePage: Number.isFinite(queuePage) ? queuePage : undefined,
            queuePageSize: Number.isFinite(queuePageSize) ? queuePageSize : undefined,
            queueFrom: parseDateStart(req.query.queueFrom),
            queueTo: parseDateEndExclusive(req.query.queueTo),
            queueStatuses,
            queueKinds,
            queueHolderTypes,
            scope: getScope(req),
        });
        res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        const durationMs = Date.now() - startedAt;
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.finance-queue",
            cacheHit: result.cacheHit,
            durationMs,
        });
        return res.json(result.payload);
    }
    catch (err) {
        const durationMs = Date.now() - startedAt;
        console.error(`[analytics-v2] finance queue failed: ${err?.message || "unknown"}`);
        res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
        (0, opsMetrics_1.recordAnalyticsRequest)({
            endpoint: "analytics.finance-queue",
            cacheHit: false,
            durationMs,
            isError: true,
        });
        return res.status(500).json({ error: err?.message || "Failed to load finance queue" });
    }
}
async function forceInvalidateAnalyticsV2Controller(_req, res) {
    try {
        await (0, analyticsV2Realtime_1.publishAnalyticsInvalidation)("manual_refresh");
        await (0, analyticsEvents_1.publishCargoPilotDomainEvent)({
            type: "manual_refresh",
            tenantScope: "role:manager",
            entityId: null,
            payload: { source: "manager.analytics.refresh" },
        });
        return res.json({ ok: true });
    }
    catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to refresh analytics" });
    }
}
async function streamAnalyticsV2Controller(req, res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const clientKey = `${req.user?.id || "anon"}:${req.ip || "ip"}`;
    const lastEventId = String(req.header("last-event-id") || req.header("Last-Event-ID") || "").trim();
    (0, opsMetrics_1.recordSseConnected)({ stream: "analytics", clientKey });
    let closed = false;
    const send = (event, payload, id) => {
        if (closed)
            return;
        if (id)
            res.write(`id: ${id}\n`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send("ready", { connectedAt: new Date().toISOString(), resumedFrom: lastEventId || null });
    const redisReplayEvents = await (0, analyticsV2Realtime_1.replayAnalyticsInvalidationFromRedis)({
        lastEventId,
        limit: Number(process.env.ANALYTICS_V2_STREAM_REPLAY_MAX_EVENTS || 250),
    });
    const replayEvents = redisReplayEvents.length
        ? redisReplayEvents
        : (0, analyticsV2Realtime_1.replayAnalyticsInvalidationSince)(lastEventId);
    const replayLimit = Math.max(10, Number(process.env.ANALYTICS_V2_STREAM_REPLAY_MAX_EVENTS || 250));
    const replaySlice = replayEvents.slice(-replayLimit);
    replaySlice.forEach((event) => {
        send("analytics-refresh", {
            at: event.at,
            reason: event.reason,
            scope: event.scope,
            keys: event.keys,
            source: event.source || "api",
        }, event.id);
    });
    if (replayEvents.length > replaySlice.length) {
        send("analytics-replay-truncated", {
            skipped: replayEvents.length - replaySlice.length,
            delivered: replaySlice.length,
        });
    }
    const heartbeatMs = Math.max(10000, Number(process.env.ANALYTICS_V2_STREAM_HEARTBEAT_MS || 25000));
    const configuredRefreshMs = Number(process.env.ANALYTICS_V2_STREAM_REFRESH_MS || 0);
    const refreshEveryMs = Number.isFinite(configuredRefreshMs) && configuredRefreshMs > 0
        ? Math.max(30000, configuredRefreshMs)
        : 0;
    const heartbeat = setInterval(() => {
        if (!closed)
            res.write(`: ping ${Date.now()}\n\n`);
    }, heartbeatMs);
    const scheduledRefresh = refreshEveryMs > 0
        ? setInterval(() => {
            send("analytics-refresh", {
                at: new Date().toISOString(),
                reason: "scheduled",
                scope: "global",
                keys: ["summary", "trend"],
                source: "api",
            });
        }, refreshEveryMs)
        : null;
    const unsubscribe = (0, analyticsV2Realtime_1.subscribeAnalyticsInvalidation)((event) => {
        send("analytics-refresh", {
            at: event.at,
            reason: event.reason,
            scope: event.scope,
            keys: event.keys,
            source: event.source || "api",
        }, event.id);
    });
    req.on("close", () => {
        closed = true;
        (0, opsMetrics_1.recordSseDisconnected)("analytics");
        clearInterval(heartbeat);
        if (scheduledRefresh)
            clearInterval(scheduledRefresh);
        unsubscribe();
    });
}
