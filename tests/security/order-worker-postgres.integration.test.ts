jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => (mockPrisma as any)[name] }) }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createCarrierFailureSupportTicket: jest.fn() }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { applyCarrierIntegrationEvent } from "../../src/modules/orders-legs/carrier-events";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL;
const runId = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !runId || !/^[a-f0-9]{12}$/.test(runId)) throw new Error("Disposable worker instance identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${runId}`) {
  throw new Error("Refusing non-disposable worker PostgreSQL target");
}
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000, options: "-c statement_timeout=5000" });
let mockPrisma: PrismaClient;
const providerId = "019b3000-0000-7000-8b00-000000000001";
const legId = "019b3000-0000-7000-8b00-000000000002";
const outboxId = "019b3000-0000-7000-8b00-000000000003";
const eventId = "019b3000-0000-7000-8b00-000000000004";
beforeAll(async () => {
  const identity = await pool.query('SELECT "runId" FROM "_CPDisposableRun"');
  if (identity.rows.length !== 1 || identity.rows[0].runId !== runId) throw new Error("Disposable storage ownership mismatch");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await persistTenantDemoFixture(client, createTenantDemoFixture()); await client.query("COMMIT"); }
  finally { client.release(); }
  mockPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000" }) });
  await mockPrisma.integrationProvider.create({ data: { id: providerId, companyId: ids.organizations.transAsiaUz, domain: "carrier", providerCode: "synthetic", environment: "sandbox" } });
  await mockPrisma.orderLeg.create({ data: { id: legId, orderId: ids.orders.transAsiaUz, sequence: 1, mode: "road", carrierProviderId: providerId, carrierCode: "synthetic", carrierRef: "synthetic-ref" } });
  await mockPrisma.integrationOutbox.create({ data: { id: outboxId, companyId: ids.organizations.transAsiaUz, providerId,
    domain: "carrier", providerCode: "synthetic", environment: "sandbox", operation: "track", eventType: "carrier.command.requested",
    aggregateType: "shipment", aggregateId: legId, ownershipTenantId: ids.tenants.transAsia, ownershipOrderId: ids.orders.transAsiaUz,
    acceptedAt: new Date(), status: "sent", attemptCount: 1, idempotencyKey: `synthetic:${runId}`,
    payload: { companyId: ids.organizations.transAsiaUz, aggregateType: "shipment", aggregateId: legId,
      payload: { action: "track", input: { partnerShipmentId: "synthetic-ref", metadata: { orderId: ids.orders.transAsiaUz, orderLegId: legId } } } },
  } });
  await mockPrisma.integrationDeliveryAttempt.create({ data: { outboxId, attemptNo: 1, outcome: "success", startedAt: new Date(), finishedAt: new Date(), responseJson: { statusCode: "in_transit" } } });
  await mockPrisma.integrationCanonicalEvent.create({ data: { id: eventId, source: "outbound_response", status: "processing", companyId: ids.organizations.transAsiaUz, providerId, outboxId, domain: "carrier", providerCode: "synthetic", eventType: "carrier.status.updated", aggregateType: "shipment", aggregateId: legId, occurredAt: new Date(), payloadJson: { statusCode: "delivered" } } });
});
afterAll(async () => { await mockPrisma?.$disconnect(); await pool.end(); });

it("enforces complete label grants and same-order tenant/company targets on insertion and update", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insert = `INSERT INTO "OrderLabelJob" ("orderId", "ownershipTenantId", "ownershipCompanyId", "acceptedAt", "capability", "updatedAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP,'label.generate',CURRENT_TIMESTAMP)`;
    await client.query(insert, [ids.orders.transAsiaUz, ids.tenants.transAsia, ids.organizations.transAsiaUz]);
    for (const [tenant, company, expected] of [
      [null, ids.organizations.transAsiaDe, "23514"],
      [ids.tenants.unrelated, ids.organizations.unrelated, "23503"],
      [ids.tenants.transAsia, ids.organizations.transAsiaUz, "23503"],
    ]) {
      await client.query("SAVEPOINT rejected"); let code;
      try { await client.query(insert, [ids.orders.transAsiaDe, tenant, company]); } catch (error) { code = (error as any).code; }
      await client.query("ROLLBACK TO SAVEPOINT rejected"); expect(code).toBe(expected);
    }
    await client.query("SAVEPOINT changed"); let code;
    try { await client.query('UPDATE "OrderLabelJob" SET "ownershipCompanyId"=$1 WHERE "orderId"=$2', [ids.organizations.transAsiaDe, ids.orders.transAsiaUz]); }
    catch (error) { code = (error as any).code; }
    await client.query("ROLLBACK TO SAVEPOINT changed"); expect(code).toBe("23503");
    expect((await client.query('SELECT "ownershipCompanyId" FROM "OrderLabelJob" WHERE "orderId"=$1', [ids.orders.transAsiaUz])).rows[0].ownershipCompanyId).toBe(ids.organizations.transAsiaUz);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("enforces carrier grant completeness and rejects cross-company order targets without changing the row", async () => {
  const before = await mockPrisma.integrationOutbox.findUniqueOrThrow({ where: { id: outboxId } });
  await expect(mockPrisma.integrationOutbox.update({ where: { id: outboxId }, data: { ownershipTenantId: null } })).rejects.toBeDefined();
  await expect(mockPrisma.integrationOutbox.update({ where: { id: outboxId }, data: { ownershipOrderId: ids.orders.transAsiaDe } })).rejects.toBeDefined();
  await expect(mockPrisma.integrationOutbox.update({ where: { id: outboxId }, data: { companyId: ids.organizations.unrelated } })).rejects.toBeDefined();
  expect(await mockPrisma.integrationOutbox.findUniqueOrThrow({ where: { id: outboxId } })).toEqual(before);
});

it("rejects suspended ownership with no leg/tracking/receipt mutation", async () => {
  await mockPrisma.tenant.update({ where: { id: ids.tenants.transAsia }, data: { status: "suspended" } });
  const before = await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: legId } });
  try {
    await expect(applyCarrierIntegrationEvent({ id: eventId } as any)).rejects.toMatchObject({ statusCode: 403 });
    expect(await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: legId } })).toEqual(before);
    expect(await mockPrisma.tracking.count({ where: { orderLegId: legId } })).toBe(0);
    expect((await mockPrisma.integrationCanonicalEvent.findUniqueOrThrow({ where: { id: eventId } })).status).toBe("processing");
  } finally { await mockPrisma.tenant.update({ where: { id: ids.tenants.transAsia }, data: { status: "active" } }); }
});

it("serializes duplicate canonical application and commits one tracking row with its receipt", async () => {
  await Promise.all([applyCarrierIntegrationEvent({ id: eventId } as any), applyCarrierIntegrationEvent({ id: eventId } as any)]);
  expect((await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: legId } })).status).toBe("in_transit");
  expect(await mockPrisma.tracking.count({ where: { orderLegId: legId } })).toBe(1);
  expect((await mockPrisma.integrationCanonicalEvent.findUniqueOrThrow({ where: { id: eventId } })).status).toBe("processed");
});

it("allows only one durable mutating dispatch admission under concurrent attempts", async () => {
  const results = await Promise.all([1, 2].map(() => mockPrisma.integrationOutbox.updateMany({
    where: { id: outboxId, executionStartedAt: null }, data: { executionStartedAt: new Date() },
  })));
  expect(results.map(row => row.count).sort()).toEqual([0, 1]);
});
