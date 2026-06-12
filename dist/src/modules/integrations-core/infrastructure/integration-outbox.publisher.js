"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processIntegrationOutboxBatchOnce = processIntegrationOutboxBatchOnce;
exports.startIntegrationOutboxPublisher = startIntegrationOutboxPublisher;
const redis_1 = require("../../../config/redis");
const outbox_config_1 = require("../config/outbox.config");
const outbox_logger_1 = require("../config/outbox.logger");
const outbox_dispatcher_1 = require("../application/outbox-dispatcher");
const canonical_event_processor_1 = require("../application/canonical-event-processor");
const provider_registry_repo_1 = require("./provider-registry.repo");
const canonical_event_repo_1 = require("./canonical-event.repo");
const outbox_repo_1 = require("./outbox.repo");
const LOCK_ACQUIRE_OR_REFRESH_SCRIPT = `
local key = KEYS[1]
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local current = redis.call('GET', key)
if not current then
  redis.call('SET', key, owner, 'EX', ttl, 'NX')
  current = redis.call('GET', key)
  if current == owner then
    return 1
  end
  return 0
end
if current == owner then
  redis.call('EXPIRE', key, ttl)
  return 1
end
return 0
`;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function computeNextAttemptAt(nowMs, attemptNo) {
    const base = outbox_config_1.integrationOutboxConfig.retryBaseMs;
    const cap = outbox_config_1.integrationOutboxConfig.retryCapMs;
    const growth = Math.min(cap, base * 2 ** Math.max(0, attemptNo - 1));
    const jitter = outbox_config_1.integrationOutboxConfig.retryJitterPct;
    const factor = 1 + (Math.random() * 2 - 1) * jitter;
    const delayMs = Math.max(100, Math.round(growth * factor));
    return new Date(nowMs + delayMs).toISOString();
}
async function acquireLeaderLock() {
    if (!outbox_config_1.integrationOutboxConfig.leaderLockEnabled)
        return true;
    try {
        const redis = await (0, redis_1.getRedisClient)();
        if (!redis) {
            // Redis lock is best-effort for this worker; DB claim still protects concurrency.
            return true;
        }
        const acquired = await (0, redis_1.withRedisTimeout)("integration-outbox:lock:acquire-or-refresh", () => redis.eval(LOCK_ACQUIRE_OR_REFRESH_SCRIPT, 1, outbox_config_1.integrationOutboxConfig.lockKey, outbox_config_1.integrationOutboxConfig.consumerId, String(outbox_config_1.integrationOutboxConfig.lockTtlSec)), outbox_config_1.integrationOutboxConfig.lockTimeoutMs);
        return Number(acquired) === 1;
    }
    catch (error) {
        outbox_logger_1.integrationOutboxLogger.throttledWarn("lock-failed", "outbox leader lock failed", 120000, { error: String(error?.message || error) });
        return false;
    }
}
function buildAttempt(args) {
    return {
        attemptNo: args.attemptNo,
        startedAt: new Date(args.startedAt).toISOString(),
        finishedAt: new Date(args.finishedAt).toISOString(),
        ok: args.ok,
        retryable: args.retryable,
        statusCode: args.statusCode,
        errorMessage: args.message,
        providerRequestId: args.providerRequestId ?? null,
        requestJson: args.requestJson ?? null,
        responseJson: args.responseJson ?? null,
    };
}
function isCarrierCreateShipment(record) {
    return record.domain === "carrier" && record.operation === "create_shipment";
}
function isCarrierTrack(record) {
    return record.domain === "carrier" && record.operation === "track";
}
function isCarrierCancelShipment(record) {
    return record.domain === "carrier" && record.operation === "cancel_shipment";
}
async function enqueueCarrierDispatchSuccessEvent(args) {
    if (!isCarrierCreateShipment(args.record) || !args.record.aggregateId)
        return;
    await canonical_event_repo_1.integrationCanonicalEventRepository.enqueue({
        source: "outbound_response",
        companyId: args.record.companyId,
        providerId: args.record.providerId,
        outboxId: args.record.id,
        domain: "carrier",
        providerCode: args.record.providerCode,
        eventType: "carrier.shipment.created",
        aggregateType: args.record.aggregateType ?? "shipment",
        aggregateId: args.record.aggregateId,
        occurredAt: args.attempt.finishedAt,
        payloadJson: {
            requestJson: args.attempt.requestJson ?? null,
            responseJson: args.attempt.responseJson ?? null,
            providerRequestId: args.attempt.providerRequestId ?? null,
            statusCode: args.attempt.statusCode,
        },
    });
}
async function enqueueCarrierTrackSuccessEvent(args) {
    if (!isCarrierTrack(args.record) || !args.record.aggregateId)
        return;
    const responseJson = args.attempt.responseJson ?? {};
    await canonical_event_repo_1.integrationCanonicalEventRepository.enqueue({
        source: "outbound_response",
        companyId: args.record.companyId,
        providerId: args.record.providerId,
        outboxId: args.record.id,
        domain: "carrier",
        providerCode: args.record.providerCode,
        eventType: "carrier.status.updated",
        aggregateType: args.record.aggregateType ?? "shipment",
        aggregateId: args.record.aggregateId,
        occurredAt: args.attempt.finishedAt,
        payloadJson: {
            ...responseJson,
            providerRequestId: args.attempt.providerRequestId ?? null,
            providerHttpStatusCode: args.attempt.statusCode,
        },
    });
}
async function enqueueCarrierCancelSuccessEvent(args) {
    if (!isCarrierCancelShipment(args.record) || !args.record.aggregateId)
        return;
    await canonical_event_repo_1.integrationCanonicalEventRepository.enqueue({
        source: "outbound_response",
        companyId: args.record.companyId,
        providerId: args.record.providerId,
        outboxId: args.record.id,
        domain: "carrier",
        providerCode: args.record.providerCode,
        eventType: "carrier.status.updated",
        aggregateType: args.record.aggregateType ?? "shipment",
        aggregateId: args.record.aggregateId,
        occurredAt: args.attempt.finishedAt,
        payloadJson: {
            ...(args.attempt.responseJson ?? {}),
            statusCode: "cancelled",
            statusLabel: "Cancelled",
            providerRequestId: args.attempt.providerRequestId ?? null,
            providerHttpStatusCode: args.attempt.statusCode,
        },
    });
}
async function enqueueCarrierDispatchFailureEvent(args) {
    if (!isCarrierCreateShipment(args.record) || !args.record.aggregateId)
        return;
    await canonical_event_repo_1.integrationCanonicalEventRepository.enqueue({
        source: "outbound_response",
        companyId: args.record.companyId,
        providerId: args.record.providerId,
        outboxId: args.record.id,
        domain: "carrier",
        providerCode: args.record.providerCode,
        eventType: "carrier.shipment.failed",
        aggregateType: args.record.aggregateType ?? "shipment",
        aggregateId: args.record.aggregateId,
        occurredAt: args.attempt.finishedAt,
        payloadJson: {
            requestJson: args.attempt.requestJson ?? null,
            responseJson: args.attempt.responseJson ?? null,
            providerRequestId: args.attempt.providerRequestId ?? null,
            statusCode: args.attempt.statusCode,
            message: args.attempt.errorMessage,
        },
    });
}
async function processOne(record) {
    const startedAt = Date.now();
    const attemptNo = Number(record.attemptCount || 0) + 1;
    const maxAttempts = Math.max(1, Number(record.maxAttempts || 1));
    const provider = await provider_registry_repo_1.providerRegistryService.resolveProvider({
        companyId: record.companyId,
        domain: record.domain,
        providerId: record.providerId,
        providerCode: record.providerCode,
        environment: record.environment,
    });
    const timeoutMs = Math.max(1000, Number(provider?.timeoutMs || outbox_config_1.integrationOutboxConfig.defaultProviderTimeoutMs));
    const dispatcher = (0, outbox_dispatcher_1.resolveIntegrationOutboxDispatcher)(record, provider);
    let dispatchResult;
    try {
        dispatchResult = await dispatcher.dispatch({
            record,
            provider,
            timeoutMs,
        });
    }
    catch (error) {
        dispatchResult = {
            sent: false,
            retryable: true,
            statusCode: null,
            message: String(error?.message || "outbox dispatch failed"),
        };
    }
    const finishedAt = Date.now();
    const message = dispatchResult.message ? dispatchResult.message.slice(0, 1000) : null;
    const attempt = buildAttempt({
        attemptNo,
        startedAt,
        finishedAt,
        ok: dispatchResult.sent,
        retryable: Boolean(dispatchResult.retryable),
        statusCode: dispatchResult.statusCode ?? null,
        message,
        providerRequestId: dispatchResult.providerRequestId ?? null,
        requestJson: dispatchResult.requestJson ?? null,
        responseJson: dispatchResult.responseJson ?? null,
    });
    if (dispatchResult.sent) {
        await outbox_repo_1.integrationOutboxRepository.markSent(record.id, attempt);
        await enqueueCarrierDispatchSuccessEvent({ record, attempt });
        await enqueueCarrierTrackSuccessEvent({ record, attempt });
        await enqueueCarrierCancelSuccessEvent({ record, attempt });
        return;
    }
    const retriesExhausted = attemptNo >= maxAttempts;
    if (!dispatchResult.retryable || retriesExhausted) {
        await outbox_repo_1.integrationOutboxRepository.markDeadLetter(record.id, attempt);
        await enqueueCarrierDispatchFailureEvent({ record, attempt });
        return;
    }
    const nextAttemptAt = computeNextAttemptAt(finishedAt, attemptNo);
    await outbox_repo_1.integrationOutboxRepository.markRetry(record.id, attempt, nextAttemptAt);
}
async function processIntegrationOutboxBatchOnce() {
    const nowMs = Date.now();
    const staleProcessingBeforeIso = new Date(nowMs - outbox_config_1.integrationOutboxConfig.claimProcessingTimeoutMs).toISOString();
    const batch = await outbox_repo_1.integrationOutboxRepository.claimBatch({
        limit: outbox_config_1.integrationOutboxConfig.batchSize,
        nowIso: new Date(nowMs).toISOString(),
        staleProcessingBeforeIso,
    });
    let processed = 0;
    for (const record of batch) {
        try {
            await processOne(record);
            processed += 1;
        }
        catch (error) {
            outbox_logger_1.integrationOutboxLogger.throttledError(`process-${record.id}`, "integration outbox process failed", 15000, {
                outboxId: record.id,
                error: String(error?.message || error),
            });
        }
    }
    const canonical = await (0, canonical_event_processor_1.processIntegrationCanonicalEventsOnce)({
        limit: outbox_config_1.integrationOutboxConfig.batchSize,
    });
    return {
        claimed: batch.length,
        processed,
        canonical,
    };
}
async function startIntegrationOutboxPublisher() {
    if (!outbox_config_1.integrationOutboxConfig.enabled) {
        outbox_logger_1.integrationOutboxLogger.info("integration outbox worker disabled");
        return;
    }
    outbox_logger_1.integrationOutboxLogger.info("integration outbox worker started", {
        consumerId: outbox_config_1.integrationOutboxConfig.consumerId,
        batchSize: outbox_config_1.integrationOutboxConfig.batchSize,
    });
    while (true) {
        try {
            const isLeader = await acquireLeaderLock();
            if (!isLeader) {
                await sleep(outbox_config_1.integrationOutboxConfig.lockWaitMs);
                continue;
            }
            const result = await processIntegrationOutboxBatchOnce();
            if (result.claimed === 0 && result.canonical.claimed === 0) {
                await sleep(outbox_config_1.integrationOutboxConfig.idleMs);
                continue;
            }
        }
        catch (error) {
            outbox_logger_1.integrationOutboxLogger.throttledError("loop-error", "integration outbox loop failed", 30000, { error: String(error?.message || error) });
            await sleep(outbox_config_1.integrationOutboxConfig.loopErrorSleepMs);
        }
    }
}
