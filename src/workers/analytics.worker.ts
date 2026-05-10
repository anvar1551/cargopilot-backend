import "dotenv/config";
import prisma from "../config/prismaClient";
import { getRedisClient, getRedisPrefix } from "../config/redis";
import {
  getDomainEventsStreamKey,
  type CargoPilotDomainEvent,
  type CargoPilotDomainEventType,
} from "../features/manager/analyticsEvents";
import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "../features/manager/analyticsV2";
import { invalidateNamespaceCaches } from "../features/manager/analyticsV2Cache";
import { clearAnalyticsReadModelBySection, type AnalyticsReadSection } from "../features/manager/analyticsReadModel";
import {
  publishAnalyticsInvalidation,
  type AnalyticsRefreshSection,
} from "../features/manager/analyticsV2Realtime";
import {
  recordAnalyticsWorkerConsumed,
  recordAnalyticsWorkerError,
  recordAnalyticsWorkerRebuild,
} from "../features/observability/opsMetrics";
import { invalidateSupportCache } from "../features/support/supportCache";
import {
  publishSupportRefresh,
  type SupportRefreshReason,
} from "../features/support/supportRealtime";

const GROUP_NAME = process.env.ANALYTICS_WORKER_GROUP || "cp_analytics_workers";
const CONSUMER_NAME =
  process.env.ANALYTICS_WORKER_CONSUMER ||
  `${process.env.HOSTNAME || "analytics"}-${process.pid}`;
const STREAM_KEY = getDomainEventsStreamKey();
const DEDUPE_TTL_SEC = Math.max(
  60,
  Number(process.env.ANALYTICS_WORKER_DEDUPE_TTL_SEC || 24 * 60 * 60),
);
const FLUSH_DEBOUNCE_MS = Math.max(
  250,
  Number(process.env.ANALYTICS_WORKER_FLUSH_DEBOUNCE_MS || 1500),
);
const HEALTH_LOG_MS = Math.max(
  10_000,
  Number(process.env.ANALYTICS_WORKER_HEALTH_LOG_MS || 60_000),
);
const LEADER_LOCK_KEY =
  process.env.ANALYTICS_WORKER_LEADER_LOCK_KEY || `${getRedisPrefix()}:cp:analytics:worker:lock`;
const LEADER_LOCK_TTL_SEC = Math.max(
  10,
  Number(process.env.ANALYTICS_WORKER_LEADER_LOCK_TTL_SEC || 30),
);

type DirtySection = AnalyticsRefreshSection;

const dirtySections = new Set<DirtySection>();
let flushTimer: NodeJS.Timeout | null = null;
let lastEventAt = 0;
let totalConsumed = 0;
let totalRebuilds = 0;
let lastHealthLogAt = 0;

function sectionForEventType(type: CargoPilotDomainEventType): DirtySection[] {
  switch (type) {
    case "order_created":
    case "order_status_changed":
      return ["summary", "trend", "warnings", "finance-queue"];
    case "cash_handoff":
    case "cash_settled":
      return ["summary", "warnings", "finance-queue"];
    case "manual_refresh":
      return ["summary", "trend", "warnings", "finance-queue"];
    case "driver_location_upsert":
    case "driver_presence_update":
    case "support_ticket_changed":
      return [];
    default:
      return [];
  }
}

function asSupportRefreshReason(value: unknown): SupportRefreshReason {
  const raw = String(value || "").trim();
  if (
    raw === "ticket_created" ||
    raw === "ticket_updated" ||
    raw === "message_added" ||
    raw === "note_added" ||
    raw === "ticket_archived"
  ) {
    return raw;
  }
  return "ticket_updated";
}

async function handleSupportTicketChanged(event: CargoPilotDomainEvent) {
  const reason = asSupportRefreshReason(event.payload?.reason);
  await invalidateSupportCache(event.entityId);
  await publishSupportRefresh(reason, {
    ticketId: event.entityId,
    keys: ["list", "summary", "detail"],
  });
}

function toReadModelSection(section: DirtySection): AnalyticsReadSection {
  return section;
}

async function ensureConsumerGroup() {
  const redis = await getRedisClient();
  if (!redis) return;
  try {
    await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  } catch (err: any) {
    const message = String(err?.message || "");
    if (!message.includes("BUSYGROUP")) {
      throw err;
    }
  }
}

