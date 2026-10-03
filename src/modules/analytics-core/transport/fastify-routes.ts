import { FastifyPluginAsync } from "fastify";
import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "../application/analyticsV2";
import { requireAnalyticsScope } from "../application/analyticsScope";
import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import { recordAnalyticsRequest } from "../../../modules/observability-core/application/opsMetrics";
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

function actor(request: any) {
  if (!request.user) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  return request.user;
}
function failure(reply: any, error: any) {
  const status = [400, 401, 403, 409].includes(error?.statusCode) ? error.statusCode : 500;
  return reply.code(status).send({ error: status === 500 ? "Analytics unavailable" : status === 400 ? "Invalid analytics request" : "Selected analytics context unavailable" });
}

const analyticsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/summary",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const startedAt = Date.now();
      try {
        const rangeDays = Number((request.query as any)?.rangeDays);
        const staleHours = Number((request.query as any)?.staleHours);
        const result = await getAnalyticsSummaryV2({
          rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
          staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
          actor: actor(request),
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
        return failure(reply, err);
      }
    },
  );

  fastify.get(
    "/trend",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const startedAt = Date.now();
      try {
        const rangeDays = Number((request.query as any)?.rangeDays);
        const result = await getAnalyticsTrendV2({
          rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
          actor: actor(request),
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
        return failure(reply, err);
      }
    },
  );

  fastify.get(
    "/warnings",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const startedAt = Date.now();
      try {
        const rangeDays = Number((request.query as any)?.rangeDays);
        const staleHours = Number((request.query as any)?.staleHours);
        const result = await getAnalyticsWarningsV2({
          rangeDays: Number.isFinite(rangeDays) ? rangeDays : undefined,
          staleHours: Number.isFinite(staleHours) ? staleHours : undefined,
          actor: actor(request),
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
        return failure(reply, err);
      }
    },
  );

  fastify.get(
    "/finance-queue",
    { preHandler: fastifyAuth({ permission: "shipment.view" }) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const startedAt = Date.now();
      try {
        const query = request.query as any;
        const queuePage = Number(query.queuePage);
        const queuePageSize = Number(query.queuePageSize);
        const queueStatuses = asStringArray(query.queueStatuses).sort();
        const queueKinds = asStringArray(query.queueKinds).sort();
        const queueHolderTypes = asStringArray(query.queueHolderTypes).sort();

        const from = parseDateStart(query.queueFrom), to = parseDateEndExclusive(query.queueTo);
        if ((query.queueFrom !== undefined && !from) || (query.queueTo !== undefined && !to)) throw Object.assign(new Error("Invalid dates"), { statusCode: 400 });
        const result = await getAnalyticsFinanceQueueV2({
          queuePage: Number.isFinite(queuePage) ? queuePage : undefined,
          queuePageSize: Number.isFinite(queuePageSize) ? queuePageSize : undefined,
          queueFrom: from,
          queueTo: to,
          queueStatuses,
          queueKinds,
          queueHolderTypes,
          actor: actor(request),
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
        return failure(reply, err);
      }
    },
  );

  fastify.post("/refresh", { preHandler: fastifyAuth({ permission: "shipment.update" }) }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      await requireAnalyticsScope(actor(request), "shipment.update");
      await requireAnalyticsScope(actor(request), "shipment.view");
      // Reads are uncached: no global invalidation event or context-free rebuild.
      return reply.send({ ok: true });
    } catch (error) { return failure(reply, error); }
  });
  fastify.get("/stream", { preHandler: fastifyAuth({ permission: "shipment.view" }) }, async (_request, reply) => {
    return reply.header("Cache-Control", "no-store").code(409).send({ error: "Selected-context analytics streaming is unavailable", code: "ANALYTICS_STREAM_UNAVAILABLE" });
  });
};
export default analyticsFastifyRoutes;
