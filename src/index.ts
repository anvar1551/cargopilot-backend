import "dotenv/config";
import Fastify from "fastify";
import fastifyExpress from "@fastify/express";
import { initRealtimeHub } from "./features/realtime/realtimeHub";
import { startNotificationRetentionWorker } from "./services/notifications/notificationRetention";
import { ensureAnalyticsInvalidationConsumer } from "./features/manager/analyticsV2Realtime";
import { startAnalyticsWorker } from "./workers/analytics.worker";
import { startAnalyticsWarmupLoop } from "./features/manager/analyticsWarmup";
import { startAnalyticsOutboxPublisher } from "./features/manager/analyticsOutboxPublisher";
import { startSupportRetentionWorker } from "./features/support/supportRetention";
import { startSupportRulesWorker } from "./features/support/supportRules";
import { buildExpressApp } from "./server/buildExpressApp";

async function start() {
  const portFromEnv = Number(process.env.PORT);
  const port = Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4000;
  const trustProxy = process.env.TRUST_PROXY === "false" ? false : true;

  const fastify = Fastify({
    trustProxy,
    logger: false,
    bodyLimit: Number(process.env.FASTIFY_BODY_LIMIT_BYTES || 5 * 1024 * 1024),
  });

  await fastify.register(fastifyExpress);

  const { app, allowedOrigins } = buildExpressApp();
  fastify.use(app);

  initRealtimeHub(fastify.server, allowedOrigins);
  startNotificationRetentionWorker();
  startSupportRetentionWorker();
  startSupportRulesWorker();
  ensureAnalyticsInvalidationConsumer();
  startAnalyticsWarmupLoop();
  void startAnalyticsOutboxPublisher();

  const analyticsWorkerInProcessEnv = String(
    process.env.ANALYTICS_WORKER_IN_PROCESS ?? "",
  )
    .trim()
    .toLowerCase();
  const runAnalyticsWorkerInProcess =
    analyticsWorkerInProcessEnv === "true" ||
    (process.env.NODE_ENV !== "production" && analyticsWorkerInProcessEnv !== "false");

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

