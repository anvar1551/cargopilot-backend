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
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  recordAnalyticsRequest,
  recordSseConnected,
  recordSseDisconnected,
} from "../../../modules/observability-core/application/opsMetrics";
import { analyticsConfig } from "../config/analyticsConfig";

function isWritableStream(stream: NodeJS.WritableStream & { destroyed?: boolean }) {
  return !stream.destroyed && (stream as any).writable !== false;
}

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
  const permissionCodes = Array.isArray(request.user?.permissionCodes)
    ? request.user.permissionCodes
    : [];
  const roleCodes = Array.isArray(request.user?.roleCodes)
    ? request.user.roleCodes.map((value: unknown) => String(value || "").toLowerCase())
    : [];
  const isManagerScope =
    permissionCodes.includes("drivers.manage") ||
    roleCodes.includes("manager") ||
    roleCodes.includes("admin") ||
    roleCodes.includes("super_admin") ||
    roleCodes.includes("owner");
  return {
    role: isManagerScope ? "manager" : request.user?.warehouseId ? "warehouse" : "global",
    warehouseId: request.user?.warehouseId ?? null,
    userId: request.user?.id ?? null,
  };
}

const analyticsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/summary",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
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
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
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
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
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
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
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
    { preHandler: fastifyAuth({ permission: "shipment.update" }) },
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
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
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
      let disconnected = false;

      const send = (event: string, payload: unknown, id?: string | null) => {
        if (closed || !isWritableStream(reply.raw)) return false;
        try {
          if (id) reply.raw.write(`id: ${id}\n`);
          reply.raw.write(`event: ${event}\n`);
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          return true;
        } catch {
          return false;
        }
      };

      if (!send("ready", { connectedAt: new Date().toISOString(), resumedFrom: lastEventId || null })) {
        recordSseDisconnected("analytics");
        return reply.hijack();
      }

      const redisReplayEvents = await replayAnalyticsInvalidationFromRedis({
        lastEventId,
        limit: analyticsConfig.stream.replayMaxEvents,
      });
      const replayEvents = redisReplayEvents.length
        ? redisReplayEvents
        : replayAnalyticsInvalidationSince(lastEventId);
      const replayLimit = analyticsConfig.stream.replayMaxEvents;
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

      const heartbeatMs = analyticsConfig.stream.heartbeatMs;
      const refreshEveryMs = analyticsConfig.stream.refreshMs;

      const heartbeat = setInterval(() => {
        if (closed || !isWritableStream(reply.raw)) return;
        try {
          reply.raw.write(`: ping ${Date.now()}\n\n`);
        } catch {
          closed = true;
        }
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
        const sent = send(
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
        if (!sent) closed = true;
      });

      const onClose = () => {
        if (disconnected) return;
        disconnected = true;
        closed = true;
        recordSseDisconnected("analytics");
        clearInterval(heartbeat);
        if (scheduledRefresh) clearInterval(scheduledRefresh);
        unsubscribe();
      };

      request.raw.on("close", onClose);
      reply.raw.on("close", onClose);
      reply.raw.on("error", onClose);

      return reply.hijack();
    },
  );
};

export default analyticsFastifyRoutes;

