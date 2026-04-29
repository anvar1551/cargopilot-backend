import { Request, Response } from "express";
import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "./analyticsV2";
import {
  publishAnalyticsInvalidation,
  subscribeAnalyticsInvalidation,
} from "./analyticsV2Realtime";

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
  try {
    const rangeDays = Number(req.query.rangeDays);
    const staleHours = Number(req.query.staleHours);
    const result = await getAnalyticsSummaryV2({
      rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
      staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
      scope: getScope(req),
    });
    res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
    return res.json(result.payload);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load summary" });
  }
}

export async function getAnalyticsTrendV2Controller(req: Request, res: Response) {
  try {
    const rangeDays = Number(req.query.rangeDays);
    const result = await getAnalyticsTrendV2({
      rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
      scope: getScope(req),
    });
    res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
    return res.json(result.payload);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load trend" });
  }
}

export async function getAnalyticsWarningsV2Controller(req: Request, res: Response) {
  try {
    const rangeDays = Number(req.query.rangeDays);
    const staleHours = Number(req.query.staleHours);
    const result = await getAnalyticsWarningsV2({
      rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
      staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
      scope: getScope(req),
    });
    res.setHeader("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
    return res.json(result.payload);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load warnings" });
  }
}

export async function getAnalyticsFinanceQueueV2Controller(req: Request, res: Response) {
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
    return res.json(result.payload);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Failed to load finance queue" });
  }
}

export async function forceInvalidateAnalyticsV2Controller(_req: Request, res: Response) {
  try {
    await publishAnalyticsInvalidation("manual_refresh");
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

  let closed = false;

  const send = (event: string, payload: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send("ready", { connectedAt: new Date().toISOString() });

  const heartbeatMs = Math.max(
    10_000,
    Number(process.env.ANALYTICS_V2_STREAM_HEARTBEAT_MS || 25_000),
  );
  const refreshEveryMs = Math.max(
    30_000,
    Number(process.env.ANALYTICS_V2_STREAM_REFRESH_MS || 60_000),
  );

  const heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, heartbeatMs);

  const scheduledRefresh = setInterval(() => {
    send("analytics-refresh", {
      at: new Date().toISOString(),
      reason: "scheduled",
    });
  }, refreshEveryMs);

  const unsubscribe = subscribeAnalyticsInvalidation((event) => {
    send("analytics-refresh", {
      at: event.at,
      reason: event.reason,
    });
  });

  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    clearInterval(scheduledRefresh);
    unsubscribe();
  });
}

