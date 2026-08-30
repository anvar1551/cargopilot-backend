import "dotenv/config";
import prisma from "../config/prismaClient";
import { createRedisClient, getRedisClient, getRedisPrefix } from "../config/redis";
import { FinanceService } from "../modules/finance-core/application/finance.service";
import {
  financePostingConsumerId,
  processFinancePostingBatchOnce,
} from "../modules/finance-core/infrastructure/finance-posting.processor";
import { prismaFinanceRepository } from "../modules/finance-core/infrastructure/prisma-finance.repository";

const STREAM_KEY = `${getRedisPrefix()}:cp:events`;
const GROUP_NAME = process.env.FINANCE_POSTING_STREAM_GROUP || "finance-posting";
const CONSUMER_NAME = financePostingConsumerId();
const IDLE_MS = Math.max(250, Number(process.env.FINANCE_POSTING_IDLE_MS || 1000));
const service = new FinanceService(prismaFinanceRepository);
let stopping = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  console[level](JSON.stringify({
    ts: new Date().toISOString(),
    scope: "finance-posting",
    level,
    message,
    ...(meta ? { meta } : {}),
  }));
}

async function ensureGroup() {
  const redis = await getRedisClient();
  if (!redis) return false;
  try {
    await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  } catch (error: any) {
    if (!String(error?.message || "").includes("BUSYGROUP")) throw error;
  }
  return true;
}

function streamEvent(fields: string[]) {
  const index = fields.indexOf("data");
  if (index < 0 || !fields[index + 1]) return null;
  try {
    return JSON.parse(fields[index + 1]) as {
      id?: string;
      type?: string;
      occurredAt?: string;
      payload?: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

async function ingestEntries(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  entries: Array<[string, string[]]>,
) {
  for (const [entryId, fields] of entries) {
    const envelope = streamEvent(fields);
    try {
      if (envelope?.type === "finance_source_event" && envelope.payload) {
        await service.ingestSourceEvent({
          ...(envelope.payload as any),
          sourceEventId: String(envelope.payload.sourceEventId || envelope.id || ""),
          occurredAt: envelope.payload.occurredAt || envelope.occurredAt,
        });
      }
      await redis.xack(STREAM_KEY, GROUP_NAME, entryId);
    } catch (error: any) {
      log("error", "source event ingestion failed", {
        entryId,
        error: String(error?.message || error),
      });
      // Leave the entry pending. XAUTOCLAIM will retry it after the stale window.
    }
  }
}

async function start() {
  log("info", "finance posting worker started", {
    stream: STREAM_KEY,
    group: GROUP_NAME,
    consumer: CONSUMER_NAME,
  });
  while (!stopping) {
    let redis = createRedisClient({
      connectTimeout: 3000,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      lazyConnect: true,
      commandTimeout: null,
    });
    try {
      if (!(await ensureGroup()) || !redis) {
        await processFinancePostingBatchOnce();
        await sleep(IDLE_MS);
        continue;
      }
      await redis.connect().catch(() => undefined);
      while (!stopping && redis.status === "ready") {
        const reclaimed = await (redis as any).xautoclaim(
          STREAM_KEY,
          GROUP_NAME,
          CONSUMER_NAME,
          60_000,
          "0-0",
          "COUNT",
          50,
        ) as [string, Array<[string, string[]]>] | null;
        if (reclaimed?.[1]?.length) await ingestEntries(redis, reclaimed[1]);

        const result = await redis.xreadgroup(
          "GROUP", GROUP_NAME, CONSUMER_NAME,
          "COUNT", 50,
          "BLOCK", 1000,
          "STREAMS", STREAM_KEY, ">",
        ) as Array<[string, Array<[string, string[]]>]> | null;
        for (const [, entries] of result ?? []) await ingestEntries(redis, entries);
        const batch = await processFinancePostingBatchOnce();
        if (batch.exceptions || batch.failed) {
          log("warn", "finance posting batch needs attention", batch);
        }
      }
    } catch (error: any) {
      log("error", "finance posting loop failed", { error: String(error?.message || error) });
      await sleep(Math.max(IDLE_MS, 2000));
    } finally {
      redis?.disconnect();
      redis = null;
    }
  }
}

void start().catch((error) => {
  log("error", "finance posting worker crashed", { error: String(error?.message || error) });
  process.exitCode = 1;
});

async function shutdown() {
  stopping = true;
  await prisma.$disconnect().catch(() => undefined);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
