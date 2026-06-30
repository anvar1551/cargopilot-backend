import "dotenv/config";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import {
  serializerCompiler,
  validatorCompiler,
} from "@fastify/type-provider-zod";
import prisma from "./config/prismaClient";
import { loadAppEnv } from "./config/env";
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
import { startSupportSlaMonitorWorker } from "./modules/support-core/application/supportSlaMonitor";
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

async function start() {
  const env = loadAppEnv();

  const fastify = Fastify({
    trustProxy: env.TRUST_PROXY,
    logger: false,
    bodyLimit: env.FASTIFY_BODY_LIMIT_BYTES,
  });
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  const allowedOrigins = env.allowedOrigins;
  const allowedOriginSet = new Set(allowedOrigins);

  await fastify.register(fastifyCors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, false);
        return;
      }
      if (allowedOriginSet.size === 0 || allowedOriginSet.has(origin)) {
        callback(null, origin);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Accept",
      "Origin",
      "X-Requested-With",
      "Last-Event-ID",
      "Cache-Control",
      "Pragma",
    ],
    maxAge: env.CORS_MAX_AGE_SECONDS,
    strictPreflight: true,
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
  startSupportSlaMonitorWorker();
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

  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`Server running on port ${env.PORT}`);
}

void start().catch((err) => {
  console.error("[server] failed to start", err);
  process.exitCode = 1;
});
