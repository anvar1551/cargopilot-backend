"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const express_1 = __importDefault(require("@fastify/express"));
const prismaClient_1 = __importDefault(require("./config/prismaClient"));
const realtimeHub_1 = require("./features/realtime/realtimeHub");
const notificationRetention_1 = require("./services/notifications/notificationRetention");
const analyticsV2Realtime_1 = require("./features/manager/analyticsV2Realtime");
const analytics_worker_1 = require("./workers/analytics.worker");
const analyticsWarmup_1 = require("./features/manager/analyticsWarmup");
const analyticsOutboxPublisher_1 = require("./features/manager/analyticsOutboxPublisher");
const supportRetention_1 = require("./features/support/supportRetention");
const supportRules_1 = require("./features/support/supportRules");
const buildExpressApp_1 = require("./server/buildExpressApp");
const fastify_routes_1 = __importDefault(require("./modules/orders-core/transport/fastify-routes"));
async function start() {
    const portFromEnv = Number(process.env.PORT);
    const port = Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4000;
    const trustProxy = process.env.TRUST_PROXY === "false" ? false : true;
    const fastify = (0, fastify_1.default)({
        trustProxy,
        logger: false,
        bodyLimit: Number(process.env.FASTIFY_BODY_LIMIT_BYTES || 5 * 1024 * 1024),
    });
    await fastify.register(express_1.default);
    // First native Fastify route: readiness check without Express bridge.
    fastify.get("/api/health", async (_request, reply) => {
        try {
            await prismaClient_1.default.$queryRaw `SELECT 1`;
            return reply.send({ status: "ok" });
        }
        catch (err) {
            return reply
                .code(500)
                .send({ status: "error", error: err?.message ?? "healthcheck failed" });
        }
    });
    // Modular native Fastify transport for orders.
    await fastify.register(fastify_routes_1.default, { prefix: "/api/orders" });
    const { app, allowedOrigins } = (0, buildExpressApp_1.buildExpressApp)();
    fastify.use(app);
    (0, realtimeHub_1.initRealtimeHub)(fastify.server, allowedOrigins);
    (0, notificationRetention_1.startNotificationRetentionWorker)();
    (0, supportRetention_1.startSupportRetentionWorker)();
    (0, supportRules_1.startSupportRulesWorker)();
    (0, analyticsV2Realtime_1.ensureAnalyticsInvalidationConsumer)();
    (0, analyticsWarmup_1.startAnalyticsWarmupLoop)();
    void (0, analyticsOutboxPublisher_1.startAnalyticsOutboxPublisher)();
    const analyticsWorkerInProcessEnv = String(process.env.ANALYTICS_WORKER_IN_PROCESS ?? "")
        .trim()
        .toLowerCase();
    const runAnalyticsWorkerInProcess = analyticsWorkerInProcessEnv === "true" ||
        (process.env.NODE_ENV !== "production" && analyticsWorkerInProcessEnv !== "false");
    if (runAnalyticsWorkerInProcess) {
        void (0, analytics_worker_1.startAnalyticsWorker)({ leaderLock: true });
    }
    await fastify.listen({ port, host: "0.0.0.0" });
    console.log(`Server running on port ${port}`);
}
void start().catch((err) => {
    console.error("[server] failed to start", err);
    process.exitCode = 1;
});
