import { FastifyPluginAsync } from "fastify";
import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "../application/analyticsV2";
import {
  publishAnalyticsInvalidation,
  replayAnalyticsInvalidationFromRedis,
  replayAnalyticsInvalidationSince,
  subscribeAnalyticsInvalidation,
} from "../realtime/analyticsV2Realtime";
import { publishCargoPilotDomainEvent } from "../realtime/analyticsEvents";
import { fastifyAuth } from "../../../middleware/authFastify";
import {
  recordAnalyticsRequest,
  recordSseConnected,
  recordSseDisconnected,
} from "../../../modules/observability-core/application/opsMetrics";

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

function getScope(request: any) {
  return {
    role: request.user?.role || "manager",
    warehouseId: request.user?.warehouseId ?? null,
    userId: request.user?.id ?? null,
  };
}

const analyticsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/summary",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (request, reply) => {
      const startedAt = Date.now();
      try {
        const rangeDays = Number((request.query as any)?.rangeDays);
        const staleHours = Number((request.query as any)?.staleHours);
        const result = await getAnalyticsSummaryV2({
          rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
          staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
          scope: getScope(request),
        });

        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({ endpoint: "analytics.summary", cacheHit: result.cacheHit, durationMs });
        return reply.send(result.payload);
      } catch (err: any) {
        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({
          endpoint: "analytics.summary",
          cacheHit: false,
          durationMs,
          isError: true,
        });
        return reply.code(500).send({ error: err?.message || "Failed to load summary" });
      }
    },
  );

  fastify.get(
    "/trend",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (request, reply) => {
      const startedAt = Date.now();
      try {
        const rangeDays = Number((request.query as any)?.rangeDays);
        const result = await getAnalyticsTrendV2({
          rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
          scope: getScope(request),
        });

        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({ endpoint: "analytics.trend", cacheHit: result.cacheHit, durationMs });
        return reply.send(result.payload);
      } catch (err: any) {
        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({ endpoint: "analytics.trend", cacheHit: false, durationMs, isError: true });
        return reply.code(500).send({ error: err?.message || "Failed to load trend" });
      }
    },
  );

  fastify.get(
    "/warnings",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (request, reply) => {
      const startedAt = Date.now();
      try {
        const rangeDays = Number((request.query as any)?.rangeDays);
        const staleHours = Number((request.query as any)?.staleHours);
        const result = await getAnalyticsWarningsV2({
          rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
          staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
          scope: getScope(request),
        });

        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({ endpoint: "analytics.warnings", cacheHit: result.cacheHit, durationMs });
        return reply.send(result.payload);
      } catch (err: any) {
        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({ endpoint: "analytics.warnings", cacheHit: false, durationMs, isError: true });
        return reply.code(500).send({ error: err?.message || "Failed to load warnings" });
      }
    },
  );

  fastify.get(
    "/finance-queue",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (request, reply) => {
      const startedAt = Date.now();
      try {
        const query = request.query as any;
        const queuePage = Number(query.queuePage);
        const queuePageSize = Number(query.queuePageSize);
        const queueStatuses = asStringArray(query.queueStatuses).sort();
        const queueKinds = asStringArray(query.queueKinds).sort();
        const queueHolderTypes = asStringArray(query.queueHolderTypes).sort();

        const result = await getAnalyticsFinanceQueueV2({
          queuePage: Number.isFinite(queuePage) ? queuePage : undefined,
          queuePageSize: Number.isFinite(queuePageSize) ? queuePageSize : undefined,
          queueFrom: parseDateStart(query.queueFrom),
          queueTo: parseDateEndExclusive(query.queueTo),
          queueStatuses,
          queueKinds,
          queueHolderTypes,
          scope: getScope(request),
        });

        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Cache", result.cacheHit ? "HIT" : "MISS");
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({ endpoint: "analytics.finance-queue", cacheHit: result.cacheHit, durationMs });
        return reply.send(result.payload);
      } catch (err: any) {
        const durationMs = Date.now() - startedAt;
        reply.header("X-Analytics-V2-Time-Ms", String(durationMs));
        recordAnalyticsRequest({ endpoint: "analytics.finance-queue", cacheHit: false, durationMs, isError: true });
        return reply.code(500).send({ error: err?.message || "Failed to load finance queue" });
      }
    },
  );

  fastify.post(
    "/refresh",
    { preHandler: fastifyAuth({ permission: "orders.write" }) },
    async (_request, reply) => {
      try {
        await publishAnalyticsInvalidation("manual_refresh");
        await publishCargoPilotDomainEvent({
          type: "manual_refresh",
          tenantScope: "role:manager",
          entityId: null,
          payload: { source: "manager.analytics.refresh" },
        });
        return reply.send({ ok: true });
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message || "Failed to refresh analytics" });
      }
    },
  );

  fastify.get(
    "/stream",
    { preHandler: fastifyAuth({ permission: "orders.read" }) },
    async (request, reply) => {
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no");
      reply.raw.flushHeaders?.();

      const clientKey = `${request.user?.id || "anon"}:${request.ip || "ip"}`;
      const lastEventId = String(
        request.headers["last-event-id"] || request.headers["Last-Event-ID"] || "",
      ).trim();

      recordSseConnected({ stream: "analytics", clientKey });
      let closed = false;

      const send = (event: string, payload: unknown, id?: string | null) => {
        if (closed) return;
        if (id) reply.raw.write(`id: ${id}\n`);
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      send("ready", { connectedAt: new Date().toISOString(), resumedFrom: lastEventId || null });

      const redisReplayEvents = await replayAnalyticsInvalidationFromRedis({
        lastEventId,
        limit: Number(process.env.ANALYTICS_V2_STREAM_REPLAY_MAX_EVENTS || 250),
      });
      const replayEvents = redisReplayEvents.length
        ? redisReplayEvents
        : replayAnalyticsInvalidationSince(lastEventId);
      const replayLimit = Math.max(10, Number(process.env.ANALYTICS_V2_STREAM_REPLAY_MAX_EVENTS || 250));
      const replaySlice = replayEvents.slice(-replayLimit);

      replaySlice.forEach((event) => {
        send(
          "analytics-refresh",
          {
            at: event.at,
            reason: event.reason,
            scope: event.scope,
            keys: event.keys,
            source: event.source || "api",
          },
          event.id,
        );
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
        if (!closed) reply.raw.write(`: ping ${Date.now()}\n\n`);
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
        send(
          "analytics-refresh",
          {
            at: event.at,
            reason: event.reason,
            scope: event.scope,
            keys: event.keys,
            source: event.source || "api",
          },
          event.id,
        );
      });

      request.raw.on("close", () => {
        closed = true;
        recordSseDisconnected("analytics");
        clearInterval(heartbeat);
        if (scheduledRefresh) clearInterval(scheduledRefresh);
        unsubscribe();
      });

      return reply.hijack();
    },
  );
};

export default analyticsFastifyRoutes;
