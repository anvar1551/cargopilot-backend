jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => (mockPrisma as any)[name] }) }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createCarrierFailureSupportTicket: jest.fn() }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { applyCarrierIntegrationEvent } from "../../src/modules/orders-legs/carrier-events";
import { createHash, randomUUID } from "crypto";
import { createCarrierFailureSupportTicket } from "../../src/modules/support-core/application/autoTriage";

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

describe("inbound webhook PostgreSQL binding", () => {
  const inboundProvider = "019b3000-0000-7000-8b00-000000000011";
  const inboundLeg = "019b3000-0000-7000-8b00-000000000012";
  const inboundBooking = "019b3000-0000-7000-8b00-000000000013";
  beforeAll(async () => {
    await mockPrisma.integrationProvider.create({ data: { id: inboundProvider, companyId: ids.organizations.transAsiaUz, domain: "carrier", providerCode: "fake_carrier", environment: "sandbox" } });
    await mockPrisma.orderLeg.create({ data: { id: inboundLeg, orderId: ids.orders.transAsiaUz, sequence: 2, mode: "road", status: "booked", carrierProviderId: inboundProvider, carrierCode: "fake_carrier", carrierRef: "synthetic-inbound-booking", carrierBookingStatus: "booked" } });
    await mockPrisma.integrationOutbox.create({ data: { id: inboundBooking, companyId: ids.organizations.transAsiaUz, providerId: inboundProvider,
      domain: "carrier", providerCode: "fake_carrier", environment: "sandbox", operation: "create_shipment", eventType: "shipment.assigned",
      aggregateType: "shipment", aggregateId: inboundLeg, ownershipTenantId: ids.tenants.transAsia, ownershipOrderId: ids.orders.transAsiaUz,
      acceptedAt: new Date(), status: "sent", attemptCount: 1, executionStartedAt: new Date(), idempotencyKey: `synthetic-inbound:${runId}`,
      payload: { companyId: ids.organizations.transAsiaUz, aggregateType: "shipment", aggregateId: inboundLeg, payload: { action: "create_shipment", input: { metadata: { orderId: ids.orders.transAsiaUz, orderLegId: inboundLeg } } } },
    } });
    await mockPrisma.integrationDeliveryAttempt.create({ data: { outboxId: inboundBooking, attemptNo: 1, outcome: "success", startedAt: new Date(), finishedAt: new Date(), responseJson: { partnerShipmentId: "synthetic-inbound-booking" } } });
  });
  async function acceptedEvent(overrides: Record<string, unknown> = {}) {
    const rawId = randomUUID(), canonicalId = randomUUID();
    const payload = { eventId: randomUUID(), eventType: "carrier.status.updated", partnerShipmentId: "synthetic-inbound-booking", statusCode: "in_transit", ...overrides };
    const rawBody = JSON.stringify(payload), occurredAt = new Date();
    // Persistence/application evidence only: ingress HMAC is exercised in the unit suite.
    await mockPrisma.integrationWebhookEvent.create({ data: { id: rawId, providerId: inboundProvider, companyId: ids.organizations.transAsiaUz, domain: "carrier", providerCode: "fake_carrier", environment: "sandbox", providerEventId: payload.eventId, rawBody, rawBodySha256: createHash("sha256").update(rawBody).digest("hex"), signatureVerified: true, headersJson: {} } });
    await mockPrisma.integrationWebhookCanonicalEvent.create({ data: { webhookEventId: rawId, providerCode: "fake_carrier", domain: "carrier", eventType: "carrier.status.updated", companyId: ids.organizations.transAsiaUz, occurredAt, payloadJson: payload } });
    await mockPrisma.integrationCanonicalEvent.create({ data: { id: canonicalId, source: "inbound_webhook", status: "processing", providerId: inboundProvider, companyId: ids.organizations.transAsiaUz, webhookEventId: rawId, domain: "carrier", providerCode: "fake_carrier", eventType: "carrier.status.updated", occurredAt, payloadJson: payload } });
    return canonicalId;
  }
  it("inbound concurrent duplicate application commits one tracking row and one receipt", async () => {
    const id = await acceptedEvent();
    await Promise.all([applyCarrierIntegrationEvent({ id } as any), applyCarrierIntegrationEvent({ id } as any)]);
    expect(await mockPrisma.tracking.count({ where: { orderLegId: inboundLeg } })).toBe(1);
    expect((await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: inboundLeg } })).status).toBe("in_transit");
    expect((await mockPrisma.integrationCanonicalEvent.findUniqueOrThrow({ where: { id } })).status).toBe("processed");
  });
  it("inbound foreign company and child claims leave business records and outboxes unchanged", async () => {
    const before = await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: inboundLeg } });
    const count = await mockPrisma.tracking.count({ where: { orderLegId: inboundLeg } });
    const outboxes = await mockPrisma.integrationOutbox.count();
    for (const claims of [{ companyId: ids.organizations.transAsiaDe }, { tenantId: ids.tenants.unrelated }, { orderLegId: legId }]) {
      const id = await acceptedEvent(claims);
      await expect(applyCarrierIntegrationEvent({ id } as any)).rejects.toMatchObject({ statusCode: 403 });
      expect((await mockPrisma.integrationCanonicalEvent.findUniqueOrThrow({ where: { id } })).status).toBe("processing");
    }
    expect(await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: inboundLeg } })).toEqual(before);
    expect(await mockPrisma.tracking.count({ where: { orderLegId: inboundLeg } })).toBe(count);
    expect(await mockPrisma.integrationOutbox.count()).toBe(outboxes);
  });
  it("inbound receipt failure rolls back leg/tracking mutations and does not launch a ticket", async () => {
    const id = await acceptedEvent({ statusCode: "failed" });
    const before = await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: inboundLeg } });
    const count = await mockPrisma.tracking.count({ where: { orderLegId: inboundLeg } });
    await pool.query(`CREATE FUNCTION cp_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."id" = '${id}'::uuid THEN RAISE EXCEPTION 'Synthetic receipt rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER cp_reject_receipt BEFORE UPDATE ON "IntegrationCanonicalEvent" FOR EACH ROW EXECUTE FUNCTION cp_reject_receipt();`);
    try {
      await expect(applyCarrierIntegrationEvent({ id } as any)).rejects.toThrow();
      expect(await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: inboundLeg } })).toEqual(before);
      expect(await mockPrisma.tracking.count({ where: { orderLegId: inboundLeg } })).toBe(count);
      expect((await mockPrisma.integrationCanonicalEvent.findUniqueOrThrow({ where: { id } })).status).toBe("processing");
      expect(createCarrierFailureSupportTicket).not.toHaveBeenCalled();
    } finally { await pool.query('DROP TRIGGER cp_reject_receipt ON "IntegrationCanonicalEvent"; DROP FUNCTION cp_reject_receipt();'); }
  });
  it("inbound terminal regression is rejected without changing the terminal record", async () => {
    await mockPrisma.orderLeg.update({ where: { id: inboundLeg }, data: { status: "completed" } });
    const before = await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: inboundLeg } });
    const count = await mockPrisma.tracking.count({ where: { orderLegId: inboundLeg } });
    const id = await acceptedEvent();
    await expect(applyCarrierIntegrationEvent({ id } as any)).rejects.toMatchObject({ statusCode: 409 });
    expect(await mockPrisma.orderLeg.findUniqueOrThrow({ where: { id: inboundLeg } })).toEqual(before);
    expect(await mockPrisma.tracking.count({ where: { orderLegId: inboundLeg } })).toBe(count);
  });
});
