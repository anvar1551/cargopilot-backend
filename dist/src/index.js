"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const type_provider_zod_1 = require("@fastify/type-provider-zod");
const prismaClient_1 = __importDefault(require("./config/prismaClient"));
const env_1 = require("./config/env");
const redis_1 = require("./config/redis");
const realtimeHub_1 = require("./modules/realtime-core/realtimeHub");
const notificationRetention_1 = require("./modules/notifications-core/application/notificationRetention");
const analyticsV2Realtime_1 = require("./modules/analytics-core/realtime/analyticsV2Realtime");
const analytics_worker_1 = require("./workers/analytics.worker");
const analyticsWarmup_1 = require("./modules/analytics-core/application/analyticsWarmup");
const analyticsOutboxPublisher_1 = require("./modules/analytics-core/infrastructure/analyticsOutboxPublisher");
const analyticsConfig_1 = require("./modules/analytics-core/config/analyticsConfig");
const supportRetention_1 = require("./modules/support-core/application/supportRetention");
const supportRules_1 = require("./modules/support-core/application/supportRules");
const supportSlaMonitor_1 = require("./modules/support-core/application/supportSlaMonitor");
const fastify_routes_1 = __importDefault(require("./modules/orders-core/transport/fastify-routes"));
const fastify_routes_2 = __importDefault(require("./modules/pricing-core/transport/fastify-routes"));
const fastify_routes_3 = __importDefault(require("./modules/support-core/transport/fastify-routes"));
const fastify_routes_4 = __importDefault(require("./modules/live-map-core/transport/fastify-routes"));
const fastify_routes_5 = __importDefault(require("./modules/identity-access/transport/fastify-routes"));
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
const fastify_routes_17 = __importDefault(require("./modules/organizations-core/transport/fastify-routes"));
const fastify_routes_18 = __importDefault(require("./modules/integrations-core/transport/fastify-routes"));
const outbox_config_1 = require("./modules/integrations-core/config/outbox.config");
const integration_outbox_publisher_1 = require("./modules/integrations-core/infrastructure/integration-outbox.publisher");
async function start() {
    const env = (0, env_1.loadAppEnv)();
    const fastify = (0, fastify_1.default)({
        trustProxy: env.TRUST_PROXY,
        logger: false,
        bodyLimit: env.FASTIFY_BODY_LIMIT_BYTES,
    });
    fastify.setValidatorCompiler(type_provider_zod_1.validatorCompiler);
    fastify.setSerializerCompiler(type_provider_zod_1.serializerCompiler);
    const allowedOrigins = env.allowedOrigins;
    const allowedOriginSet = new Set(allowedOrigins);
    await fastify.register(cors_1.default, {
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
            await prismaClient_1.default.$queryRaw `SELECT 1`;
            const redisHealth = await (0, redis_1.getRedisHealthSnapshot)();
            let redisPingMs = null;
            let redisOk = false;
            if (redisHealth.enabled) {
                const redis = await (0, redis_1.getRedisClient)();
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
        }
        catch (err) {
            const redisHealth = await (0, redis_1.getRedisHealthSnapshot)().catch(() => null);
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
    await fastify.register(fastify_routes_1.default, { prefix: "/api/orders" });
    await fastify.register(fastify_routes_2.default, { prefix: "/api/pricing" });
    await fastify.register(fastify_routes_3.default, { prefix: "/api/support" });
    await fastify.register(fastify_routes_4.default, { prefix: "/api/live-map" });
    await fastify.register(fastify_routes_5.default, { prefix: "/api/auth" });
    await fastify.register(fastify_routes_6.default, { prefix: "/api/drivers" });
    await fastify.register(fastify_routes_7.default, { prefix: "/api/customers" });
    await fastify.register(fastify_routes_8.default, { prefix: "/api" });
    await fastify.register(fastify_routes_9.default, { prefix: "/api/tracking" });
    await fastify.register(fastify_routes_10.default, { prefix: "/api/addresses" });
    await fastify.register(fastify_routes_11.default, { prefix: "/api/invoices" });
    await fastify.register(fastify_routes_12.default, { prefix: "/api/notifications" });
    await fastify.register(fastify_routes_13.default, { prefix: "/api/dashboard" });
    await fastify.register(fastify_routes_14.default, { prefix: "/api/analytics" });
    await fastify.register(fastify_routes_15.default, { prefix: "/api/warehouses" });
    await fastify.register(fastify_routes_16.default, { prefix: "/api/labels" });
    await fastify.register(fastify_routes_17.default, { prefix: "/api/organizations" });
    await fastify.register(fastify_routes_18.default, { prefix: "/api/integrations" });
    (0, realtimeHub_1.initRealtimeHub)(fastify.server, allowedOrigins);
    (0, notificationRetention_1.startNotificationRetentionWorker)();
    (0, supportRetention_1.startSupportRetentionWorker)();
    (0, supportRules_1.startSupportRulesWorker)();
    (0, supportSlaMonitor_1.startSupportSlaMonitorWorker)();
    (0, analyticsV2Realtime_1.ensureAnalyticsInvalidationConsumer)();
    if (analyticsConfig_1.analyticsConfig.warmup.inApi) {
        (0, analyticsWarmup_1.startAnalyticsWarmupLoop)();
    }
    if (analyticsConfig_1.analyticsConfig.outbox.inApi) {
        void (0, analyticsOutboxPublisher_1.startAnalyticsOutboxPublisher)();
    }
    if (outbox_config_1.integrationOutboxConfig.inApi) {
        void (0, integration_outbox_publisher_1.startIntegrationOutboxPublisher)();
    }
    const runAnalyticsWorkerInProcess = analyticsConfig_1.analyticsConfig.worker.inProcess;
    if (runAnalyticsWorkerInProcess) {
        void (0, analytics_worker_1.startAnalyticsWorker)({ leaderLock: true });
    }
    await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
    console.log(`Server running on port ${env.PORT}`);
}
void start().catch((err) => {
    console.error("[server] failed to start", err);
    process.exitCode = 1;
});
