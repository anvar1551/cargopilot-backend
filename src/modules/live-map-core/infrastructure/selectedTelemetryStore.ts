import { createHash } from "crypto";
import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../../config/redis";

/** Cache partition only. The service must freshly authorize this exact context first. */
export type TelemetryContext = {
  userId: string;
  tenantId: string;
  tenantMembershipId: string;
  companyId: string;
  companyMembershipId: string;
};

export type SelectedPresence = { enabled: boolean; updatedAt: string };
export type SelectedTelemetry = {
  receivedAt: string;
  clientCapturedAt: string | null;
  location: {
    driverId: string; warehouseId: null; orderId: string | null;
    lat: number; lng: number; speedKmh: number; headingDeg: number;
    accuracyM: number | null; recordedAt: string;
  } | null;
};

export function selectedTelemetryKey(context: TelemetryContext, kind: "presence" | "telemetry") {
  const values = [context.tenantId, context.companyId, context.companyMembershipId, context.tenantMembershipId, context.userId];
  if (values.some(value => typeof value !== "string" || !value || value.length > 80)) {
    throw Object.assign(new Error("Selected telemetry context required"), { statusCode: 403 });
  }
  return `${getRedisPrefix()}:live-map:selected:v1:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}:${kind}`;
}

async function client() {
  const redis = await getRedisClient();
  if (!redis || redis.status !== "ready") throw Object.assign(new Error("Telemetry storage unavailable"), { statusCode: 503 });
  return redis;
}

// No user-global keys, memory/stale fallback, GEO index or global stream publication.
// Redis is ephemeral telemetry storage, not a durable action receipt.
async function read(context: TelemetryContext, kind: "presence" | "telemetry") {
  const key = selectedTelemetryKey(context, kind);
  const redis = await client();
  const value = await withRedisTimeout("selected-telemetry-read", () => redis.get(key), 1500);
  if (!value || value.length > 8192) return null;
  try {
    const record = JSON.parse(value);
    if (JSON.stringify(record.context) !== JSON.stringify(context)) return null;
    return record.value;
  } catch { return null; }
}

async function write(context: TelemetryContext, kind: "presence" | "telemetry", value: unknown) {
  const key = selectedTelemetryKey(context, kind);
  const redis = await client();
  await withRedisTimeout("selected-telemetry-write", () => redis.set(key, JSON.stringify({ context, value }), "EX", 24 * 60 * 60), 1500);
}

export async function readSelectedPresence(context: TelemetryContext): Promise<SelectedPresence | null> {
  const value = await read(context, "presence");
  return value && typeof value.enabled === "boolean" && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    ? { enabled: value.enabled, updatedAt: value.updatedAt } : null;
}
export async function readSelectedTelemetry(context: TelemetryContext): Promise<SelectedTelemetry | null> {
  const value = await read(context, "telemetry");
  if (!value || typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt))) return null;
  // Presence consumers need only server receipt time; never return cached coordinates/order IDs.
  return { receivedAt: value.receivedAt, clientCapturedAt: null, location: null };
}
export async function writeSelectedPresence(context: TelemetryContext, value: SelectedPresence) {
  await write(context, "presence", value);
}
export async function writeSelectedTelemetry(context: TelemetryContext, value: SelectedTelemetry) {
  await write(context, "telemetry", value);
}
