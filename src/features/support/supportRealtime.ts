import { EventEmitter } from "events";
import { getRedisClient, getRedisPrefix } from "../../config/redis";

export type SupportRefreshReason =
  | "ticket_created"
  | "ticket_updated"
  | "message_added"
  | "note_added"
  | "ticket_archived";

export type SupportRefreshEvent = {
  id?: string;
  type: "support.refresh";
  at: string;
  reason: SupportRefreshReason;
  ticketId?: string | null;
  keys: Array<"list" | "detail" | "summary">;
};

const emitter = new EventEmitter();
const STREAM_MAX_LEN = 10_000;
const EVENT_BUFFER_LIMIT = Math.max(100, Number(process.env.SUPPORT_STREAM_REPLAY_BUFFER || 1000));
let consumerStarted = false;
let streamLastId = "$";
let localEventSeq = 0;
const recentEvents: SupportRefreshEvent[] = [];

function getSupportEventsStream() {
  return `${getRedisPrefix()}:support:events`;
}

function safeParseEvent(raw: string): SupportRefreshEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SupportRefreshEvent> | null;
    if (parsed?.type !== "support.refresh") return null;
    return {
      id: parsed.id ? String(parsed.id) : undefined,
      type: "support.refresh",
      at: String(parsed.at || new Date().toISOString()),
      reason: (parsed.reason as SupportRefreshReason) || "ticket_updated",
      ticketId: parsed.ticketId ?? null,
      keys: Array.isArray(parsed.keys) && parsed.keys.length
        ? (parsed.keys as SupportRefreshEvent["keys"])
        : ["list", "summary", "detail"],
    };
  } catch {
    return null;
  }
}

function appendRecentEvent(event: SupportRefreshEvent) {
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
        getSupportEventsStream(),
        streamLastId,
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) continue;

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
            emitter.emit("support.refresh", event);
          }
        }
      }
    } catch (err: any) {
      console.error(`[support] stream read error: ${err?.message || "unknown"}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

export function ensureSupportRefreshConsumer() {
  if (consumerStarted) return;
  consumerStarted = true;
  void startStreamConsumer();
}

export async function publishSupportRefresh(
  reason: SupportRefreshReason,
  options?: {
    ticketId?: string | null;
    keys?: SupportRefreshEvent["keys"];
  },
) {
  const event: SupportRefreshEvent = {
    id: String(++localEventSeq),
    type: "support.refresh",
    at: new Date().toISOString(),
    reason,
    ticketId: options?.ticketId ?? null,
    keys: options?.keys?.length ? options.keys : ["list", "summary", "detail"],
  };

  emitter.emit("support.refresh", event);
  appendRecentEvent(event);

  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.xadd(
      getSupportEventsStream(),
      "MAXLEN",
      "~",
      String(STREAM_MAX_LEN),
      "*",
      "type",
      event.type,
      "reason",
      event.reason,
      "ticketId",
      event.ticketId ?? "",
      "keys",
      JSON.stringify(event.keys),
      "data",
      JSON.stringify(event),
    );
  } catch (err: any) {
    console.error(`[support] stream publish failed: ${err?.message || "unknown"}`);
  }
}

export function replaySupportRefreshSince(lastEventId: string | null | undefined) {
  if (!lastEventId) return [];
  const normalized = String(lastEventId).trim();
  if (!normalized) return [];
  const idx = recentEvents.findIndex((event) => String(event.id || "") === normalized);
  if (idx < 0) return [];
  return recentEvents.slice(idx + 1);
}

export async function replaySupportRefreshFromRedis(args: { lastEventId?: string | null; limit?: number }) {
  const lastEventId = String(args.lastEventId || "").trim();
  if (!lastEventId) return [] as SupportRefreshEvent[];
  const redis = await getRedisClient();
  if (!redis) return [] as SupportRefreshEvent[];
  try {
    const entries = (await redis.call(
      "XRANGE",
      getSupportEventsStream(),
      `(${lastEventId}`,
      "+",
      "COUNT",
      String(Math.max(1, Math.min(args.limit ?? 200, 1000))),
    )) as Array<[string, string[]]>;
    return entries
      .map(([, fields]) => {
        const dataIdx = fields.indexOf("data");
        if (dataIdx === -1) return null;
        const raw = fields[dataIdx + 1];
        return raw ? safeParseEvent(raw) : null;
      })
      .filter((item): item is SupportRefreshEvent => Boolean(item));
  } catch (err: any) {
    console.error(`[support] replay from redis failed: ${err?.message || "unknown"}`);
    return [] as SupportRefreshEvent[];
  }
}

export function subscribeSupportRefresh(handler: (event: SupportRefreshEvent) => void) {
  emitter.on("support.refresh", handler);
  ensureSupportRefreshConsumer();

  return () => {
    emitter.off("support.refresh", handler);
  };
}
