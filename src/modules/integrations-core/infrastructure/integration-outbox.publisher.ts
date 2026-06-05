import { getRedisClient, withRedisTimeout } from "../../../config/redis";
import { integrationOutboxConfig } from "../config/outbox.config";
import { integrationOutboxLogger } from "../config/outbox.logger";
import type { IntegrationAttempt } from "../domain/types";
import {
  resolveIntegrationOutboxDispatcher,
} from "../application/outbox-dispatcher";
import { processIntegrationCanonicalEventsOnce } from "../application/canonical-event-processor";
import { providerRegistryService } from "./provider-registry.repo";
import { integrationCanonicalEventRepository } from "./canonical-event.repo";
import { integrationOutboxRepository } from "./outbox.repo";

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeNextAttemptAt(nowMs: number, attemptNo: number) {
  const base = integrationOutboxConfig.retryBaseMs;
  const cap = integrationOutboxConfig.retryCapMs;
  const growth = Math.min(cap, base * 2 ** Math.max(0, attemptNo - 1));
  const jitter = integrationOutboxConfig.retryJitterPct;
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  const delayMs = Math.max(100, Math.round(growth * factor));
  return new Date(nowMs + delayMs).toISOString();
}

async function acquireLeaderLock() {
  if (!integrationOutboxConfig.leaderLockEnabled) return true;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      // Redis lock is best-effort for this worker; DB claim still protects concurrency.
      return true;
    }
    const acquired = await withRedisTimeout(
      "integration-outbox:lock:acquire-or-refresh",
      () =>
        redis.eval(
          LOCK_ACQUIRE_OR_REFRESH_SCRIPT,
          1,
          integrationOutboxConfig.lockKey,
          integrationOutboxConfig.consumerId,
          String(integrationOutboxConfig.lockTtlSec),
        ) as Promise<number>,
      integrationOutboxConfig.lockTimeoutMs,
    );
    return Number(acquired) === 1;
  } catch (error: any) {
    integrationOutboxLogger.throttledWarn(
      "lock-failed",
      "outbox leader lock failed",
      120_000,
      { error: String(error?.message || error) },
    );
    return false;
  }
}

function buildAttempt(args: {
  attemptNo: number;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  retryable: boolean;
  statusCode: number | null;
  message: string | null;
  providerRequestId?: string | null;
  requestJson?: Record<string, unknown> | null;
  responseJson?: Record<string, unknown> | null;
}): IntegrationAttempt {
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

function isCarrierCreateShipment(record: Awaited<ReturnType<typeof integrationOutboxRepository.claimBatch>>[number]) {
  return record.domain === "carrier" && record.operation === "create_shipment";
}

async function enqueueCarrierDispatchSuccessEvent(args: {
  record: Awaited<ReturnType<typeof integrationOutboxRepository.claimBatch>>[number];
  attempt: IntegrationAttempt;
}) {
  if (!isCarrierCreateShipment(args.record) || !args.record.aggregateId) return;

  await integrationCanonicalEventRepository.enqueue({
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

async function enqueueCarrierDispatchFailureEvent(args: {
  record: Awaited<ReturnType<typeof integrationOutboxRepository.claimBatch>>[number];
  attempt: IntegrationAttempt;
}) {
  if (!isCarrierCreateShipment(args.record) || !args.record.aggregateId) return;

  await integrationCanonicalEventRepository.enqueue({
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

async function processOne(record: Awaited<ReturnType<typeof integrationOutboxRepository.claimBatch>>[number]) {
  const startedAt = Date.now();
  const attemptNo = Number(record.attemptCount || 0) + 1;
  const maxAttempts = Math.max(1, Number(record.maxAttempts || 1));

  const provider = await providerRegistryService.resolveProvider({
    companyId: record.companyId,
    domain: record.domain,
    providerId: record.providerId,
    providerCode: record.providerCode,
    environment: record.environment,
  });
  const timeoutMs = Math.max(
    1000,
    Number(provider?.timeoutMs || integrationOutboxConfig.defaultProviderTimeoutMs),
  );
  const dispatcher = resolveIntegrationOutboxDispatcher(record, provider);

  let dispatchResult: Awaited<ReturnType<typeof dispatcher.dispatch>>;
  try {
    dispatchResult = await dispatcher.dispatch({
      record,
      provider,
      timeoutMs,
    });
  } catch (error: any) {
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
    await integrationOutboxRepository.markSent(record.id, attempt);
    await enqueueCarrierDispatchSuccessEvent({ record, attempt });
    return;
  }

  const retriesExhausted = attemptNo >= maxAttempts;
  if (!dispatchResult.retryable || retriesExhausted) {
    await integrationOutboxRepository.markDeadLetter(record.id, attempt);
    await enqueueCarrierDispatchFailureEvent({ record, attempt });
    return;
  }

  const nextAttemptAt = computeNextAttemptAt(finishedAt, attemptNo);
  await integrationOutboxRepository.markRetry(record.id, attempt, nextAttemptAt);
}

export async function processIntegrationOutboxBatchOnce() {
  const nowMs = Date.now();
  const staleProcessingBeforeIso = new Date(
    nowMs - integrationOutboxConfig.claimProcessingTimeoutMs,
  ).toISOString();
  const batch = await integrationOutboxRepository.claimBatch({
    limit: integrationOutboxConfig.batchSize,
    nowIso: new Date(nowMs).toISOString(),
    staleProcessingBeforeIso,
  });

  let processed = 0;
  for (const record of batch) {
    try {
      await processOne(record);
      processed += 1;
    } catch (error: any) {
      integrationOutboxLogger.throttledError(
        `process-${record.id}`,
        "integration outbox process failed",
        15_000,
        {
          outboxId: record.id,
          error: String(error?.message || error),
        },
      );
    }
  }

  const canonical = await processIntegrationCanonicalEventsOnce({
    limit: integrationOutboxConfig.batchSize,
  });

  return {
    claimed: batch.length,
    processed,
    canonical,
  };
}

export async function startIntegrationOutboxPublisher() {
  if (!integrationOutboxConfig.enabled) {
    integrationOutboxLogger.info("integration outbox worker disabled");
    return;
  }

  integrationOutboxLogger.info("integration outbox worker started", {
    consumerId: integrationOutboxConfig.consumerId,
    batchSize: integrationOutboxConfig.batchSize,
  });

  while (true) {
    try {
      const isLeader = await acquireLeaderLock();
      if (!isLeader) {
        await sleep(integrationOutboxConfig.lockWaitMs);
        continue;
      }

      const result = await processIntegrationOutboxBatchOnce();

      if (result.claimed === 0 && result.canonical.claimed === 0) {
        await sleep(integrationOutboxConfig.idleMs);
        continue;
      }
    } catch (error: any) {
      integrationOutboxLogger.throttledError(
        "loop-error",
        "integration outbox loop failed",
        30_000,
        { error: String(error?.message || error) },
      );
      await sleep(integrationOutboxConfig.loopErrorSleepMs);
    }
  }
}
