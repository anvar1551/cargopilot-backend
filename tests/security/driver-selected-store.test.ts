jest.mock("../../src/config/redis", () => ({ getRedisClient: jest.fn(), getRedisPrefix: () => "synthetic", withRedisTimeout: (_name: string, operation: () => unknown) => operation() }));
import { getRedisClient } from "../../src/config/redis";
import { selectedTelemetryKey, writeSelectedPresence, writeSelectedTelemetry, readSelectedPresence, readSelectedTelemetry } from "../../src/modules/live-map-core/infrastructure/selectedTelemetryStore";
const context = { userId: "same-user", tenantId: "tenant-a", companyId: "company-a", tenantMembershipId: "tm-a", companyMembershipId: "cm-a" };
const values = new Map<string, string>();
const redis = { status: "ready", get: jest.fn(async (key: string) => values.get(key) ?? null), set: jest.fn(async (key: string, value: string) => { values.set(key, value); return "OK"; }) };
beforeEach(() => { jest.clearAllMocks(); values.clear(); redis.status = "ready"; (getRedisClient as jest.Mock).mockResolvedValue(redis); });
it("partitions one user's separate tenants and company memberships without touching legacy keys", async () => {
  const others = [context, { ...context, companyId: "company-b", companyMembershipId: "cm-b" }, { ...context, tenantId: "tenant-b", tenantMembershipId: "tm-b", companyMembershipId: "cm-c" }];
  for (const [index, item] of others.entries()) await writeSelectedPresence(item, { enabled: index === 0, updatedAt: "2026-01-01T00:00:00Z" });
  expect(new Set(others.map(item => selectedTelemetryKey(item, "presence"))).size).toBe(3);
  for (const [index, item] of others.entries()) expect(await readSelectedPresence(item)).toMatchObject({ enabled: index === 0 });
  redis.set.mock.calls.forEach(call => { expect(call[0]).toMatch(/^synthetic:live-map:selected:v1:[a-f0-9]{64}:presence$/); expect(call).toHaveLength(4); expect(call.slice(2)).toEqual(["EX", 86400]); });
});
it("never reads legacy unowned data or falls back to a stale process-local record", async () => {
  values.set("synthetic:live-map:driver-presence:same-user", JSON.stringify({ enabled: true }));
  expect(await readSelectedPresence(context)).toBeNull();
  (getRedisClient as jest.Mock).mockResolvedValue(null);
  await expect(readSelectedPresence(context)).rejects.toMatchObject({ statusCode: 503 });
});
it.each(["userId", "tenantId", "companyId", "tenantMembershipId", "companyMembershipId"])("missing %s denies before Redis work", async field => {
  await expect(readSelectedPresence({ ...context, [field]: "" })).rejects.toMatchObject({ statusCode: 403 });
  expect(getRedisClient).not.toHaveBeenCalled();
});
it("corrupt or wrong-context cache envelopes do not expose data", async () => {
  const key = selectedTelemetryKey(context, "presence");
  for (const value of ["broken", "x".repeat(8193), JSON.stringify({ context: { ...context, tenantId: "foreign" }, value: { enabled: true, updatedAt: "2026-01-01" } })]) {
    values.set(key, value); expect(await readSelectedPresence(context)).toBeNull();
  }
});
it("presence reads expose only server heartbeat time, never cached coordinates or order references", async () => {
  await writeSelectedTelemetry(context, { receivedAt: "2026-01-01T00:00:00Z", clientCapturedAt: "2099-01-01T00:00:00Z", location: { driverId: "same-user", warehouseId: null, orderId: "PRIVATE-CANARY", lat: 53, lng: 8, speedKmh: 0, headingDeg: 0, accuracyM: null, recordedAt: "2026-01-01T00:00:00Z" } });
  expect(await readSelectedTelemetry(context)).toEqual({ receivedAt: "2026-01-01T00:00:00Z", clientCapturedAt: null, location: null });
});
it("not-ready storage denies without sending a command", async () => {
  redis.status = "reconnecting";
  await expect(writeSelectedPresence(context, { enabled: true, updatedAt: "2026-01-01" })).rejects.toMatchObject({ statusCode: 503 });
  expect(redis.set).not.toHaveBeenCalled();
});
