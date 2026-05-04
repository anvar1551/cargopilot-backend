import { randomUUID } from "crypto";
import { getRedisClient, getRedisPrefix } from "../../config/redis";

export type CargoPilotDomainEventType =
  | "order_created"
  | "order_status_changed"
  | "cash_handoff"
  | "cash_settled"
  | "driver_location_upsert"
  | "driver_presence_update"
  | "manual_refresh";

export type CargoPilotDomainEvent = {
  id: string;
  type: CargoPilotDomainEventType;
  occurredAt: string;
  tenantScope: string;
  entityId: string | null;
  schemaVersion: 1;
  payload: Record<string, unknown>;
};

const STREAM_MAX_LEN = 100_000;

export function getDomainEventsStreamKey() {
  return `${getRedisPrefix()}:cp:events`;
}

export function buildCargoPilotDomainEvent(
  partial: Omit<CargoPilotDomainEvent, "id" | "occurredAt" | "schemaVersion"> & {
    id?: string;
    occurredAt?: string;
  },
): CargoPilotDomainEvent {
  return {
    id: partial.id || randomUUID(),
    type: partial.type,
    occurredAt: partial.occurredAt || new Date().toISOString(),
    tenantScope: partial.tenantScope || "global",
    entityId: partial.entityId ?? null,
    schemaVersion: 1,
    payload:
      partial.payload && typeof partial.payload === "object" ? partial.payload : {},
  };
}

export async function appendCargoPilotDomainEvent(event: CargoPilotDomainEvent) {
  const redis = await getRedisClient();
  if (!redis) {
    throw new Error("Redis unavailable");
  }

  await redis.xadd(
    getDomainEventsStreamKey(),
    "MAXLEN",
    "~",
    String(STREAM_MAX_LEN),
    "*",
    "eventId",
    event.id,
    "type",
    event.type,
    "tenantScope",
    event.tenantScope,
    "entityId",
    event.entityId ?? "",
    "schemaVersion",
    String(event.schemaVersion),
    "data",
    JSON.stringify(event),
  );
}

export async function publishCargoPilotDomainEvent(
  partial: Omit<CargoPilotDomainEvent, "id" | "occurredAt" | "schemaVersion"> & {
    id?: string;
    occurredAt?: string;
  },
) {
  const event = buildCargoPilotDomainEvent(partial);
  try {
    await appendCargoPilotDomainEvent(event);
  } catch (err: any) {
    console.error(`[analytics-events] publish failed: ${err?.message || "unknown"}`);
  }
}
