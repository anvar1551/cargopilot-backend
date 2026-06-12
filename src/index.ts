import "dotenv/config";
import Fastify from "fastify";
import prisma from "./config/prismaClient";
import { getRedisClient, getRedisHealthSnapshot } from "./config/redis";
import { initRealtimeHub } from "./modules/realtime-core/realtimeHub";
import { startNotificationRetentionWorker } from "./modules/notifications-core/application/notificationRetention";
import { ensureAnalyticsInvalidationConsumer } from "./modules/analytics-core/realtime/analyticsV2Realtime";
import { startAnalyticsWorker } from "./workers/analytics.worker";
import { startAnalyticsWarmupLoop } from "./modules/analytics-core/application/analyticsWarmup";
import { startAnalyticsOutboxPublisher } from "./modules/analytics-core/infrastructure/analyticsOutboxPublisher";
import { analyticsConfig } from "./modules/analytics-core/config/analyticsConfig";
import { startSupportRetentionWorker } from "./modules/support-core/application/supportRetention";
import { startSupportRulesWorker } from "./modules/support-core/application/supportRules";
import ordersFastifyRoutes from "./modules/orders-core/transport/fastify-routes";
import pricingFastifyRoutes from "./modules/pricing-core/transport/fastify-routes";
import supportFastifyRoutes from "./modules/support-core/transport/fastify-routes";
import liveMapFastifyRoutes from "./modules/live-map-core/transport/fastify-routes";
import identityAccessFastifyRoutes from "./modules/identity-access/transport/fastify-routes";
import driverFastifyRoutes from "./modules/driver-core/transport/fastify-routes";
import customersFastifyRoutes from "./modules/customers-core/transport/fastify-routes";
import paymentsFastifyRoutes from "./modules/payments-core/transport/fastify-routes";
import trackingFastifyRoutes from "./modules/tracking-core/transport/fastify-routes";
import addressesFastifyRoutes from "./modules/addresses-core/transport/fastify-routes";
import invoiceFastifyRoutes from "./modules/invoice-core/transport/fastify-routes";
import notificationsFastifyRoutes from "./modules/notifications-core/transport/fastify-routes";
import managerFastifyRoutes from "./modules/manager-core/transport/fastify-routes";
import analyticsFastifyRoutes from "./modules/analytics-core/transport/fastify-routes";
import warehouseFastifyRoutes from "./modules/warehouse-core/transport/fastify-routes";
import labelsFastifyRoutes from "./modules/labels-core/transport/fastify-routes";
import organizationsFastifyRoutes from "./modules/organizations-core/transport/fastify-routes";
import integrationsFastifyRoutes from "./modules/integrations-core/transport/fastify-routes";
import { integrationOutboxConfig } from "./modules/integrations-core/config/outbox.config";
import { startIntegrationOutboxPublisher } from "./modules/integrations-core/infrastructure/integration-outbox.publisher";

function resolveAllowedOrigins() {
  return Array.from(
    new Set(
      [
        process.env.CLIENT_URL,
        ...(process.env.CORS_ORIGINS || "")
          .split(",")
          .map((value) => value.trim()),
        ...(process.env.ADDITIONAL_ALLOWED_ORIGINS || "")
          .split(",")
          .map((value) => value.trim()),
      ].filter((value): value is string => Boolean(value)),
    ),
  );
}

