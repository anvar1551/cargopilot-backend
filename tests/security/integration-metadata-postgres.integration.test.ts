jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => {
  const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value;
} }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { integrationCanonicalEventRepository as canonicalRepo } from "../../src/modules/integrations-core/infrastructure/canonical-event.repo";
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
it("populated provider company/domain/code/environment conflicts reject inserts and updates without writes", async () => {
  const p = providers[0], user = actor(memberships[0]);
  const baseline = await outboxes({ user });
  const before = await snapshot();
  for (const override of [{ providerId: providers[1].id }, { domain: "sms" }, { providerCode: "wrong" }, { environment: "production" }]) {
    await expect(mockPrisma.integrationOutbox.create({ data: { companyId: p.companyId, providerId: p.id, domain: p.domain,
      providerCode: p.providerCode, environment: p.environment, eventType: "synthetic", payload: {}, idempotencyKey: randomUUID(), ...override as any } })).rejects.toThrow();
    await expect(mockPrisma.integrationOutbox.update({ where: { id: sources[0].outbox.id }, data: override as any })).rejects.toThrow();
    await expect(mockPrisma.integrationWebhookEvent.update({ where: { id: sources[0].webhook.id }, data: override as any })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
  expect((await outboxes({ user })).total).toBe(baseline.total);
});
it("canonical unbound/conflicting/dual sources and unauthenticated webhook sources are not counted", async () => {
  const p = providers[0], user = actor(memberships[0]), base = await events({ user });
  const data = { companyId: p.companyId, providerId: p.id, domain: p.domain, providerCode: p.providerCode,
    eventType: "synthetic", occurredAt: new Date(), payloadJson: {} };
  await expect(mockPrisma.integrationCanonicalEvent.create({ data: { ...data, source: "outbound_response" } })).rejects.toThrow();
  const foreign = await makeSource(providers[1]);
  await mockPrisma.integrationCanonicalEvent.deleteMany({ where: { outboxId: foreign.outbox.id } });
  let before = await snapshot();
  await expect(mockPrisma.integrationCanonicalEvent.create({ data: { ...data, source: "outbound_response", outboxId: foreign.outbox.id } })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const own = await makeSource(p); await mockPrisma.integrationCanonicalEvent.deleteMany({ where: { OR: [{ outboxId: own.outbox.id }, { webhookEventId: own.webhook.id }] } });
  before = await snapshot();
  await expect(mockPrisma.integrationCanonicalEvent.create({ data: { ...data, source: "inbound_webhook", webhookEventId: own.webhook.id, outboxId: own.outbox.id } })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const unsigned = await makeSource(p); await mockPrisma.integrationWebhookEvent.update({ where: { id: unsigned.webhook.id }, data: { signatureVerified: false } });
  before = await snapshot();
  // The newly created legitimate outbound source for the unsigned ingress is still independent and readable.
  expect((await events({ user })).total).toBe(base.total + 1); expect(await snapshot()).toEqual(before);
});

async function incoming(p = providers[0]) {
  const occurredAt = new Date(), payload = { eventType: "carrier.status.updated", statusCode: "in_transit" }, rawBody = JSON.stringify(payload);
  const raw = await mockPrisma.integrationWebhookEvent.create({ data: { companyId: p.companyId, providerId: p.id, domain: "carrier", providerCode: p.providerCode,
    environment: p.environment, providerEventId: randomUUID(), signatureVerified: true, rawBody, rawBodySha256: createHash("sha256").update(rawBody).digest("hex") } });
  await mockPrisma.integrationWebhookCanonicalEvent.create({ data: { webhookEventId: raw.id, companyId: p.companyId, domain: "carrier", providerCode: p.providerCode,
    eventType: "carrier.status.updated", occurredAt, payloadJson: payload } });
  const input: any = { source: "inbound_webhook", webhookEventId: raw.id, companyId: p.companyId, providerId: p.id, domain: "carrier",
    providerCode: p.providerCode, eventType: "carrier.status.updated", occurredAt: occurredAt.toISOString(), payloadJson: payload };
  return { raw, input };
}
it("actual canonical enqueue concurrently deduplicates the verified source and rejects changed context/content with no effects", async () => {
  const { input } = await incoming();
  const results = await Promise.all([canonicalRepo.enqueue(input), canonicalRepo.enqueue(input)]);
  expect(results[0].id).toBe(results[1].id); expect(await mockPrisma.integrationCanonicalEvent.count({ where: { webhookEventId: input.webhookEventId } })).toBe(1);
  const before = await snapshot();
  for (const change of [{ companyId: providers[1].companyId }, { providerId: providers[1].id }, { payloadJson: { forged: true } },
    { eventType: "carrier.shipment.created" }, { occurredAt: new Date(0).toISOString() }, { outboxId: sources[0].outbox.id }]) {
    await expect(canonicalRepo.enqueue({ ...input, ...change })).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  }
  await mockPrisma.tenant.update({ where: { id: memberships[0].tenantId }, data: { status: "suspended" } });
  try { const paused = await snapshot(); await expect(canonicalRepo.enqueue(input)).rejects.toThrow(); expect(await snapshot()).toEqual(paused); }
  finally { await mockPrisma.tenant.update({ where: { id: memberships[0].tenantId }, data: { status: "active" } }); }
});
it("authoritative completed carrier attempt derives output; unaccepted source and forged output remain contained", async () => {
  const p = providers[0], m = memberships[0], order = fixture.orders.find(o => o.ownerOrgId === m.companyId)!;
  const leg = await mockPrisma.orderLeg.create({ data: { orderId: order.id, sequence: 100, mode: "road", carrierProviderId: p.id, carrierCode: p.providerCode, carrierRef: "synthetic-ref" } });
  const outbox = await mockPrisma.integrationOutbox.create({ data: { companyId: p.companyId, providerId: p.id, domain: "carrier", providerCode: p.providerCode,
    environment: p.environment, operation: "track", eventType: "carrier.command.requested", aggregateType: "shipment", aggregateId: leg.id,
    ownershipTenantId: m.tenantId, ownershipOrderId: order.id, acceptedAt: new Date(), status: "sent", attemptCount: 1, idempotencyKey: randomUUID(),
    payload: { companyId: p.companyId, aggregateType: "shipment", aggregateId: leg.id, payload: { action: "track", input: { partnerShipmentId: "synthetic-ref", metadata: { orderId: order.id, orderLegId: leg.id } } } } } });
  const finishedAt = new Date();
  await mockPrisma.integrationDeliveryAttempt.create({ data: { outboxId: outbox.id, attemptNo: 1, outcome: "success", startedAt: finishedAt, finishedAt, statusCode: 200, responseJson: { statusCode: "in_transit" } } });
  const input: any = { source: "outbound_response", outboxId: outbox.id, companyId: p.companyId, providerId: p.id, domain: "carrier", providerCode: p.providerCode,
    eventType: "carrier.status.updated", aggregateType: "shipment", aggregateId: leg.id, occurredAt: finishedAt.toISOString(),
    payloadJson: { statusCode: "in_transit", providerRequestId: null, providerHttpStatusCode: 200 } };
  const results = await Promise.all([canonicalRepo.enqueue(input), canonicalRepo.enqueue(input)]); expect(results[0].id).toBe(results[1].id);
  const before = await snapshot();
  await expect(canonicalRepo.enqueue({ ...input, payloadJson: { ...input.payloadJson, statusCode: "delivered" } })).rejects.toThrow();
  await expect(canonicalRepo.enqueue({ ...input, outboxId: sources[0].outbox.id })).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it("source identity collisions cannot return a different provider/company receipt", async () => {
  const left = await incoming(), right = await incoming(providers[1]);
  const common = { aggregateType: "synthetic", aggregateId: randomUUID(), occurredAt: new Date("2026-10-03T01:00:00Z") };
  for (const v of [left, right]) {
    await mockPrisma.integrationWebhookCanonicalEvent.update({ where: { webhookEventId: v.raw.id }, data: common });
    Object.assign(v.input, common, { occurredAt: common.occurredAt.toISOString() });
  }
  const confirmed = await canonicalRepo.enqueue(left.input), before = await snapshot();
  await expect(canonicalRepo.enqueue(right.input)).rejects.toMatchObject({ statusCode: 409, code: "INTEGRATION_CANONICAL_ID_CONFLICT" });
  expect(await snapshot()).toEqual(before); expect(await mockPrisma.integrationCanonicalEvent.count({ where: { id: confirmed.id } })).toBe(1);
});
it("injected enqueue failure rolls back its metadata receipt without resetting sources or adding business effects", async () => {
  const v = await incoming(), before = await snapshot(), original = mockPrisma;
  mockPrisma = new Proxy(original, { get(target, key) {
    if (key === "$transaction") return (work: any, options: any) => target.$transaction(async tx => {
      await work(tx); throw Error("synthetic-enqueue-rollback");
    }, options);
    const value = (target as any)[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  try { await expect(canonicalRepo.enqueue(v.input)).rejects.toThrow("synthetic-enqueue-rollback"); }
  finally { mockPrisma = original; }
  expect(await snapshot()).toEqual(before); await expect(canonicalRepo.enqueue(v.input)).resolves.toMatchObject({ webhookEventId: v.raw.id });
});
it("structurally unaccepted legacy event seeded before expansion stays unclaimed and cannot starve valid work", async () => {
  const legacy = await mockPrisma.integrationCanonicalEvent.findFirstOrThrow({ where: { providerCode: `legacy-${run}` } });
  const before = await snapshot();
  const claimed = await canonicalRepo.claimBatch({ limit: 200 });
  expect(claimed.some(r => r.id === legacy.id)).toBe(false);
  expect(await mockPrisma.integrationCanonicalEvent.findUnique({ where: { id: legacy.id } })).toEqual(legacy);
  expect(claimed.length).toBeGreaterThan(0);
  // Claiming changes only leases on eligible metadata; no finance or business events are dispatched here.
  expect(await mockPrisma.financeDomainEventOutbox.count()).toBe(before.finance); expect(await mockPrisma.financeAuditEvent.count()).toBe(before.audit);
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
