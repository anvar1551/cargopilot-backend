import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../../config/redis";

const STREAM_MAX_LENGTH = 100_000;
const STREAM_KEY = `${getRedisPrefix()}:cp:finance:events`;
const BATCH_SIZE = Math.max(1, Number(process.env.FINANCE_OUTBOX_BATCH_SIZE || 50));
const IDLE_MS = Math.max(100, Number(process.env.FINANCE_OUTBOX_IDLE_MS || 1000));
const REDIS_TIMEOUT_MS = Math.max(500, Number(process.env.FINANCE_OUTBOX_REDIS_TIMEOUT_MS || 2500));
const CLAIM_STALE_MS = Math.max(30_000, Number(process.env.FINANCE_OUTBOX_CLAIM_STALE_MS || 300_000));
const CONSUMER_ID = process.env.FINANCE_OUTBOX_CONSUMER_ID || `${process.env.HOSTNAME || "finance"}-${process.pid}`;

type ClaimedFinanceEvent = {
  id: string;
  eventId: string;
  legalEntityId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: Date;
  payloadJson: unknown;
  attempts: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  console[level](JSON.stringify({
    ts: new Date().toISOString(),
    scope: "finance-outbox",
    level,
    message,
    ...(meta ? { meta } : {}),
  }));
}

async function claimBatch(batchSize: number, consumerId: string) {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  return prisma.$queryRaw<ClaimedFinanceEvent[]>(Prisma.sql`
    UPDATE "FinanceDomainEventOutbox" AS event
    SET "claimedAt" = NOW(), "claimedBy" = ${consumerId}, "updatedAt" = NOW()
    WHERE event.id IN (
      SELECT candidate.id
      FROM "FinanceDomainEventOutbox" AS candidate
      WHERE candidate."publishedAt" IS NULL
        AND candidate."nextAttemptAt" <= NOW()
        AND (candidate."claimedAt" IS NULL OR candidate."claimedAt" < ${staleBefore})
      ORDER BY candidate."createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    RETURNING event.id, event."eventId", event."legalEntityId",
      event."aggregateType", event."aggregateId", event."eventType",
      event."schemaVersion", event."occurredAt", event."payloadJson", event.attempts
  `);
}

function retryAt(attempts: number) {
  const delayMs = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
  return new Date(Date.now() + delayMs);
}

async function publish(row: ClaimedFinanceEvent) {
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis unavailable");
  const event = {
    id: row.eventId,
    type: row.eventType,
    occurredAt: row.occurredAt.toISOString(),
    tenantScope: row.legalEntityId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    schemaVersion: row.schemaVersion,
    payload: row.payloadJson,
  };
  await withRedisTimeout(
    "finance:outbox:xadd",
    () => redis.xadd(
      STREAM_KEY,
      "MAXLEN",
      "~",
      String(STREAM_MAX_LENGTH),
      "*",
      "eventId",
      row.eventId,
      "type",
      row.eventType,
      "tenantScope",
      row.legalEntityId,
      "aggregateType",
      row.aggregateType,
      "aggregateId",
      row.aggregateId,
      "schemaVersion",
      String(row.schemaVersion),
      "data",
      JSON.stringify(event),
    ),
    REDIS_TIMEOUT_MS,
  );
}

export async function processFinanceOutboxBatchOnce(options?: {
  batchSize?: number;
  consumerId?: string;
}) {
  const consumerId = options?.consumerId || CONSUMER_ID;
  const rows = await claimBatch(options?.batchSize || BATCH_SIZE, consumerId);
  let published = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await publish(row);
      await prisma.financeDomainEventOutbox.updateMany({
        where: { id: row.id, claimedBy: consumerId, publishedAt: null },
        data: {
          publishedAt: new Date(),
          claimedAt: null,
          claimedBy: null,
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      published += 1;
    } catch (error: any) {
      const attempts = row.attempts + 1;
      await prisma.financeDomainEventOutbox.updateMany({
        where: { id: row.id, claimedBy: consumerId, publishedAt: null },
        data: {
          claimedAt: null,
          claimedBy: null,
          attempts: { increment: 1 },
          nextAttemptAt: retryAt(attempts),
          lastError: String(error?.message || "Unknown finance outbox error").slice(0, 1000),
        },
      });
      failed += 1;
    }
  }

  return { claimed: rows.length, published, failed };
}

export async function startFinanceOutboxPublisher() {
  log("info", "finance outbox worker started", { consumerId: CONSUMER_ID, batchSize: BATCH_SIZE });
  while (true) {
    try {
      const result = await processFinanceOutboxBatchOnce();
      if (result.claimed === 0) await sleep(IDLE_MS);
      else if (result.failed > 0) log("warn", "finance outbox batch completed with failures", result);
    } catch (error: any) {
      log("error", "finance outbox loop failed", { error: String(error?.message || error) });
      await sleep(Math.max(IDLE_MS, 2000));
    }
  }
}

export function getFinanceEventsStreamKey() {
  return STREAM_KEY;
}