async function start() {
  const portFromEnv = Number(process.env.PORT);
  const port = Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4000;
  const trustProxy = process.env.TRUST_PROXY === "false" ? false : true;

  const fastify = Fastify({
    trustProxy,
    logger: false,
    bodyLimit: Number(process.env.FASTIFY_BODY_LIMIT_BYTES || 5 * 1024 * 1024),
  });
  const allowedOrigins = resolveAllowedOrigins();
  const allowedOriginSet = new Set(allowedOrigins);

  fastify.addHook("onRequest", async (request, reply) => {
    const origin = String(request.headers.origin || "");
    if (!origin || allowedOriginSet.size === 0 || allowedOriginSet.has(origin)) {
      if (origin) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Access-Control-Allow-Credentials", "true");
      }
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header(
        "Access-Control-Allow-Headers",
        [
          "Authorization",
          "Content-Type",
          "Accept",
          "Origin",
          "X-Requested-With",
          "Last-Event-ID",
          "Cache-Control",
          "Pragma",
        ].join(","),
      );
      if (request.method === "OPTIONS") {
        return reply.code(204).send();
      }
      return;
    }
    return reply.code(403).send({ error: "CORS origin blocked" });
  });

  // First native Fastify route: readiness check without Express bridge.
  fastify.get("/api/health", async (_request, reply) => {
    const startedAt = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      const redisHealth = await getRedisHealthSnapshot();
      let redisPingMs: number | null = null;
      let redisOk = false;
      if (redisHealth.enabled) {
        const redis = await getRedisClient();
        if (redis) {
          const pingStarted = Date.now();
          await redis.ping();
          redisPingMs = Date.now() - pingStarted;
          redisOk = true;
        }
      }
      const status = redisHealth.enabled && !redisOk ? "degraded" : "ok";
      return reply.send({
        status,
        latencyMs: Date.now() - startedAt,
        db: { ok: true },
        redis: {
          ...redisHealth,
          pingMs: redisPingMs,
          ok: redisHealth.enabled ? redisOk : null,
        },
      });
    } catch (err: any) {
      const redisHealth = await getRedisHealthSnapshot().catch(() => null);
      return reply
        .code(500)
        .send({
          status: "error",
          latencyMs: Date.now() - startedAt,
          error: err?.message ?? "healthcheck failed",
          db: { ok: false },
          redis: redisHealth,
        });
    }
  });

  // Modular native Fastify transport for orders.
  await fastify.register(ordersFastifyRoutes, { prefix: "/api/orders" });
  await fastify.register(pricingFastifyRoutes, { prefix: "/api/pricing" });
  await fastify.register(supportFastifyRoutes, { prefix: "/api/support" });
  await fastify.register(liveMapFastifyRoutes, { prefix: "/api/live-map" });
  await fastify.register(identityAccessFastifyRoutes, { prefix: "/api/auth" });
  await fastify.register(driverFastifyRoutes, { prefix: "/api/drivers" });
  await fastify.register(customersFastifyRoutes, { prefix: "/api/customers" });
  await fastify.register(paymentsFastifyRoutes, { prefix: "/api" });
  await fastify.register(trackingFastifyRoutes, { prefix: "/api/tracking" });
  await fastify.register(addressesFastifyRoutes, { prefix: "/api/addresses" });
  await fastify.register(invoiceFastifyRoutes, { prefix: "/api/invoices" });
  await fastify.register(notificationsFastifyRoutes, { prefix: "/api/notifications" });
  await fastify.register(managerFastifyRoutes, { prefix: "/api/dashboard" });
  await fastify.register(analyticsFastifyRoutes, { prefix: "/api/analytics" });
  await fastify.register(warehouseFastifyRoutes, { prefix: "/api/warehouses" });
  await fastify.register(labelsFastifyRoutes, { prefix: "/api/labels" });
  await fastify.register(organizationsFastifyRoutes, { prefix: "/api/organizations" });
  await fastify.register(integrationsFastifyRoutes, { prefix: "/api/integrations" });

  initRealtimeHub(fastify.server, allowedOrigins);
  startNotificationRetentionWorker();
  startSupportRetentionWorker();
  startSupportRulesWorker();
  ensureAnalyticsInvalidationConsumer();
  if (analyticsConfig.warmup.inApi) {
    startAnalyticsWarmupLoop();
  }
  if (analyticsConfig.outbox.inApi) {
    void startAnalyticsOutboxPublisher();
  }
  if (integrationOutboxConfig.inApi) {
    void startIntegrationOutboxPublisher();
  }

  const runAnalyticsWorkerInProcess = analyticsConfig.worker.inProcess;

  if (runAnalyticsWorkerInProcess) {
    void startAnalyticsWorker({ leaderLock: true });
  }

  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`Server running on port ${port}`);
}

void start().catch((err) => {
  console.error("[server] failed to start", err);
  process.exitCode = 1;
});