function parseDomainEvent(raw: string): CargoPilotDomainEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CargoPilotDomainEvent> | null;
    if (!parsed?.type || !parsed?.id) return null;
    return {
      id: String(parsed.id),
      type: parsed.type as CargoPilotDomainEventType,
      occurredAt: String(parsed.occurredAt || new Date().toISOString()),
      tenantScope: String(parsed.tenantScope || "global"),
      entityId: parsed.entityId ? String(parsed.entityId) : null,
      schemaVersion: 1,
      payload:
        parsed.payload && typeof parsed.payload === "object"
          ? (parsed.payload as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}

async function markEventDeduped(eventId: string) {
  const redis = await getRedisClient();
  if (!redis) return true;
  const key = `${getRedisPrefix()}:cp:analytics:dedupe:${eventId}`;
  const inserted = await redis.set(key, "1", "EX", DEDUPE_TTL_SEC, "NX");
  return Boolean(inserted);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void rebuildDirtySections();
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref();
}

async function rebuildDirtySections() {
  if (dirtySections.size === 0) return;
  const sections = Array.from(dirtySections);
  dirtySections.clear();

  try {
    const shouldClearBeforeRebuild =
      process.env.ANALYTICS_WORKER_CLEAR_BEFORE_REBUILD !== "false";
    if (shouldClearBeforeRebuild) {
      for (const section of sections) {
        await invalidateNamespaceCaches(section);
        await clearAnalyticsReadModelBySection(toReadModelSection(section));
      }
    } else {
      // Even in "soft" mode we must clear v3 read-model keys first;
      // otherwise getAnalytics* may return stale cache-hit and skip rebuild.
      for (const section of sections) {
        await clearAnalyticsReadModelBySection(toReadModelSection(section));
      }
    }

    const defaultRangeDays = Math.max(
      7,
      Math.min(180, Number(process.env.ANALYTICS_V3_DEFAULT_RANGE_DAYS || 30)),
    );
    const defaultPageSize = Math.max(
      5,
      Math.min(200, Number(process.env.ANALYTICS_V3_DEFAULT_QUEUE_PAGE_SIZE || 20)),
    );
    const scope = { role: "manager", warehouseId: null as string | null, userId: null as string | null };

    if (sections.includes("summary")) {
      await getAnalyticsSummaryV2({ rangeDays: defaultRangeDays, scope });
    }
    if (sections.includes("trend")) {
      await getAnalyticsTrendV2({ rangeDays: defaultRangeDays, scope });
    }
    if (sections.includes("warnings")) {
      await getAnalyticsWarningsV2({ rangeDays: defaultRangeDays, scope });
    }
    if (sections.includes("finance-queue")) {
      await getAnalyticsFinanceQueueV2({
        queuePage: 1,
        queuePageSize: defaultPageSize,
        queueStatuses: [],
        queueKinds: [],
        queueHolderTypes: [],
        scope,
      });
    }

    // Clear legacy v2 namespace cache after rebuild so request-path fallbacks
    // cannot keep serving stale payloads.
    for (const section of sections) {
      await invalidateNamespaceCaches(section);
    }

    totalRebuilds += 1;
    recordAnalyticsWorkerRebuild();
    await publishAnalyticsInvalidation("worker_rebuild", {
      scope: "role:manager",
      keys: sections,
      source: "worker",
    });
  } catch (err: any) {
    recordAnalyticsWorkerError();
    console.error(`[analytics-worker] rebuild failed: ${err?.message || "unknown"}`);
  }
}

async function logHealthMaybe() {
  const now = Date.now();
  if (now - lastHealthLogAt < HEALTH_LOG_MS) return;
  lastHealthLogAt = now;
  const lagMs = lastEventAt > 0 ? now - lastEventAt : 0;
  console.log(
    `[analytics-worker] consumed=${totalConsumed} rebuilds=${totalRebuilds} lagMs=${lagMs} dirty=${dirtySections.size}`,
  );
}

async function isLeaderOrAcquire(args: { enabled: boolean }) {
  if (!args.enabled) return true;
  const redis = await getRedisClient();
  if (!redis) return false;
  const acquired = await redis.set(
    LEADER_LOCK_KEY,
    CONSUMER_NAME,
    "EX",
    LEADER_LOCK_TTL_SEC,
    "NX",
  );
  if (acquired) return true;
  const owner = await redis.get(LEADER_LOCK_KEY);
  if (owner === CONSUMER_NAME) {
    await redis.expire(LEADER_LOCK_KEY, LEADER_LOCK_TTL_SEC);
    return true;
  }
  return false;
}

export async function startAnalyticsWorker(args?: { leaderLock?: boolean }) {
  const useLeaderLock = Boolean(args?.leaderLock);
  console.log(`[analytics-worker] starting consumer=${CONSUMER_NAME} group=${GROUP_NAME}`);
  await ensureConsumerGroup();

  while (true) {
    try {
      const leader = await isLeaderOrAcquire({ enabled: useLeaderLock });
      if (!leader) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const redis = await getRedisClient();
      if (!redis) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const results = (await redis.xreadgroup(
        "GROUP",
        GROUP_NAME,
        CONSUMER_NAME,
        "COUNT",
        100,
        "BLOCK",
        2000,
        "STREAMS",
        STREAM_KEY,
        ">",
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) {
        await logHealthMaybe();
        continue;
      }

      for (const [, entries] of results) {
        for (const [streamEntryId, fields] of entries) {
          const dataIdx = fields.indexOf("data");
          const raw = dataIdx >= 0 ? fields[dataIdx + 1] : null;
          const event = raw ? parseDomainEvent(raw) : null;

          let shouldProcess = false;
          if (event) {
            shouldProcess = await markEventDeduped(event.id);
            if (shouldProcess) {
              if (event.type === "support_ticket_changed") {
                await handleSupportTicketChanged(event);
              }
              for (const section of sectionForEventType(event.type)) {
                dirtySections.add(section);
              }
              lastEventAt = Date.now();
              const occurredAtTs = new Date(event.occurredAt).getTime();
              const lagMs = Number.isFinite(occurredAtTs)
                ? Math.max(0, Date.now() - occurredAtTs)
                : 0;
              recordAnalyticsWorkerConsumed({
                lagMs,
                occurredAt: event.occurredAt,
              });
            }
          }

          await redis.xack(STREAM_KEY, GROUP_NAME, streamEntryId);
          if (shouldProcess) totalConsumed += 1;
        }
      }

      scheduleFlush();
      await logHealthMaybe();
    } catch (err: any) {
      recordAnalyticsWorkerError();
      console.error(`[analytics-worker] stream error: ${err?.message || "unknown"}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

if (require.main === module) {
  void startAnalyticsWorker({ leaderLock: false });
}

process.on("SIGTERM", async () => {
  console.log("[analytics-worker] shutting down");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[analytics-worker] interrupted");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
});
