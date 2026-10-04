jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_t, name) => {
  const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value;
} }) }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createCarrierFailureSupportTicket: jest.fn() }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import http = require("http");
import https = require("https");
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { repairSandboxPublicationInternal as repair } from "../../src/modules/integrations-core/application/sandbox-publication-repair";
import { integrationCanonicalEventRepository as repository } from "../../src/modules/integrations-core/infrastructure/canonical-event.repo";
import { applyCarrierIntegrationEvent } from "../../src/modules/orders-legs/carrier-events";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable run required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== "/cp_worker_" + run) throw Error("Refusing existing database");
const options = "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000";
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, options });
let mockPrisma: PrismaClient;
const fixture = createTenantDemoFixture(), memberships = fixture.companyMemberships.filter(m => m.userId === ids.users.multiTenant);
const actor = (i = 0): any => ({ ...memberships[i], id: memberships[i].userId, membershipId: memberships[i].id, companyMembershipId: memberships[i].id });
const orderIds = memberships.map(m => fixture.orders.find(o => o.ownerOrgId === m.companyId)!.id);
const providers: string[] = [], roles: string[] = [];
let sequence = 30;
let fetchSpy: jest.SpyInstance, httpSpy: jest.SpyInstance, httpsSpy: jest.SpyInstance;
async function snapshot() {
  const tables = ["Order", "OrderLeg", "IntegrationOutbox", "IntegrationDeliveryAttempt", "IntegrationCanonicalEvent", "CarrierPublicationRepair", "Tracking", "UserNotification", "AnalyticsDomainEventOutbox"];
  const result: any = {};
  for (const table of tables) result[table] = (await pool.query('SELECT to_jsonb(t) AS row FROM "' + table + '" t ORDER BY to_jsonb(t)::text')).rows;
  return result;
}
async function source(i = 0) {
  const m = memberships[i];
  const leg = await mockPrisma.orderLeg.create({ data: { orderId: orderIds[i], sequence: sequence++, carrierProviderId: providers[i], carrierCode: "fake_carrier", carrierBookingStatus: "requested" } });
  const executed = new Date(Date.now() - 3000), started = new Date(executed.getTime() + 1000), finished = new Date(started.getTime() + 1000);
  const row = await mockPrisma.integrationOutbox.create({ data: { companyId: m.companyId, providerId: providers[i], domain: "carrier", providerCode: "fake_carrier", environment: "sandbox", aggregateType: "shipment", aggregateId: leg.id,
    operation: "create_shipment", eventType: "shipment.assigned", idempotencyKey: randomUUID(), payload: { companyId: m.companyId, aggregateType: "shipment", aggregateId: leg.id, payload: { action: "create_shipment", input: { metadata: { orderId: orderIds[i], orderLegId: leg.id } } } },
    ownershipTenantId: m.tenantId, ownershipOrderId: orderIds[i], acceptedAt: executed, executionStartedAt: executed, status: "sent", attemptCount: 1 } });
  const attempt = await mockPrisma.integrationDeliveryAttempt.create({ data: { outboxId: row.id, attemptNo: 1, outcome: "success", statusCode: 200, startedAt: started, finishedAt: finished, requestJson: { synthetic: true }, responseJson: { partnerShipmentId: "synthetic-" + leg.id, trackingNumber: "synthetic" } } });
  const input: any = { source: "outbound_response", outboxId: row.id, domain: "carrier", providerCode: "fake_carrier", aggregateType: "shipment", aggregateId: leg.id, eventType: "carrier.shipment.created", occurredAt: finished.toISOString(),
    payloadJson: { requestJson: attempt.requestJson, responseJson: attempt.responseJson, providerRequestId: null, statusCode: 200 } };
  return { row, leg, attempt, input };
}
beforeAll(async () => {
  const marker = (await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if (marker.length !== 1 || marker[0].runId !== run) throw Error("Ownership mismatch");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await persistTenantDemoFixture(client, fixture); await client.query("COMMIT"); } finally { await client.query("ROLLBACK"); client.release(); }
  mockPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 6, connectionTimeoutMillis: 3000, options }) });
  const permissions = await Promise.all(["integration.outbox.replay", "shipment.bookCarrier"].map(key => mockPrisma.permission.create({ data: { key, resource: "synthetic", action: "synthetic" } })));
  for (const m of memberships) {
    const role = await mockPrisma.role.create({ data: { code: randomUUID(), name: "Synthetic publication repair", companyId: m.companyId } }); roles.push(role.id);
    for (const p of permissions) await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } });
    await mockPrisma.membershipRole.create({ data: { membershipId: m.id, roleId: role.id } });
    await mockPrisma.membershipScope.create({ data: { membershipId: m.id, scopeType: "company", scopeRefId: m.companyId } });
    providers.push((await mockPrisma.integrationProvider.create({ data: { companyId: m.companyId, domain: "carrier", providerCode: "fake_carrier", environment: "sandbox" } })).id);
  }
  fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(Error("Provider network forbidden"));
  httpSpy = jest.spyOn(http, "request").mockImplementation(() => { throw Error("Provider HTTP forbidden"); });
  httpsSpy = jest.spyOn(https, "request").mockImplementation(() => { throw Error("Provider HTTPS forbidden"); });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); expect(httpSpy).not.toHaveBeenCalled(); expect(httpsSpy).not.toHaveBeenCalled(); });
