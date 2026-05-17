"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const prismaClient_1 = __importDefault(require("./config/prismaClient"));
const realtimeHub_1 = require("./modules/realtime-core/realtimeHub");
const notificationRetention_1 = require("./modules/notifications-core/application/notificationRetention");
const analyticsV2Realtime_1 = require("./modules/analytics-core/realtime/analyticsV2Realtime");
const analytics_worker_1 = require("./workers/analytics.worker");
const analyticsWarmup_1 = require("./modules/analytics-core/application/analyticsWarmup");
const analyticsOutboxPublisher_1 = require("./modules/analytics-core/infrastructure/analyticsOutboxPublisher");
const supportRetention_1 = require("./modules/support-core/application/supportRetention");
const supportRules_1 = require("./modules/support-core/application/supportRules");
const fastify_routes_1 = __importDefault(require("./modules/orders-core/transport/fastify-routes"));
const fastify_routes_2 = __importDefault(require("./modules/pricing-core/transport/fastify-routes"));
const fastify_routes_3 = __importDefault(require("./modules/support-core/transport/fastify-routes"));
const fastify_routes_4 = __importDefault(require("./modules/live-map-core/transport/fastify-routes"));
const fastify_routes_5 = __importDefault(require("./modules/users-core/transport/fastify-routes"));
const fastify_routes_6 = __importDefault(require("./modules/driver-core/transport/fastify-routes"));
const fastify_routes_7 = __importDefault(require("./modules/customers-core/transport/fastify-routes"));
const fastify_routes_8 = __importDefault(require("./modules/payments-core/transport/fastify-routes"));
const fastify_routes_9 = __importDefault(require("./modules/tracking-core/transport/fastify-routes"));
const fastify_routes_10 = __importDefault(require("./modules/addresses-core/transport/fastify-routes"));
const fastify_routes_11 = __importDefault(require("./modules/invoice-core/transport/fastify-routes"));
const fastify_routes_12 = __importDefault(require("./modules/notifications-core/transport/fastify-routes"));
const fastify_routes_13 = __importDefault(require("./modules/manager-core/transport/fastify-routes"));
const fastify_routes_14 = __importDefault(require("./modules/analytics-core/transport/fastify-routes"));
const fastify_routes_15 = __importDefault(require("./modules/warehouse-core/transport/fastify-routes"));
const fastify_routes_16 = __importDefault(require("./modules/labels-core/transport/fastify-routes"));
const fastify_routes_17 = __importDefault(require("./modules/webhooks-core/transport/fastify-routes"));
function resolveAllowedOrigins() {
    return Array.from(new Set([
        process.env.CLIENT_URL,
        ...(process.env.CORS_ORIGINS || "")
            .split(",")
            .map((value) => value.trim()),
        ...(process.env.ADDITIONAL_ALLOWED_ORIGINS || "")
            .split(",")
            .map((value) => value.trim()),
    ].filter((value) => Boolean(value))));
}
async function start() {
    const portFromEnv = Number(process.env.PORT);
    const port = Number.isFinite(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4000;
    const trustProxy = process.env.TRUST_PROXY === "false" ? false : true;
    const fastify = (0, fastify_1.default)({
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
            reply.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept,Origin,X-Requested-With,Last-Event-ID");
            if (request.method === "OPTIONS") {
                return reply.code(204).send();
            }
            return;
        }
        return reply.code(403).send({ error: "CORS origin blocked" });
    });
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
    await fastify.register(fastify_routes_2.default, { prefix: "/api/pricing" });
    await fastify.register(fastify_routes_3.default, { prefix: "/api/manager/support" });
    await fastify.register(fastify_routes_4.default, { prefix: "/api/manager/live-map" });
    await fastify.register(fastify_routes_5.default, { prefix: "/api/auth" });
    await fastify.register(fastify_routes_6.default, { prefix: "/api/drivers" });
    await fastify.register(fastify_routes_7.default, { prefix: "/api/customers" });
    await fastify.register(fastify_routes_8.default, { prefix: "/api" });
    await fastify.register(fastify_routes_9.default, { prefix: "/api/tracking" });
    await fastify.register(fastify_routes_10.default, { prefix: "/api/addresses" });
    await fastify.register(fastify_routes_11.default, { prefix: "/api/invoices" });
    await fastify.register(fastify_routes_12.default, { prefix: "/api/notifications" });
    await fastify.register(fastify_routes_13.default, { prefix: "/api/manager" });
    await fastify.register(fastify_routes_14.default, { prefix: "/api/manager/analytics" });
    await fastify.register(fastify_routes_15.default, { prefix: "/api/warehouses" });
    await fastify.register(fastify_routes_16.default, { prefix: "/api/labels" });
    await fastify.register(fastify_routes_17.default, { prefix: "/api/webhooks" });
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
