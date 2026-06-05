import "dotenv/config";
import prisma from "../config/prismaClient";
import { createRedisClient, getRedisClient, getRedisPrefix } from "../config/redis";
import { analyticsConfig } from "../modules/analytics-core/config/analyticsConfig";
import { analyticsLogger } from "../modules/analytics-core/config/analyticsLogger";
import {
  getDomainEventsStreamKey,
  type CargoPilotDomainEvent,
  type CargoPilotDomainEventType,
} from "../modules/analytics-core/realtime/analyticsEvents";
import {
  getAnalyticsFinanceQueueV2,
  getAnalyticsSummaryV2,
  getAnalyticsTrendV2,
  getAnalyticsWarningsV2,
} from "../modules/analytics-core/application/analyticsV2";
import { clearAnalyticsReadModelBySection, type AnalyticsReadSection } from "../modules/analytics-core/infrastructure/analyticsReadModel";
import {
  publishAnalyticsInvalidation,
  type AnalyticsRefreshSection,
} from "../modules/analytics-core/realtime/analyticsV2Realtime";
import {
  recordAnalyticsWorkerConsumed,
  recordAnalyticsWorkerError,
  recordAnalyticsWorkerRebuild,
} from "../modules/observability-core/application/opsMetrics";
import { invalidateSupportCache } from "../modules/support-core/infrastructure/supportCache";
import {
  publishSupportRefresh,
  type SupportRefreshReason,
} from "../modules/support-core/realtime/supportRealtime";

const GROUP_NAME = analyticsConfig.worker.group;
const CONSUMER_NAME = analyticsConfig.worker.consumer;
const STREAM_KEY = getDomainEventsStreamKey();
const DEDUPE_TTL_SEC = analyticsConfig.worker.dedupeTtlSec;
const FLUSH_DEBOUNCE_MS = analyticsConfig.worker.flushDebounceMs;
const HEALTH_LOG_MS = analyticsConfig.worker.healthLogMs;
const HEALTH_LOG_ENABLED = analyticsConfig.worker.healthLogEnabled;
const LEADER_LOCK_KEY =
  analyticsConfig.worker.leaderLockKey || `${getRedisPrefix()}:cp:analytics:worker:lock`;
const LEADER_LOCK_TTL_SEC = analyticsConfig.worker.leaderLockTtlSec;

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
  const redis = createRedisClient({
    connectTimeout: 3000,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    commandTimeout: null,
  });
  if (!redis) return;
  await redis.connect().catch(() => undefined);
  try {
    await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  } catch (err: any) {
    const message = String(err?.message || "");
    if (!message.includes("BUSYGROUP")) {
      throw err;
    }
  } finally {
    await redis.quit().catch(() => undefined);
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
    for (const section of sections) {
      await clearAnalyticsReadModelBySection(toReadModelSection(section));
    }

    const defaultRangeDays = analyticsConfig.defaults.rangeDays;
    const defaultPageSize = analyticsConfig.defaults.queuePageSize;
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
    totalRebuilds += 1;
    recordAnalyticsWorkerRebuild();
    await publishAnalyticsInvalidation("worker_rebuild", {
      scope: "role:manager",
      keys: sections,
      source: "worker",
    });
  } catch (err: any) {
    recordAnalyticsWorkerError();
    analyticsLogger.throttledError("worker-rebuild-failed", "analytics worker rebuild failed", {
      error: err,
      throttleMs: 30_000,
    });
  }
}

async function logHealthMaybe() {
  if (!HEALTH_LOG_ENABLED) return;
  const now = Date.now();
  if (now - lastHealthLogAt < HEALTH_LOG_MS) return;
  lastHealthLogAt = now;
  const lagMs = lastEventAt > 0 ? now - lastEventAt : 0;
  analyticsLogger.info("analytics worker health", {
    consumed: totalConsumed,
    rebuilds: totalRebuilds,
    lagMs,
    dirtySections: dirtySections.size,
  });
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
  analyticsLogger.info("analytics worker starting", {
    consumer: CONSUMER_NAME,
    group: GROUP_NAME,
    leaderLock: useLeaderLock,
  });
  await ensureConsumerGroup();

  const createStreamRedis = () =>
    createRedisClient({
      connectTimeout: 3000,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      lazyConnect: true,
      commandTimeout: null,
    });
  let streamRedis = createStreamRedis();
  if (!streamRedis) {
    analyticsLogger.error("analytics worker stream redis unavailable at startup");
    return;
  }
  await streamRedis.connect().catch(() => undefined);

  while (true) {
    try {
      if (!streamRedis) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        streamRedis = createStreamRedis();
        if (streamRedis) {
          await streamRedis.connect().catch(() => undefined);
        }
        continue;
      }
      const leader = await isLeaderOrAcquire({ enabled: useLeaderLock });
      if (!leader) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      if (streamRedis.status !== "ready") {
        await streamRedis.connect().catch(() => undefined);
      }
      if (streamRedis.status !== "ready") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const results = (await streamRedis.xreadgroup(
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

          await streamRedis.xack(STREAM_KEY, GROUP_NAME, streamEntryId);
          if (shouldProcess) totalConsumed += 1;
        }
      }

      scheduleFlush();
      await logHealthMaybe();
    } catch (err: any) {
      recordAnalyticsWorkerError();
      analyticsLogger.throttledError("worker-stream-error", "analytics worker stream error", {
        error: err,
        throttleMs: 30_000,
      });
      try {
        streamRedis?.disconnect();
      } catch {
        // noop
      }
      streamRedis = createStreamRedis();
      if (streamRedis) {
        await streamRedis.connect().catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

if (require.main === module) {
  void startAnalyticsWorker({ leaderLock: false });
}

process.on("SIGTERM", async () => {
  analyticsLogger.info("analytics worker shutting down");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
});

process.on("SIGINT", async () => {
  analyticsLogger.info("analytics worker interrupted");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
});
