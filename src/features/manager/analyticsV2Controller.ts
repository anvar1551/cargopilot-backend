import { Request, Response } from "express";
import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "./analyticsV2";
import {
  publishAnalyticsInvalidation,
  replayAnalyticsInvalidationFromRedis,
  replayAnalyticsInvalidationSince,
  subscribeAnalyticsInvalidation,
} from "./analyticsV2Realtime";
import { publishCargoPilotDomainEvent } from "./analyticsEvents";
import {
  recordAnalyticsRequest,
  recordSseConnected,
  recordSseDisconnected,
} from "../observability/opsMetrics";

function asStringArray(value: unknown): string[] {
  if (!value) return [];
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

function parseDateStart(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseDateEndExclusive(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return undefined;
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function getScope(req: Request) {
  return {
    role: req.user?.role || "manager",
    warehouseId: req.user?.warehouseId ?? null,
    userId: req.user?.id ?? null,
  };
}

export async function getAnalyticsSummaryV2Controller(req: Request, res: Response) {
  const startedAt = Date.now();
  try {
    const rangeDays = Number(req.query.rangeDays);
    const staleHours = Number(req.query.staleHours);
    const result = await getAnalyticsSummaryV2({
      rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
      staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
      scope: getScope(req),
    });
    res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
    const durationMs = Date.now() - startedAt;
    res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
    recordAnalyticsRequest({
      endpoint: "analytics.summary",
      cacheHit: result.cacheHit,
      durationMs,
    });
    return res.json(result.payload);
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    console.error(`[analytics-v2] summary failed: ${err?.message || "unknown"}`);
    res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
    recordAnalyticsRequest({
      endpoint: "analytics.summary",
      cacheHit: false,
      durationMs,
      isError: true,
    });
    return res.status(500).json({ error: err?.message || "Failed to load summary" });
  }
}

export async function getAnalyticsTrendV2Controller(req: Request, res: Response) {
  const startedAt = Date.now();
  try {
    const rangeDays = Number(req.query.rangeDays);
    const result = await getAnalyticsTrendV2({
      rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
      scope: getScope(req),
    });
    res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
    const durationMs = Date.now() - startedAt;
    res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
    recordAnalyticsRequest({
      endpoint: "analytics.trend",
      cacheHit: result.cacheHit,
      durationMs,
    });
    return res.json(result.payload);
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    console.error(`[analytics-v2] trend failed: ${err?.message || "unknown"}`);
    res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
    recordAnalyticsRequest({
      endpoint: "analytics.trend",
      cacheHit: false,
      durationMs,
      isError: true,
    });
    return res.status(500).json({ error: err?.message || "Failed to load trend" });
  }
}

export async function getAnalyticsWarningsV2Controller(req: Request, res: Response) {
  const startedAt = Date.now();
  try {
    const rangeDays = Number(req.query.rangeDays);
    const staleHours = Number(req.query.staleHours);
    const result = await getAnalyticsWarningsV2({
      rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
      staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
      scope: getScope(req),
    });
    res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
    const durationMs = Date.now() - startedAt;
    res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
    recordAnalyticsRequest({
      endpoint: "analytics.warnings",
      cacheHit: result.cacheHit,
      durationMs,
    });
    return res.json(result.payload);
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    console.error(`[analytics-v2] warnings failed: ${err?.message || "unknown"}`);
    res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
    recordAnalyticsRequest({
      endpoint: "analytics.warnings",
      cacheHit: false,
      durationMs,
      isError: true,
    });
    return res.status(500).json({ error: err?.message || "Failed to load warnings" });
  }
}

export async function getAnalyticsFinanceQueueV2Controller(req: Request, res: Response) {
  const startedAt = Date.now();
  try {
    const queuePage = Number(req.query.queuePage);
    const queuePageSize = Number(req.query.queuePageSize);
    const queueStatuses = asStringArray(req.query.queueStatuses).sort();
    const queueKinds = asStringArray(req.query.queueKinds).sort();
    const queueHolderTypes = asStringArray(req.query.queueHolderTypes).sort();

    const result = await getAnalyticsFinanceQueueV2({
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
    recordAnalyticsRequest({
      endpoint: "analytics.finance-queue",
      cacheHit: result.cacheHit,
      durationMs,
    });
    return res.json(result.payload);
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    console.error(`[analytics-v2] finance queue failed: ${err?.message || "unknown"}`);
    res.setHeader("X-Analytics-V2-Time-Ms", String(durationMs));
    recordAnalyticsRequest({
      endpoint: "analytics.finance-queue",
      cacheHit: false,
      durationMs,
      isError: true,
    });
    return res.status(500).json({ error: err?.message || "Failed to load finance queue" });
  }
}

export async function forceInvalidateAnalyticsV2Controller(_req: Request, res: Response) {
  try {
    await publishAnalyticsInvalidation("manual_refresh");
    await publishCargoPilotDomainEvent({
      type: "manual_refresh",
      tenantScope: "role:manager",
      entityId: null,
      payload: { source: "manager.analytics.refresh" },
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to refresh analytics" });
  }
}

export async function streamAnalyticsV2Controller(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const clientKey = `${req.user?.id || "anon"}:${req.ip || "ip"}`;
  const lastEventId = String(req.header("last-event-id") || req.header("Last-Event-ID") || "").trim();
  recordSseConnected({ stream: "analytics", clientKey });
  let closed = false;
  let sequence = 0;

  const send = (event: string, payload: unknown) => {
    if (closed) return;
    sequence += 1;
    res.write(`id: ${sequence}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send("ready", { connectedAt: new Date().toISOString(), resumedFrom: lastEventId || null });
  const replayEvents =
    (await replayAnalyticsInvalidationFromRedis({
      lastEventId,
      limit: Number(process.env.ANALYTICS_V2_STREAM_REPLAY_MAX_EVENTS || 250),
    })) || replayAnalyticsInvalidationSince(lastEventId);
  const replayLimit = Math.max(10, Number(process.env.ANALYTICS_V2_STREAM_REPLAY_MAX_EVENTS || 250));
  const replaySlice = replayEvents.slice(-replayLimit);
  replaySlice.forEach((event) => {
    send("analytics-refresh", {
      at: event.at,
      reason: event.reason,
      scope: event.scope,
      keys: event.keys,
      source: event.source || "api",
    });
  });
  if (replayEvents.length > replaySlice.length) {
    send("analytics-replay-truncated", {
      skipped: replayEvents.length - replaySlice.length,
      delivered: replaySlice.length,
    });
  }

  const heartbeatMs = Math.max(
    10_000,
    Number(process.env.ANALYTICS_V2_STREAM_HEARTBEAT_MS || 25_000),
  );
  const configuredRefreshMs = Number(process.env.ANALYTICS_V2_STREAM_REFRESH_MS || 0);
  const refreshEveryMs = Number.isFinite(configuredRefreshMs) && configuredRefreshMs > 0
    ? Math.max(30_000, configuredRefreshMs)
    : 0;

  const heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, heartbeatMs);

  const scheduledRefresh =
    refreshEveryMs > 0
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

  const unsubscribe = subscribeAnalyticsInvalidation((event) => {
    send("analytics-refresh", {
      at: event.at,
      reason: event.reason,
      scope: event.scope,
      keys: event.keys,
      source: event.source || "api",
    });
  });

  req.on("close", () => {
    closed = true;
    recordSseDisconnected("analytics");
    clearInterval(heartbeat);
    if (scheduledRefresh) clearInterval(scheduledRefresh);
    unsubscribe();
  });
}
