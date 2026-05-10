import { EventEmitter } from "events";
import { getRedisClient, getRedisPrefix } from "../../config/redis";

export type AnalyticsInvalidationReason =
  | "order_mutation"
  | "invoice_mutation"
  | "cash_mutation"
  | "manual_refresh"
  | "worker_rebuild";

export type AnalyticsRefreshSection =
  | "summary"
  | "trend"
  | "warnings"
  | "finance-queue";

export type AnalyticsInvalidationEvent = {
  id?: string;
  type: "analytics.invalidate";
  at: string;
  reason: AnalyticsInvalidationReason;
  scope: string;
  keys: AnalyticsRefreshSection[];
  source?: "api" | "worker";
};

const emitter = new EventEmitter();
const STREAM_MAX_LEN = 10_000;
const EVENT_BUFFER_LIMIT = Math.max(100, Number(process.env.ANALYTICS_V2_STREAM_REPLAY_BUFFER || 1000));
let consumerStarted = false;
let streamLastId = "$";
let localEventSeq = 0;
const recentEvents: AnalyticsInvalidationEvent[] = [];

function getAnalyticsEventsStream() {
  return `${getRedisPrefix()}:analytics:v2:events`;
}

function safeParseEvent(raw: string): AnalyticsInvalidationEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyticsInvalidationEvent> | null;
    if (parsed?.type !== "analytics.invalidate") return null;
    return {
      id: parsed.id ? String(parsed.id) : undefined,
      type: "analytics.invalidate",
      at: String(parsed.at || new Date().toISOString()),
      reason: (parsed.reason as AnalyticsInvalidationReason) || "manual_refresh",
      scope: String(parsed.scope || "global"),
      keys: Array.isArray(parsed.keys) && parsed.keys.length > 0
        ? (parsed.keys as AnalyticsRefreshSection[])
        : ["summary", "trend", "warnings", "finance-queue"],
      source: parsed.source === "worker" ? "worker" : "api",
    };
  } catch {
    return null;
  }
}

function appendRecentEvent(event: AnalyticsInvalidationEvent) {
  recentEvents.push(event);
  if (recentEvents.length > EVENT_BUFFER_LIMIT) {
    recentEvents.splice(0, recentEvents.length - EVENT_BUFFER_LIMIT);
  }
}

async function startStreamConsumer() {
  const redis = await getRedisClient();
  if (!redis) return;

  while (true) {
    try {
      const results = (await redis.xread(
        "COUNT",
        100,
        "BLOCK",
        2000,
        "STREAMS",
        getAnalyticsEventsStream(),
        streamLastId,
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (results) {
        for (const [, entries] of results) {
          for (const [id, fields] of entries) {
            streamLastId = id;
            const dataIdx = fields.indexOf("data");
            if (dataIdx === -1) continue;
            const raw = fields[dataIdx + 1];
            if (!raw) continue;
            const event = safeParseEvent(raw);
            if (event) {
              appendRecentEvent(event);
              emitter.emit("analytics.invalidate", event);
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`[analytics-v2] stream read error: ${err?.message || "unknown"}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export function ensureAnalyticsInvalidationConsumer() {
  if (consumerStarted) return;
  consumerStarted = true;
  void startStreamConsumer();
}

export async function publishAnalyticsInvalidation(
  reason: AnalyticsInvalidationReason,
  options?: {
    scope?: string;
    keys?: AnalyticsRefreshSection[];
    source?: "api" | "worker";
  },
) {
  const event: AnalyticsInvalidationEvent = {
    id: String(++localEventSeq),
    type: "analytics.invalidate",
    at: new Date().toISOString(),
    reason,
    scope: options?.scope || "global",
    keys: options?.keys?.length
      ? options.keys
      : ["summary", "trend", "warnings", "finance-queue"],
    source: options?.source || "api",
  };

  emitter.emit("analytics.invalidate", event);
  appendRecentEvent(event);

  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.xadd(
      getAnalyticsEventsStream(),
      "MAXLEN",
      "~",
      String(STREAM_MAX_LEN),
      "*",
      "type",
      event.type,
      "reason",
      event.reason,
      "scope",
      event.scope,
      "keys",
      JSON.stringify(event.keys),
      "source",
      event.source || "api",
      "data",
      JSON.stringify(event),
    );
  } catch (err: any) {
    console.error(`[analytics-v2] stream publish failed: ${err?.message || "unknown"}`);
  }
}

export function replayAnalyticsInvalidationSince(lastEventId: string | null | undefined) {
  if (!lastEventId) return [];
  const normalized = String(lastEventId).trim();
  if (!normalized) return [];
  const idx = recentEvents.findIndex((event) => String(event.id || "") === normalized);
  if (idx < 0) return [];
  return recentEvents.slice(idx + 1);
}

export async function replayAnalyticsInvalidationFromRedis(args: {
  lastEventId?: string | null;
  limit?: number;
}) {
  const lastEventId = String(args.lastEventId || "").trim();
  if (!lastEventId) return [] as AnalyticsInvalidationEvent[];
  const redis = await getRedisClient();
  if (!redis) return [] as AnalyticsInvalidationEvent[];
  try {
    const entries = (await redis.call(
      "XRANGE",
      getAnalyticsEventsStream(),
      `(${lastEventId}`,
      "+",
      "COUNT",
      String(Math.max(1, Math.min(args.limit ?? 250, 1000))),
    )) as Array<[string, string[]]>;
    return entries
      .map(([, fields]) => {
        const dataIdx = fields.indexOf("data");
        if (dataIdx === -1) return null;
        const raw = fields[dataIdx + 1];
        return raw ? safeParseEvent(raw) : null;
      })
      .filter((item): item is AnalyticsInvalidationEvent => Boolean(item));
  } catch (err: any) {
    console.error(`[analytics-v2] replay from redis failed: ${err?.message || "unknown"}`);
    return [] as AnalyticsInvalidationEvent[];
  }
}

export function subscribeAnalyticsInvalidation(
  handler: (event: AnalyticsInvalidationEvent) => void,
) {
  emitter.on("analytics.invalidate", handler);
  ensureAnalyticsInvalidationConsumer();

  return () => {
    emitter.off("analytics.invalidate", handler);
  };
}
