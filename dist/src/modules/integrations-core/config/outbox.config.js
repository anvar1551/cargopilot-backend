"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationOutboxConfig = void 0;
const redis_1 = require("../../../config/redis");
function parseIntEnv(name, fallback, min) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.trunc(value));
}
function parseBoolEnv(name, fallback) {
    const raw = String(process.env[name] ?? "").trim().toLowerCase();
    if (!raw)
        return fallback;
    if (["1", "true", "yes", "on"].includes(raw))
        return true;
    if (["0", "false", "no", "off"].includes(raw))
        return false;
    return fallback;
}
exports.integrationOutboxConfig = {
    enabled: parseBoolEnv("INTEGRATION_OUTBOX_ENABLED", true),
    inApi: parseBoolEnv("INTEGRATION_OUTBOX_IN_API", false),
    batchSize: parseIntEnv("INTEGRATION_OUTBOX_BATCH_SIZE", 50, 1),
    idleMs: parseIntEnv("INTEGRATION_OUTBOX_IDLE_MS", 1500, 100),
    loopErrorSleepMs: parseIntEnv("INTEGRATION_OUTBOX_ERROR_SLEEP_MS", 2000, 100),
    claimProcessingTimeoutMs: parseIntEnv("INTEGRATION_OUTBOX_PROCESSING_TIMEOUT_MS", 2 * 60 * 1000, 1000),
    retryBaseMs: parseIntEnv("INTEGRATION_OUTBOX_RETRY_BASE_MS", 5000, 100),
    retryCapMs: parseIntEnv("INTEGRATION_OUTBOX_RETRY_CAP_MS", 10 * 60 * 1000, 1000),
    retryJitterPct: Math.max(0, Math.min(0.5, Number(process.env.INTEGRATION_OUTBOX_RETRY_JITTER_PCT ?? 0.2))),
    leaderLockEnabled: parseBoolEnv("INTEGRATION_OUTBOX_LEADER_LOCK_ENABLED", true),
    lockKey: process.env.INTEGRATION_OUTBOX_LOCK_KEY ||
        `${(0, redis_1.getRedisPrefix)()}:cp:integrations:outbox:worker:lock`,
    lockTtlSec: parseIntEnv("INTEGRATION_OUTBOX_LOCK_TTL_SEC", 20, 5),
    lockTimeoutMs: parseIntEnv("INTEGRATION_OUTBOX_LOCK_TIMEOUT_MS", 3000, 500),
    lockWaitMs: parseIntEnv("INTEGRATION_OUTBOX_LOCK_WAIT_MS", 2000, 100),
    consumerId: process.env.INTEGRATION_OUTBOX_CONSUMER_ID ||
        `${process.env.HOSTNAME || "api"}-${process.pid}`,
    defaultProviderTimeoutMs: parseIntEnv("INTEGRATION_OUTBOX_PROVIDER_TIMEOUT_MS", 10000, 1000),
};
