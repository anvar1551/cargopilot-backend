jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => {
  const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value;
} }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { listIntegrationOutboxForActor as outboxes, listIntegrationOutboxAttemptsForActor as attempts,
  listIntegrationWebhookEventsForActor as webhooks, listIntegrationCanonicalEventsForActor as events } from "../../src/modules/integrations-core/application/integration-admin.service";
const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable run required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${run}`)
  throw Error("Refusing existing database");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000 -c lock_timeout=2000" });
let mockPrisma: PrismaClient;
const fixture = createTenantDemoFixture();
const memberships = fixture.companyMemberships.filter(m => m.userId === ids.users.multiTenant);
const providers: any[] = [], sources: any[] = [];
const actor = (m: any): any => ({ id: m.userId, companyId: m.companyId, tenantId: m.tenantId, membershipId: m.id,
  companyMembershipId: m.id, tenantMembershipId: m.tenantMembershipId });
async function snapshot() {
  return { outbox: await mockPrisma.integrationOutbox.findMany({ orderBy: { id: "asc" } }),
    webhook: await mockPrisma.integrationWebhookEvent.findMany({ orderBy: { id: "asc" } }),
    canonical: await mockPrisma.integrationCanonicalEvent.findMany({ orderBy: { id: "asc" } }),
    attempts: await mockPrisma.integrationDeliveryAttempt.count(), finance: await mockPrisma.financeDomainEventOutbox.count(), audit: await mockPrisma.financeAuditEvent.count() };
}
async function makeSource(p: any, overrides: any = {}) {
  const outbox = await mockPrisma.integrationOutbox.create({ data: { companyId: p.companyId, providerId: p.id,
    domain: p.domain, providerCode: p.providerCode, environment: p.environment, eventType: "synthetic", payload: { canary: "SENSITIVE-CANARY" },
    idempotencyKey: randomUUID(), ...overrides } });
  const webhook = await mockPrisma.integrationWebhookEvent.create({ data: { companyId: p.companyId, providerId: p.id,
    domain: p.domain, providerCode: p.providerCode, environment: p.environment, providerEventId: randomUUID(),
    signatureVerified: true, rawBody: "SENSITIVE-CANARY", rawBodySha256: "a".repeat(64) } });
  for (const source of ["inbound_webhook", "outbound_response"] as const) await mockPrisma.integrationCanonicalEvent.create({ data: {
    source, companyId: p.companyId, providerId: p.id, domain: p.domain, providerCode: p.providerCode, eventType: "synthetic",
    occurredAt: new Date(), payloadJson: { canary: "SENSITIVE-CANARY" },
    ...(source === "inbound_webhook" ? { webhookEventId: webhook.id } : { outboxId: outbox.id }) } });
  await mockPrisma.integrationDeliveryAttempt.create({ data: { outboxId: outbox.id, attemptNo: 1, outcome: "success",
    startedAt: new Date(), finishedAt: new Date(), requestJson: { canary: "SENSITIVE-CANARY" }, responseJson: { canary: "SENSITIVE-CANARY" } } });
  return { outbox, webhook };
}
beforeAll(async () => {
  const marker = (await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if (marker.length !== 1 || marker[0].runId !== run) throw Error("Disposable ownership mismatch");
  const client = await pool.connect(); try { await client.query("BEGIN"); await persistTenantDemoFixture(client, fixture); await client.query("COMMIT"); }
  finally { await client.query("ROLLBACK"); client.release(); }
  mockPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4, connectionTimeoutMillis: 3000,
    options: "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000" }) });
  const permission = await mockPrisma.permission.create({ data: { key: "integration.outbox.read", resource: "synthetic-integration", action: "read" } });
  expect(memberships).toHaveLength(3);
  for (const m of memberships) {
    const role = await mockPrisma.role.create({ data: { companyId: m.companyId, code: randomUUID(), name: "Synthetic integration reader" } });
    await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await mockPrisma.membershipRole.create({ data: { membershipId: m.id, roleId: role.id } });
    await mockPrisma.membershipScope.create({ data: { membershipId: m.id, scopeType: "company", scopeRefId: m.companyId } });
    const p = await mockPrisma.integrationProvider.create({ data: { companyId: m.companyId, domain: "carrier", providerCode: "sandbox", environment: "sandbox" } });
    providers.push(p); sources.push(await makeSource(p));
  }
});
afterAll(async () => { await mockPrisma?.$disconnect(); await pool.end(); });
it("actual selected-context queries isolate three companies across two tenants, preserve safe metadata and counts", async () => {
  const before = await snapshot();
  for (let i = 0; i < memberships.length; i++) {
    const user = actor(memberships[i]);
    const results = [await outboxes({ user }), await webhooks({ user }), await events({ user })];
    expect(results.map(r => r.total)).toEqual([1, 1, 2]);
    for (const r of results) expect(r.items.every(item => item.companyId === user.companyId)).toBe(true);
    const details = await attempts({ user, outboxId: sources[i].outbox.id }); expect(details).toHaveLength(1);
    expect(JSON.stringify([results, details])).not.toContain("SENSITIVE-CANARY");
  }
  expect(await snapshot()).toEqual(before);
});
it("foreign and same-tenant other-company attempt IDs deny without mutations", async () => {
  const before = await snapshot(); for (const s of sources.slice(1))
    await expect(attempts({ user: actor(memberships[0]), outboxId: s.outbox.id })).rejects.toMatchObject({ statusCode: 404 });
  expect(await snapshot()).toEqual(before);
});
it("provider company/domain/code/environment conflicts accepted by simple legacy references are hidden", async () => {
  const p = providers[0], user = actor(memberships[0]);
  const baseline = await outboxes({ user });
  for (const override of [{ providerId: providers[1].id }, { domain: "sms" }, { providerCode: "wrong" }, { environment: "production" }])
    await mockPrisma.integrationOutbox.create({ data: { companyId: p.companyId, providerId: p.id, domain: p.domain,
      providerCode: p.providerCode, environment: p.environment, eventType: "synthetic", payload: {}, idempotencyKey: randomUUID(), ...override as any } });
  const before = await snapshot(); expect((await outboxes({ user })).total).toBe(baseline.total); expect(await snapshot()).toEqual(before);
});
it("canonical unbound/conflicting/dual sources and unauthenticated webhook sources are not counted", async () => {
  const p = providers[0], user = actor(memberships[0]), base = await events({ user });
  const data = { companyId: p.companyId, providerId: p.id, domain: p.domain, providerCode: p.providerCode,
    eventType: "synthetic", occurredAt: new Date(), payloadJson: {} };
  await mockPrisma.integrationCanonicalEvent.create({ data: { ...data, source: "outbound_response" } });
  const foreign = await makeSource(providers[1]);
  await mockPrisma.integrationCanonicalEvent.deleteMany({ where: { outboxId: foreign.outbox.id } });
  await mockPrisma.integrationCanonicalEvent.create({ data: { ...data, source: "outbound_response", outboxId: foreign.outbox.id } });
  const own = await makeSource(p); await mockPrisma.integrationCanonicalEvent.deleteMany({ where: { OR: [{ outboxId: own.outbox.id }, { webhookEventId: own.webhook.id }] } });
  await mockPrisma.integrationCanonicalEvent.create({ data: { ...data, source: "inbound_webhook", webhookEventId: own.webhook.id, outboxId: own.outbox.id } });
  const unsigned = await makeSource(p); await mockPrisma.integrationWebhookEvent.update({ where: { id: unsigned.webhook.id }, data: { signatureVerified: false } });
  const before = await snapshot();
  // The newly created legitimate outbound source for the unsigned ingress is still independent and readable.
  expect((await events({ user })).total).toBe(base.total + 1); expect(await snapshot()).toEqual(before);
});
it("populated order bridge is preserved at read; foreign owner references and partial bridges are rejected by current constraints", async () => {
  const p = providers[0], m = memberships[0], user = actor(m);
  const order = fixture.orders.find(o => o.ownerOrgId === m.companyId)!;
  const own = await mockPrisma.integrationOutbox.create({ data: { companyId: p.companyId, providerId: p.id, domain: p.domain,
    providerCode: p.providerCode, environment: p.environment, eventType: "synthetic", payload: {}, idempotencyKey: randomUUID(),
    ownershipTenantId: m.tenantId, ownershipOrderId: order.id, acceptedAt: new Date(), operation: "track" } });
  expect((await outboxes({ user })).items.some(r => r.id === own.id)).toBe(true);
  const before = await snapshot();
  await expect(mockPrisma.integrationOutbox.update({ where: { id: own.id }, data: { ownershipTenantId: fixture.tenants.find(t => t.id !== m.tenantId)!.id } })).rejects.toThrow();
  await expect(mockPrisma.integrationOutbox.update({ where: { id: own.id }, data: { ownershipOrderId: null } })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
it("fresh suspended context and removed scopes fail before protected metadata reads without writes", async () => {
  const m = memberships[0], user = actor(m);
  await mockPrisma.tenant.update({ where: { id: m.tenantId }, data: { status: "suspended" } });
  try { const before = await snapshot(); for (const read of [outboxes, webhooks, events]) await expect(read({ user })).rejects.toMatchObject({ statusCode: 403 }); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.tenant.update({ where: { id: m.tenantId }, data: { status: "active" } }); }
  const scopes = await mockPrisma.membershipScope.findMany({ where: { membershipId: m.id } }); await mockPrisma.membershipScope.deleteMany({ where: { membershipId: m.id } });
  try { const before = await snapshot(); await expect(events({ user })).rejects.toMatchObject({ statusCode: 403 }); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.membershipScope.createMany({ data: scopes }); }
});
it("new NOT VALID source foreign key protects inserts/updates and rolls back related work, without certifying historical rows", async () => {
  const catalog = await pool.query("SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='IntegrationCanonicalEvent_outbox_source_fkey'");
  expect(catalog.rows).toHaveLength(1); expect(catalog.rows[0].convalidated).toBe(false); expect(catalog.rows[0].definition).toMatch(/FOREIGN KEY \("outboxId"\).*REFERENCES "IntegrationOutbox"\(id\).*ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID/);
  const before = await snapshot();
  await expect(mockPrisma.$transaction(async tx => {
    await tx.integrationWebhookEvent.update({ where: { id: sources[0].webhook.id }, data: { rawBodySha256: "b".repeat(64) } });
    await tx.integrationCanonicalEvent.create({ data: { source: "outbound_response", companyId: providers[0].companyId,
      domain: "carrier", providerCode: "sandbox", eventType: "synthetic", occurredAt: new Date(), payloadJson: {}, outboxId: randomUUID() } });
  })).rejects.toThrow();
  const existing = await mockPrisma.integrationCanonicalEvent.findFirstOrThrow({ where: { outboxId: sources[0].outbox.id } });
  await expect(mockPrisma.integrationCanonicalEvent.update({ where: { id: existing.id }, data: { outboxId: randomUUID() } })).rejects.toThrow();
  await expect(mockPrisma.integrationOutbox.delete({ where: { id: sources[0].outbox.id } })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
