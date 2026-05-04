import prisma from "../../config/prismaClient";
import { getRedisClient, getRedisPrefix } from "../../config/redis";
import {
  appendCargoPilotDomainEvent,
  type CargoPilotDomainEvent,
  type CargoPilotDomainEventType,
} from "./analyticsEvents";

const OUTBOX_BATCH_SIZE = Math.max(
  10,
  Math.min(500, Number(process.env.ANALYTICS_OUTBOX_BATCH_SIZE || 100)),
);
const OUTBOX_IDLE_MS = Math.max(
  250,
  Number(process.env.ANALYTICS_OUTBOX_IDLE_MS || 1500),
);
const OUTBOX_LOCK_KEY =
  process.env.ANALYTICS_OUTBOX_LOCK_KEY || `${getRedisPrefix()}:cp:analytics:outbox:publisher:lock`;
const OUTBOX_LOCK_TTL_SEC = Math.max(
  10,
  Number(process.env.ANALYTICS_OUTBOX_LOCK_TTL_SEC || 30),
);
const OUTBOX_CONSUMER_ID =
  process.env.ANALYTICS_OUTBOX_CONSUMER || `${process.env.HOSTNAME || "api"}-${process.pid}`;
const outboxRepo = (prisma as any).analyticsDomainEventOutbox;

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
  const redis = await getRedisClient();
  if (!redis) return false;
  const inserted = await redis.set(
    OUTBOX_LOCK_KEY,
    OUTBOX_CONSUMER_ID,
    "EX",
    OUTBOX_LOCK_TTL_SEC,
    "NX",
  );
  if (inserted) return true;
  const owner = await redis.get(OUTBOX_LOCK_KEY);
  if (owner === OUTBOX_CONSUMER_ID) {
    await redis.expire(OUTBOX_LOCK_KEY, OUTBOX_LOCK_TTL_SEC);
    return true;
  }
  return false;
}

export async function startAnalyticsOutboxPublisher() {
  if (process.env.ANALYTICS_OUTBOX_ENABLED === "false") {
    console.log("[analytics-outbox] disabled");
    return;
  }

  console.log(`[analytics-outbox] starting publisher=${OUTBOX_CONSUMER_ID}`);
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
      console.error(`[analytics-outbox] loop error: ${err?.message || "unknown"}`);
      await sleep(2000);
    }
  }
}