afterAll(async () => { fetchSpy?.mockRestore(); httpSpy?.mockRestore(); httpsSpy?.mockRestore(); await mockPrisma?.$disconnect(); await pool.end(); });

it("valid repair and matching retry preserve the original source and do not change the booking", async () => {
  const s = await source(), before = await snapshot(), result = await repair(actor(), s.row.id);
  expect(await repair(actor(), s.row.id)).toEqual(result);
  expect(result).toMatchObject({ outboxId: s.row.id, status: "pending" });
  expect(await mockPrisma.integrationCanonicalEvent.count({ where: { outboxId: s.row.id } })).toBe(1);
  expect(await mockPrisma.carrierPublicationRepair.count({ where: { outboxId: s.row.id } })).toBe(1);
  const after = await snapshot(); for (const table of Object.keys(before).filter(t => !["IntegrationCanonicalEvent", "CarrierPublicationRepair"].includes(t))) expect(after[table]).toEqual(before[table]);
});
it("concurrent repair and normal publisher produce one publication and one repair fact", async () => {
  const s = await source();
  const results = await Promise.all([repair(actor(), s.row.id), repair(actor(), s.row.id), repair(actor(), s.row.id), repository.enqueue(s.input)]);
  expect(new Set(results.map((r: any) => r.publicationId ?? r.id)).size).toBe(1);
  expect(await mockPrisma.integrationCanonicalEvent.count({ where: { outboxId: s.row.id } })).toBe(1);
  expect(await mockPrisma.carrierPublicationRepair.count({ where: { outboxId: s.row.id } })).toBe(1);
});
it("another company or tenant and forged selected context cannot publish", async () => {
  const s = await source(), before = await snapshot();
  for (const user of [actor(1), actor(2), {}, { ...actor(), tenantId: actor(2).tenantId }, { ...actor(), companyMembershipId: actor(1).companyMembershipId }]) await expect(repair(user as any, s.row.id)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
it("the normal canonical consumer applies one accepted booking and tracking fact despite duplicate delivery", async () => {
  const s = await source(), result = await repair(actor(), s.row.id);
  await mockPrisma.integrationCanonicalEvent.update({ where: { id: result.publicationId }, data: { status: "processing", lockedAt: new Date(), processAttempts: 1 } });
  const applications = await Promise.all([applyCarrierIntegrationEvent({ id: result.publicationId } as any), applyCarrierIntegrationEvent({ id: result.publicationId } as any), repair(actor(), s.row.id)]);
  expect(applications.slice(0, 2)).toEqual([{ applied: true }, { applied: true }]);
  const before = await snapshot();
  expect(await applyCarrierIntegrationEvent({ id: result.publicationId, companyId: actor(2).companyId, payloadJson: { responseJson: { partnerShipmentId: "forged" } } } as any)).toEqual({ applied: true });
  expect(await snapshot()).toEqual(before);
  expect(await mockPrisma.tracking.count({ where: { orderLegId: s.leg.id } })).toBe(1);
  expect(await mockPrisma.orderLeg.findUnique({ where: { id: s.leg.id } })).toMatchObject({ carrierRef: "synthetic-" + s.leg.id, carrierBookingStatus: "booked" });
  expect((await repair(actor(), s.row.id)).publicationId).toBe(result.publicationId);
});
it("fresh permission and scope removal deny without effects", async () => {
  const s = await source(), grant = await mockPrisma.rolePermission.findFirstOrThrow({ where: { roleId: roles[0] } });
  await mockPrisma.rolePermission.delete({ where: { id: grant.id } });
  try { const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before); } finally { await mockPrisma.rolePermission.create({ data: grant }); }
  const scope = await mockPrisma.membershipScope.findFirstOrThrow({ where: { membershipId: memberships[0].id } });
  await mockPrisma.membershipScope.delete({ where: { id: scope.id } });
  try { const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before); } finally { await mockPrisma.membershipScope.create({ data: scope }); }
});
it.each(["pending", "failed", "dead_letter"] as const)("%s source never becomes successful publication", async status => {
  const s = await source(); await mockPrisma.integrationOutbox.update({ where: { id: s.row.id }, data: { status } });
  const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it.each(["missing", "retry", "invalid_response", "non_success_http", "wrong_time"])("%s durable result remains contained", async kind => {
  const s = await source();
  if (kind === "missing") await mockPrisma.integrationDeliveryAttempt.delete({ where: { id: s.attempt.id } });
  else await mockPrisma.integrationDeliveryAttempt.update({ where: { id: s.attempt.id }, data: kind === "retry" ? { outcome: "retry" } : kind === "invalid_response" ? { responseJson: { success: true } } : kind === "non_success_http" ? { statusCode: 500 } : { finishedAt: new Date(0) } });
  const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it.each(["tenant", "company", "provider"])("disabled %s rejects publication", async kind => {
  const s = await source();
  const disable = async (disabled: boolean) => kind === "tenant" ? mockPrisma.tenant.update({ where: { id: actor().tenantId }, data: { status: disabled ? "suspended" : "active" } }) : kind === "company" ? mockPrisma.organization.update({ where: { id: actor().companyId }, data: { isActive: !disabled } }) : mockPrisma.integrationProvider.update({ where: { id: providers[0] }, data: { status: disabled ? "disabled" : "active" } });
  await disable(true); try { const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before); } finally { await disable(false); }
});
it.each(["wrong_child", "conflicting_booking", "unaccepted"])("%s source rejects without effects", async kind => {
  const s = await source();
  if (kind === "wrong_child") await mockPrisma.integrationOutbox.update({ where: { id: s.row.id }, data: { payload: { ...s.row.payload as any, aggregateId: randomUUID() } } });
  else if (kind === "conflicting_booking") await mockPrisma.orderLeg.update({ where: { id: s.leg.id }, data: { carrierRef: "different" } });
  else await mockPrisma.integrationOutbox.update({ where: { id: s.row.id }, data: { acceptedAt: null, ownershipTenantId: null, ownershipOrderId: null, executionStartedAt: null } });
  const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it.each(["unsupported_provider", "production", "missing_admission", "multiple_attempts"])("%s is not repairable", async kind => {
  const s = await source();
  if (kind === "unsupported_provider" || kind === "production") {
    const provider = await mockPrisma.integrationProvider.create({ data: { companyId: actor().companyId, domain: "carrier", providerCode: kind === "production" ? "fake_carrier" : "unsupported_synthetic", environment: kind === "production" ? "production" : "sandbox" } });
    await mockPrisma.orderLeg.update({ where: { id: s.leg.id }, data: { carrierProviderId: provider.id, carrierCode: provider.providerCode } });
    await mockPrisma.integrationOutbox.update({ where: { id: s.row.id }, data: { providerId: provider.id, providerCode: provider.providerCode, environment: provider.environment } });
  } else await mockPrisma.integrationOutbox.update({ where: { id: s.row.id }, data: kind === "missing_admission" ? { executionStartedAt: null } : { attemptCount: 2 } });
  const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it("existing conflicting publication is never overwritten or accepted", async () => {
  const s = await source(); await repository.enqueue(s.input);
  await mockPrisma.integrationCanonicalEvent.updateMany({ where: { outboxId: s.row.id }, data: { payloadJson: { forged: true } } });
  const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toMatchObject({ code: "INTEGRATION_CANONICAL_ID_CONFLICT" }); expect(await snapshot()).toEqual(before);
});
it("suspended membership cannot retrieve an existing repair receipt", async () => {
  const s = await source(); await repair(actor(), s.row.id);
  await mockPrisma.companyMembership.update({ where: { id: memberships[0].id }, data: { status: "suspended" } });
  try { const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before); } finally { await mockPrisma.companyMembership.update({ where: { id: memberships[0].id }, data: { status: "active" } }); }
});
it("changed durable result cannot reuse a confirmed repair identity", async () => {
  const s = await source(); await repair(actor(), s.row.id);
  await mockPrisma.integrationDeliveryAttempt.update({ where: { id: s.attempt.id }, data: { responseJson: { partnerShipmentId: "changed-synthetic-result" } } });
  const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toMatchObject({ code: "INTEGRATION_CANONICAL_ID_CONFLICT" }); expect(await snapshot()).toEqual(before);
});
it("failure writing repair evidence rolls back publication and all business tables", async () => {
  const s = await source();
  await pool.query(`CREATE FUNCTION cp_test_repair_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$; CREATE TRIGGER cp_test_repair_failure BEFORE INSERT ON "CarrierPublicationRepair" FOR EACH ROW EXECUTE FUNCTION cp_test_repair_failure();`);
  try { const before = await snapshot(); await expect(repair(actor(), s.row.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before); } finally { await pool.query('DROP TRIGGER cp_test_repair_failure ON "CarrierPublicationRepair"; DROP FUNCTION cp_test_repair_failure();'); }
});
it("a simulated lost acknowledgement after real commit is safely retryable by source identity", async () => {
  const s = await source(), original = mockPrisma.$transaction.bind(mockPrisma);
  const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementationOnce((async (fn: any, settings: any) => { await original(fn, settings); throw Error("Synthetic lost acknowledgement"); }) as any);
  try { await expect(repair(actor(), s.row.id)).rejects.toThrow("Synthetic lost acknowledgement"); } finally { spy.mockRestore(); }
  const result = await repair(actor(), s.row.id);
  expect(result.status).toBe("pending"); expect(await mockPrisma.integrationCanonicalEvent.count({ where: { outboxId: s.row.id } })).toBe(1); expect(await mockPrisma.carrierPublicationRepair.count({ where: { outboxId: s.row.id } })).toBe(1);
});
it("database evidence is append-only and compound membership references reject conflicting ownership", async () => {
  const s = await source(); await repair(actor(), s.row.id);
  await expect(pool.query('UPDATE "CarrierPublicationRepair" SET "resultSha256"=$1 WHERE "outboxId"=$2', ["b".repeat(64), s.row.id])).rejects.toMatchObject({ code: "23514" });
  await expect(pool.query('DELETE FROM "CarrierPublicationRepair" WHERE "outboxId"=$1', [s.row.id])).rejects.toMatchObject({ code: "23514" });
  const other = await source(); await repository.enqueue(other.input);
  const proof = await mockPrisma.carrierPublicationRepair.findUniqueOrThrow({ where: { outboxId: s.row.id } });
  await expect(mockPrisma.carrierPublicationRepair.create({ data: { ...proof, outboxId: other.row.id, companyMembershipId: memberships[2].id } })).rejects.toMatchObject({ code: "P2003" });
  expect(await mockPrisma.carrierPublicationRepair.count({ where: { outboxId: other.row.id } })).toBe(0);
  const catalog = await pool.query(`SELECT contype FROM pg_constraint WHERE conrelid='"CarrierPublicationRepair"'::regclass`);
  expect(catalog.rows.filter(r => r.contype === "f")).toHaveLength(5); expect(catalog.rows.filter(r => r.contype === "c")).toHaveLength(1);
});
