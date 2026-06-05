import prisma from "../../../config/prismaClient";
import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../../config/redis";
import { analyticsConfig } from "../config/analyticsConfig";
import { analyticsLogger } from "../config/analyticsLogger";
import {
  appendCargoPilotDomainEvent,
  type CargoPilotDomainEvent,
  type CargoPilotDomainEventType,
} from "../realtime/analyticsEvents";

const OUTBOX_BATCH_SIZE = analyticsConfig.outbox.batchSize;
const OUTBOX_IDLE_MS = analyticsConfig.outbox.idleMs;
const OUTBOX_LOCK_KEY =
  analyticsConfig.outbox.lockKey || `${getRedisPrefix()}:cp:analytics:outbox:publisher:lock`;
const OUTBOX_LOCK_TTL_SEC = analyticsConfig.outbox.lockTtlSec;
const OUTBOX_CONSUMER_ID =
  analyticsConfig.outbox.consumerId || `${process.env.HOSTNAME || "api"}-${process.pid}`;
const outboxRepo = (prisma as any).analyticsDomainEventOutbox;
const OUTBOX_LOCK_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.ANALYTICS_OUTBOX_LOCK_TIMEOUT_MS || 4000),
);

const OUTBOX_LOCK_ACQUIRE_OR_REFRESH_SCRIPT = `
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

function parsePayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toDomainEvent(row: {
  eventId: string;
  type: string;
  tenantScope: string;
  entityId: string | null;
  schemaVersion: number;
  occurredAt: Date;
  payload: unknown;
}): CargoPilotDomainEvent | null {
  if (!row.eventId || !row.type || !row.tenantScope) return null;
  const parsedType = row.type as CargoPilotDomainEventType;
  return {
    id: row.eventId,
    type: parsedType,
    tenantScope: row.tenantScope,
    entityId: row.entityId ?? null,
    schemaVersion: 1,
    occurredAt: row.occurredAt.toISOString(),
    payload: parsePayload(row.payload),
  };
}

async function acquireLeaderLock() {
  if (!analyticsConfig.outbox.leaderLockEnabled) return true;
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    const acquired = await withRedisTimeout(
      "analytics:outbox:lock:acquire-or-refresh",
      () =>
        redis.eval(
          OUTBOX_LOCK_ACQUIRE_OR_REFRESH_SCRIPT,
          1,
          OUTBOX_LOCK_KEY,
          OUTBOX_CONSUMER_ID,
          String(OUTBOX_LOCK_TTL_SEC),
        ) as Promise<number>,
      OUTBOX_LOCK_TIMEOUT_MS,
    );
    return Number(acquired) === 1;
  } catch (err: any) {
    const message = String(err?.message || "").toLowerCase();
    if (message.includes("timed out")) {
      analyticsLogger.throttledWarn("outbox-lock-timeout", "outbox leader lock timeout", {
        error: err,
        throttleMs: 120_000,
      });
      return false;
    }
    analyticsLogger.throttledWarn("outbox-lock-failed", "outbox leader lock failed", {
      error: err,
      throttleMs: 120_000,
    });
    return false;
  }
}

export async function startAnalyticsOutboxPublisher() {
  if (!analyticsConfig.outbox.enabled) {
    analyticsLogger.info("outbox publisher disabled");
    return;
  }

  analyticsLogger.info("outbox publisher started", { consumerId: OUTBOX_CONSUMER_ID });
  while (true) {
    try {
      const leader = await acquireLeaderLock();
      if (!leader) {
        await sleep(2000);
        continue;
      }

      const batch = await outboxRepo.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: "asc" },
        take: OUTBOX_BATCH_SIZE,
      });

      if (batch.length === 0) {
        await sleep(OUTBOX_IDLE_MS);
        continue;
      }

      for (const row of batch) {
        const event = toDomainEvent(row);
        if (!event) {
          await outboxRepo.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              publishedAt: new Date(),
              lastError: "Invalid outbox payload shape",
            },
          });
          continue;
        }

        try {
          await appendCargoPilotDomainEvent(event);
          await outboxRepo.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              publishedAt: new Date(),
              lastError: null,
            },
          });
        } catch (err: any) {
          await outboxRepo.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: String(err?.message || "Unknown outbox publish error").slice(
                0,
                1000,
              ),
            },
          });
        }
      }
    } catch (err: any) {
      const message = String(err?.message || "");
      if (message.toLowerCase().includes("timed out")) {
        analyticsLogger.throttledWarn("outbox-loop-timeout", "outbox publisher loop timeout", {
          error: err,
          throttleMs: 30_000,
        });
      } else {
        analyticsLogger.throttledError("outbox-loop-error", "outbox publisher loop error", {
          error: err,
          throttleMs: 30_000,
        });
      }
      await sleep(2000);
    }
  }
}
