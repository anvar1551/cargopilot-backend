import {publishRouteTemplateConfigurationForActor as publishTemplateConfiguration} from "../../src/modules/integrations-core/application/template-configuration-publication";
import {listIntegrationProviderConfigurationsForActor as readConfigurations} from "../../src/modules/integrations-core/application/provider-configuration-read";
import {publishIntegrationProviderConfigurationForActor as publishConfiguration} from "../../src/modules/integrations-core/application/provider-configuration-publication";
import {listCarrierRoutingRulesForActor as routingInventory,resolveCarrierRoutingRuleForOrderLeg as routingSelector} from "../../src/modules/integrations-core/application/carrier-routing.service";
import {listRouteTemplatesForActor as templateInventory,getRouteTemplateForActor as templateDetail} from "../../src/modules/integrations-core/application/route-template.service";
import {seedInitialServiceChargePricing as pricingSeed,listPricingComponents as componentList,createPricingComponent as manualPricing} from "../../src/modules/orders-legs/pricing";
jest.mock("../../src/modules/integrations-core/application/webhook-database", () => ({ getIntegrationWebhookDatabase: () => new Proxy({}, { get: (_target, name) => { const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => {
  const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value;
} }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
const { createIntegrationWebhookDatabase, integrationWebhookDatabaseLimits } = jest.requireActual<typeof import("../../src/modules/integrations-core/application/webhook-database")>("../../src/modules/integrations-core/application/webhook-database");
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { integrationCanonicalEventRepository as canonicalRepo } from "../../src/modules/integrations-core/infrastructure/canonical-event.repo";
import { webhookEventRepository as ingressRepo } from "../../src/modules/integrations-core/infrastructure/webhook-events.repo";
import { createWebhookGatewayService } from "../../src/modules/integrations-core/application/webhook-gateway.service";
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
    normalized: await mockPrisma.integrationWebhookCanonicalEvent.findMany({ orderBy: { id: "asc" } }),
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
  const routingPermission=await mockPrisma.permission.create({data:{key:"integration.routing.read",resource:"synthetic-routing",action:"read"}});
  const bookingPermission=await mockPrisma.permission.create({data:{key:"shipment.bookCarrier",resource:"synthetic-carrier",action:"book"}});
  const seedPermission=await mockPrisma.permission.create({data:{key:"shipment.create",resource:"synthetic-seed",action:"create"}});
  const componentPermission=await mockPrisma.permission.create({data:{key:"shipment.view",resource:"synthetic-seed",action:"view"}});
  const mutationPermission=await mockPrisma.permission.create({data:{key:"shipment.update",resource:"synthetic-seed",action:"update"}});
  const permission = await mockPrisma.permission.create({ data: { key: "integration.outbox.read", resource: "synthetic-integration", action: "read" } });
  expect(memberships).toHaveLength(3);
  for (const m of memberships) {
    const role = await mockPrisma.role.create({ data: { companyId: m.companyId, code: randomUUID(), name: "Synthetic integration reader" } });
    await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: routingPermission.id } });
    await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: bookingPermission.id } });
    for(const permissionId of [seedPermission.id,componentPermission.id,mutationPermission.id]) await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId}});
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
it("ingress duplicate receipt requires all bound durable records and rejects conflicting signed content", async () => {
  const v = await incoming(), p = providers[0];
  const identity = { providerId: p.id, providerEventId: v.raw.providerEventId, companyId: p.companyId, domain: p.domain,
    providerCode: p.providerCode, environment: p.environment, rawBodySha256: v.raw.rawBodySha256 };
  let before = await snapshot();
  await expect(ingressRepo.hasProcessed(identity)).rejects.toMatchObject({ statusCode: 503, code: "WEBHOOK_INGRESS_INCOMPLETE" });
  expect(await snapshot()).toEqual(before);
  await mockPrisma.integrationWebhookCanonicalEvent.delete({ where: { webhookEventId: v.raw.id } }); before = await snapshot();
  await expect(ingressRepo.hasProcessed(identity)).rejects.toMatchObject({ statusCode: 503 }); expect(await snapshot()).toEqual(before);
  await mockPrisma.integrationWebhookCanonicalEvent.create({ data: { webhookEventId: v.raw.id, providerCode: p.providerCode, domain: p.domain,
    eventType: v.input.eventType, occurredAt: new Date(v.input.occurredAt), payloadJson: v.input.payloadJson, companyId: p.companyId } });
  await canonicalRepo.enqueue(v.input); before = await snapshot();
  await expect(ingressRepo.hasProcessed(identity)).resolves.toBe(true);
  await expect(ingressRepo.hasProcessed({ ...identity, rawBodySha256: "c".repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
  await expect(ingressRepo.hasProcessed({ ...identity, companyId: providers[1].companyId })).rejects.toMatchObject({ statusCode: 409 });
  expect(await snapshot()).toEqual(before);
});
function atomicGateway(p: any, eventId: string, events: any = ingressRepo, occurredAt?: string) {
  const rawBody = JSON.stringify({ eventId, eventType: "unclassified.event", ...(occurredAt ? { occurredAt } : {}) });
  const service = createWebhookGatewayService({ events, providerVerifiers: { resolve: async () => ({ providerId: p.id,
    companyId: p.companyId, providerCode: p.providerCode, domain: p.domain, environment: p.environment, verifier: { verifyAndNormalize: async () => ({ ok: true,
      data: { providerCode: p.providerCode, eventId, eventType: "unclassified.event", occurredAt: occurredAt ?? new Date().toISOString(), payload: JSON.parse(rawBody) } }) } } as any) } });
  return { service, input: { providerCode: p.providerCode, rawBody, headers: {} } };
}
it("atomic ingress concurrent retries create one complete receipt and preserve first fallback time", async () => {
  const p = providers[0], eventId = randomUUID(), f = atomicGateway(p, eventId);
  const results = await Promise.all([f.service.ingest(f.input), f.service.ingest(f.input)]);
  expect(results.map(r => r.status).sort()).toEqual(["accepted", "duplicate"]);
  const raw = await mockPrisma.integrationWebhookEvent.findFirstOrThrow({ where: { providerId: p.id, providerEventId: eventId }, include: { canonicalEvent: true } });
  expect(raw.canonicalEvent?.domain).toBe(p.domain); expect(raw.processedAt).toBeNull();
  expect(await mockPrisma.integrationCanonicalEvent.count({ where: { webhookEventId: raw.id } })).toBe(1);
  const before = await snapshot(); await expect(f.service.ingest(f.input)).resolves.toMatchObject({ status: "duplicate" });
  expect(await snapshot()).toEqual(before);
});
it("atomic ingress injected failure after pending write rolls back raw normalized and pending state", async () => {
  const f = atomicGateway(providers[0], randomUUID()), before = await snapshot(), original = mockPrisma;
  mockPrisma = new Proxy(original, { get(target, key) {
    if (key === "$transaction") return (work: any, options: any) => target.$transaction(async tx => { await work(tx); throw Error("synthetic-ingress-rollback"); }, options);
    const value = (target as any)[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  try { await expect(f.service.ingest(f.input)).rejects.toThrow("synthetic-ingress-rollback"); } finally { mockPrisma = original; }
  expect(await snapshot()).toEqual(before); await expect(f.service.ingest(f.input)).resolves.toMatchObject({ status: "accepted" });
});
it("normalized compound context rejects foreign inserts updates and null ownership without effects", async () => {
  const v = await incoming(), before = await snapshot();
  for (const change of [{ companyId: providers[1].companyId }, { domain: "sms" }, { providerCode: "foreign" }, { companyId: null }]) {
    await expect(mockPrisma.integrationWebhookCanonicalEvent.update({ where: { webhookEventId: v.raw.id }, data: change as any })).rejects.toThrow();
    const raw = sources[0].webhook;
    await expect(mockPrisma.integrationWebhookCanonicalEvent.create({ data: { webhookEventId: raw.id, companyId: raw.companyId,
      domain: raw.domain, providerCode: raw.providerCode, eventType: "synthetic", occurredAt: new Date(), payloadJson: {}, ...change as any } })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
  const catalog = await pool.query("SELECT convalidated FROM pg_constraint WHERE conname IN ('IntegrationWebhookCanonicalEvent_context_fkey','IntegrationWebhookCanonicalEvent_context_complete_check')");
  expect(catalog.rows).toHaveLength(2); expect(catalog.rows.every(r => !r.convalidated)).toBe(true);
});
it("atomic ingress conflicting raw content inactive ownership and global identity collision have no writes", async () => {
  const p = providers[0], eventId = randomUUID(), f = atomicGateway(p, eventId);
  await f.service.ingest(f.input); let before = await snapshot();
  await expect(f.service.ingest({ ...f.input, rawBody: f.input.rawBody + " " })).rejects.toMatchObject({ statusCode: 409 }); expect(await snapshot()).toEqual(before);
  await mockPrisma.tenant.update({ where: { id: memberships[0].tenantId }, data: { status: "suspended" } });
  try { before = await snapshot(); await expect(f.service.ingest(f.input)).rejects.toMatchObject({ statusCode: 403 }); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.tenant.update({ where: { id: memberships[0].tenantId }, data: { status: "active" } }); }
  // Fixed source time and nonnull aggregate fields force the existing global natural key collision.
  const time = new Date().toISOString();
  const left = await incoming(p), right = await incoming(providers[1]);
  const common = { aggregateType: "synthetic", aggregateId: randomUUID(), occurredAt: new Date(time) };
  for (const v of [left,right]) { await mockPrisma.integrationWebhookCanonicalEvent.update({ where: { webhookEventId: v.raw.id }, data: common }); Object.assign(v.input,common,{occurredAt:time}); }
  await canonicalRepo.enqueue(left.input); before = await snapshot(); await expect(canonicalRepo.enqueue(right.input)).rejects.toMatchObject({statusCode:409}); expect(await snapshot()).toEqual(before);
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

it("webhook native pool statement timeout cancels work rolls back and recovers without active sleep", async () => {
  const resource = createIntegrationWebhookDatabase(url!);
  try {
    expect(resource.pool.options.max).toBe(integrationWebhookDatabaseLimits.max);
    const before = await snapshot();
    await expect(resource.db.$transaction(async tx => {
      await tx.integrationWebhookEvent.update({ where: { id: sources[0].webhook.id }, data: { processedAt: new Date() } });
      await tx.$queryRaw`SELECT 1 AS result FROM pg_sleep(4)`;
    }, { maxWait: 2000, timeout: 5000 })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const running = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE '%pg_sleep%'");
    expect(running.rows[0].count).toBe(0);
    await expect(resource.db.integrationProvider.count()).resolves.toBe(providers.length);
  } finally { await resource.close(); }
});
it("webhook native pool lock deadline releases the transaction and permits subsequent writes", async () => {
  const resource = createIntegrationWebhookDatabase(url!), holder = await pool.connect();
  try {
    await holder.query("BEGIN"); await holder.query('SELECT id FROM "IntegrationWebhookEvent" WHERE id=$1 FOR UPDATE',[sources[0].webhook.id]);
    const before = await snapshot();
    await expect(resource.db.integrationWebhookEvent.update({where:{id:sources[0].webhook.id},data:{processedAt:new Date()}})).rejects.toThrow();
    await holder.query("ROLLBACK"); expect(await snapshot()).toEqual(before);
    await expect(resource.db.integrationProvider.count()).resolves.toBe(providers.length);
  } finally { await holder.query("ROLLBACK"); holder.release(); await resource.close(); }
});

it("routing inventory PostgreSQL isolates selected companies and excludes foreign provider/template graphs from counts",async()=>{
 const own=await mockPrisma.carrierRoutingRule.create({data:{companyId:providers[0].companyId,providerId:providers[0].id,name:"Synthetic owned",conditionsJson:{private:"SENSITIVE-CANARY"}}});
 for(let i=1;i<providers.length;i++)await mockPrisma.carrierRoutingRule.create({data:{companyId:providers[i].companyId,providerId:providers[i].id,name:"Synthetic other"}});
 await expect(mockPrisma.carrierRoutingRule.create({data:{companyId:providers[0].companyId,providerId:providers[1].id,name:"Invalid primary"}})).rejects.toMatchObject({code:"P2003"});
 await expect(mockPrisma.carrierRoutingRule.create({data:{companyId:providers[0].companyId,providerId:providers[0].id,fallbackProviderId:providers[2].id,name:"Invalid fallback"}})).rejects.toMatchObject({code:"P2003"});
 const foreign=await mockPrisma.routeTemplate.create({data:{companyId:providers[2].companyId,name:"Synthetic foreign"}});
 await expect(mockPrisma.carrierRoutingRule.create({data:{companyId:providers[0].companyId,providerId:providers[0].id,routeTemplateId:foreign.id,name:"Invalid template"}})).rejects.toMatchObject({code:"P2003"});
 const before=await snapshot(),rules=await mockPrisma.carrierRoutingRule.findMany({orderBy:{id:"asc"}});
 for(let i=0;i<memberships.length;i++){const result:any=await routingInventory({user:actor(memberships[i]),filters:{limit:10}});expect(result.total).toBe(1);expect(result.data).toHaveLength(1);expect(result.data.every((r:any)=>r.companyId===memberships[i].companyId)).toBe(true);expect(JSON.stringify(result)).not.toContain("SENSITIVE-CANARY");}
 const cursor:any=await routingInventory({user:actor(memberships[0]),filters:{limit:1,cursor:own.id}});expect(cursor.data).toHaveLength(0);expect(cursor.total).toBe(1);
 await expect(routingInventory({user:actor(memberships[1]),filters:{limit:1,cursor:own.id}})).rejects.toMatchObject({statusCode:404});
 expect(await snapshot()).toEqual(before);expect(await mockPrisma.carrierRoutingRule.findMany({orderBy:{id:"asc"}})).toEqual(rules);
});
it("routing inventory PostgreSQL rejects mismatched template children from list/count and missing scope without writes",async()=>{
 const p=providers[0],template=await mockPrisma.routeTemplate.create({data:{companyId:p.companyId,name:"Synthetic template"}}),other=await mockPrisma.routeTemplate.create({data:{companyId:p.companyId,name:"Synthetic second"}});
 const leg=await mockPrisma.routeTemplateLeg.create({data:{routeTemplateId:other.id,sequence:1,legCode:"synthetic"}});
 await expect(mockPrisma.carrierRoutingRule.create({data:{companyId:p.companyId,providerId:p.id,name:"Wrong template child",routeTemplateId:template.id,routeTemplateLegId:leg.id}})).rejects.toMatchObject({code:"P2003"});
 const before=await snapshot(),rules=await mockPrisma.carrierRoutingRule.findMany({orderBy:{id:"asc"}});
 const result:any=await routingInventory({user:actor(memberships[0]),filters:{limit:10}});expect(result.total).toBe(1);expect(result.data.every((r:any)=>r.name!=="Wrong template child")).toBe(true);
 const scopes=await mockPrisma.membershipScope.findMany({where:{membershipId:memberships[0].id}});await mockPrisma.membershipScope.deleteMany({where:{membershipId:memberships[0].id}});
 try{await expect(routingInventory({user:actor(memberships[0])})).rejects.toMatchObject({statusCode:403});}finally{await mockPrisma.membershipScope.createMany({data:scopes});}
 expect(await snapshot()).toEqual(before);expect(await mockPrisma.carrierRoutingRule.findMany({orderBy:{id:"asc"}})).toEqual(rules);
});

async function routingSnapshot() {
  return { business: await snapshot(), rules: await mockPrisma.carrierRoutingRule.findMany({orderBy:{id:"asc"}}),
    templates: await mockPrisma.routeTemplate.findMany({orderBy:{id:"asc"}}),
    legs: await mockPrisma.routeTemplateLeg.findMany({orderBy:{id:"asc"}}) };
}
async function routingGraph(companyIndex = 0) {
  const p = providers[companyIndex];
  const template = await mockPrisma.routeTemplate.create({data:{companyId:p.companyId,name:"Synthetic compound template"}});
  const leg = await mockPrisma.routeTemplateLeg.create({data:{routeTemplateId:template.id,sequence:1,legCode:"synthetic"}});
  return {template,leg,p};
}
it("routing compound accepts optional and complete same-company graphs across separate legal entities",async()=>{
  expect(memberships[0].tenantId).toBe(memberships[1].tenantId);
  expect(memberships[0].tenantId).not.toBe(memberships[2].tenantId);
  for(let i=0;i<providers.length;i++) {
    const {p,template,leg}=await routingGraph(i);
    for(const refs of [{},{routeTemplateId:template.id},{routeTemplateId:template.id,routeTemplateLegId:leg.id,fallbackProviderId:p.id}]) {
      const rule=await mockPrisma.carrierRoutingRule.create({data:{companyId:p.companyId,providerId:p.id,name:"Synthetic valid",...refs}});
      await expect(mockPrisma.carrierRoutingRule.update({where:{id:rule.id},data:{priority:1}})).resolves.toMatchObject({priority:1});
    }
  }
});
it("routing compound rejects foreign company/tenant inserts and updates without business effects",async()=>{
  const own=await routingGraph(),foreign=[await routingGraph(1),await routingGraph(2)];
  const rule=await mockPrisma.carrierRoutingRule.create({data:{companyId:own.p.companyId,providerId:own.p.id,name:"Synthetic unchanged",routeTemplateId:own.template.id,routeTemplateLegId:own.leg.id}});
  const before=await routingSnapshot();
  for(const f of foreign) for(const change of [{providerId:f.p.id},{fallbackProviderId:f.p.id},{routeTemplateId:f.template.id},{routeTemplateLegId:f.leg.id},{companyId:f.p.companyId}]) {
    await expect(mockPrisma.carrierRoutingRule.create({data:{companyId:own.p.companyId,providerId:own.p.id,name:"Synthetic denied",routeTemplateId:own.template.id,routeTemplateLegId:own.leg.id,...change}})).rejects.toMatchObject({code:"P2003"});
    await expect(mockPrisma.carrierRoutingRule.update({where:{id:rule.id},data:change})).rejects.toMatchObject({code:"P2003"});
    expect(await routingSnapshot()).toEqual(before);
  }
});
it("routing compound rejects wrong same-company template child and partial template bridges",async()=>{
  const a=await routingGraph(),b=await routingGraph();
  await mockPrisma.routeTemplateLeg.update({where:{id:b.leg.id},data:{sequence:2,legCode:"other"}});
  const rule=await mockPrisma.carrierRoutingRule.create({data:{companyId:a.p.companyId,providerId:a.p.id,name:"Synthetic complete",routeTemplateId:a.template.id,routeTemplateLegId:a.leg.id}});
  const before=await routingSnapshot();
  for(const change of [{routeTemplateId:b.template.id,routeTemplateLegId:a.leg.id},{routeTemplateId:null,routeTemplateLegId:a.leg.id}]) {
    await expect(mockPrisma.carrierRoutingRule.create({data:{companyId:a.p.companyId,providerId:a.p.id,name:"Synthetic denied",...change}})).rejects.toThrow();
    await expect(mockPrisma.carrierRoutingRule.update({where:{id:rule.id},data:change})).rejects.toThrow();
    expect(await routingSnapshot()).toEqual(before);
  }
  await expect(mockPrisma.routeTemplateLeg.update({where:{id:a.leg.id},data:{routeTemplateId:b.template.id}})).rejects.toMatchObject({code:"P2003"});
  expect(await routingSnapshot()).toEqual(before);
});
it("routing compound transaction rejection rolls back preceding changes and leaves outbox/audit untouched",async()=>{
  const a=await routingGraph(),b=await routingGraph(1);
  const before=await routingSnapshot();
  await expect(mockPrisma.$transaction(async tx=>{
    await tx.routeTemplate.update({where:{id:a.template.id},data:{name:"Must roll back"}});
    await tx.carrierRoutingRule.create({data:{companyId:a.p.companyId,providerId:b.p.id,name:"Synthetic denied"}});
  },{maxWait:2000,timeout:5000})).rejects.toMatchObject({code:"P2003"});
  expect(await routingSnapshot()).toEqual(before);
});
it("routing compound concurrent leg reparent versus rule insertion cannot commit a mismatched graph",async()=>{
  const a=await routingGraph(),b=await routingGraph(),ruleId=randomUUID();
  await mockPrisma.routeTemplateLeg.update({where:{id:b.leg.id},data:{sequence:2,legCode:"other"}});
  const effects=await snapshot();
  const outcomes=await Promise.allSettled([
    mockPrisma.carrierRoutingRule.create({data:{id:ruleId,companyId:a.p.companyId,providerId:a.p.id,name:"Synthetic race",routeTemplateId:a.template.id,routeTemplateLegId:a.leg.id}}),
    mockPrisma.routeTemplateLeg.update({where:{id:a.leg.id},data:{routeTemplateId:b.template.id}})
  ]);
  expect(outcomes.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const failed=outcomes.find(r=>r.status==="rejected") as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({code:"P2003"});
  const rule=await mockPrisma.carrierRoutingRule.findUnique({where:{id:ruleId}}),leg=await mockPrisma.routeTemplateLeg.findUniqueOrThrow({where:{id:a.leg.id}});
  if(rule) expect(rule.routeTemplateId).toBe(leg.routeTemplateId);
  else expect(leg.routeTemplateId).toBe(b.template.id);
  expect(await snapshot()).toEqual(effects);
});
it("routing compound catalog preserves expansion status and reuses pre-existing parent targets",async()=>{
  const result=await pool.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ANY($1::text[])",[[
    "CarrierRoutingRule_provider_company_fkey","CarrierRoutingRule_fallback_company_fkey","CarrierRoutingRule_template_company_fkey","CarrierRoutingRule_template_leg_fkey","CarrierRoutingRule_template_complete_check"]]);
  expect(result.rows).toHaveLength(5);expect(result.rows.every(r=>!r.convalidated)).toBe(true);
  expect(result.rows.find(r=>r.conname==="CarrierRoutingRule_template_leg_fkey").definition).toMatch(/FOREIGN KEY \("routeTemplateId", "routeTemplateLegId"\).*REFERENCES "RouteTemplateLeg"\("routeTemplateId", id\)/);
  const targets=await pool.query("SELECT indexname FROM pg_indexes WHERE indexname=ANY($1::text[])",[["IntegrationProvider_id_companyId_key","RouteTemplate_company_identity_key","RouteTemplateLeg_template_identity_key"]]);
  expect(targets.rows).toHaveLength(3);
});

it("template scoped PostgreSQL list detail cursor and counts separate three selected companies without writes",async()=>{
  const templates=[];
  const query="Synthetic scoped template "+randomUUID();
  for(const p of providers) {
    const template=await mockPrisma.routeTemplate.create({data:{companyId:p.companyId,name:query,metadata:{private:"SENSITIVE-CANARY"}}});
    await mockPrisma.routeTemplateLeg.create({data:{routeTemplateId:template.id,sequence:1,legCode:"synthetic",metadata:{private:"SENSITIVE-CANARY"}}});templates.push(template);
  }
  const before=await routingSnapshot();
  for(let i=0;i<memberships.length;i++) {
    const user=actor(memberships[i]),result:any=await templateInventory({user,filters:{limit:1,q:query}});
    expect(result.total).toBe(1);expect(result.data.map((r:any)=>r.id)).toEqual([templates[i].id]);expect(JSON.stringify(result)).not.toContain("SENSITIVE-CANARY");
    const detail=await templateDetail({user,routeTemplateId:templates[i].id});expect(detail.legCount).toBe(1);expect(detail.metadata).toBeNull();expect(detail.legs![0].metadata).toBeNull();
    for(let j=0;j<templates.length;j++) if(j!==i) {
      await expect(templateDetail({user,routeTemplateId:templates[j].id})).rejects.toMatchObject({statusCode:404});
      await expect(templateInventory({user,filters:{limit:1,q:query,cursor:templates[j].id}})).rejects.toMatchObject({statusCode:404});
    }
  }
  expect(await routingSnapshot()).toEqual(before);
  const scopes=await mockPrisma.membershipScope.findMany({where:{membershipId:memberships[0].id}});await mockPrisma.membershipScope.deleteMany({where:{membershipId:memberships[0].id}});
  try{await expect(templateDetail({user:actor(memberships[0]),routeTemplateId:templates[0].id})).rejects.toMatchObject({statusCode:403});}finally{await mockPrisma.membershipScope.createMany({data:scopes});}
  expect(await routingSnapshot()).toEqual(before);
});

it("routing selector PostgreSQL current parent permission and owner graph constrain the actual rule query",async()=>{
  const m=memberships[0],order=fixture.orders.find(o=>o.ownerOrgId===m.companyId)!,user=actor(m),g=await routingGraph();
  const leg=await mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:300,mode:"road",templateCompanyId:m.companyId,routeTemplateId:g.template.id,routeTemplateLegId:g.leg.id}});
  const own=await mockPrisma.carrierRoutingRule.create({data:{companyId:m.companyId,providerId:providers[0].id,name:"Synthetic selector",priority:100,routeTemplateId:g.template.id,routeTemplateLegId:g.leg.id}});
  const before=await routingSnapshot();
  await expect(routingSelector({actor:user,orderId:order.id,legId:leg.id})).resolves.toMatchObject({id:own.id,providerId:providers[0].id});
  for(const foreign of memberships.slice(1)) await expect(routingSelector({actor:actor(foreign),orderId:order.id,legId:leg.id})).rejects.toMatchObject({statusCode:404});
  await expect(routingSelector({actor:user,orderId:order.id,legId:randomUUID()})).resolves.toBeNull();
  expect(await routingSnapshot()).toEqual(before);
  await mockPrisma.integrationProvider.update({where:{id:providers[0].id},data:{status:"disabled"}});
  try{await expect(routingSelector({actor:user,orderId:order.id,legId:leg.id})).resolves.toBeNull();}finally{await mockPrisma.integrationProvider.update({where:{id:providers[0].id},data:{status:"active"}});}
  await mockPrisma.tenant.update({where:{id:m.tenantId},data:{status:"suspended"}});
  try{await expect(routingSelector({actor:user,orderId:order.id,legId:leg.id})).rejects.toMatchObject({statusCode:403});}finally{await mockPrisma.tenant.update({where:{id:m.tenantId},data:{status:"active"}});}
  expect(await routingSnapshot()).toEqual(before);
  // Remove only this test's synthetic decision/leg so later seeding starts with no legs.
  await mockPrisma.carrierRoutingRule.delete({where:{id:own.id}});
  await mockPrisma.orderLeg.delete({where:{id:leg.id}});
});

async function seedSnapshot() {
  return {business:await routingSnapshot(),components:await mockPrisma.pricingComponent.findMany({orderBy:{id:"asc"}}),
    orderLegs:await mockPrisma.orderLeg.findMany({orderBy:{id:"asc"}}),analytics:await mockPrisma.analyticsDomainEventOutbox.findMany({orderBy:{id:"asc"}})};
}
it("pricing source PostgreSQL accepted operational seed is owner scoped and concurrent reseeding has no duplicate components",async()=>{
  const m=memberships[0],order=fixture.orders.find(o=>o.ownerOrgId===m.companyId)!,g=await routingGraph();
  const input={serviceCharge:10,currency:"USD",routeTemplateId:g.template.id},user=actor(m);
  const results=await Promise.all([pricingSeed(order.id,input,user),pricingSeed(order.id,input,user)]);
  expect(results.every(r=>r?.length===1)).toBe(true);
  const components=await mockPrisma.pricingComponent.findMany({where:{orderId:order.id}}),legs=await mockPrisma.orderLeg.findMany({where:{orderId:order.id}});
  expect(components).toHaveLength(1);expect(legs).toHaveLength(1);expect(components[0].orderLegId).toBe(legs[0].id);expect(components[0].amount.toString()).toBe("10");
  expect((await componentList(order.id,user))[0].amount).toBe("10");
  const before=await seedSnapshot();
  for(const foreign of memberships.slice(1))await expect(pricingSeed(order.id,input,actor(foreign))).rejects.toMatchObject({statusCode:404});
  const foreignTemplate=await mockPrisma.routeTemplate.create({data:{companyId:providers[1].companyId,name:"Synthetic foreign pricing"}});
  const afterFixture=await seedSnapshot();await expect(pricingSeed(order.id,{...input,routeTemplateId:foreignTemplate.id},user)).rejects.toThrow();expect(await seedSnapshot()).toEqual(afterFixture);
  await expect(manualPricing(order.id,{amount:999,currency:"USD",source:"rule",fxRateSnapshot:1} as any,user)).rejects.toMatchObject({statusCode:409,code:"ORDER_PRICING_ACCEPTANCE_REQUIRED"});
  expect(await mockPrisma.pricingComponent.findMany({where:{orderId:order.id}})).toEqual(components);
  expect((await seedSnapshot()).analytics).toEqual(before.analytics);
  // Estimates remain unaccepted financial basis; repeated seeds intentionally retain existing event behavior.
  expect(await mockPrisma.financeDomainEventOutbox.count()).toBe(before.business.business.finance);
});
it("pricing source PostgreSQL compound child/order rejects inserts updates and rolls back related writes",async()=>{
  const ownOrder=fixture.orders.find(o=>o.ownerOrgId===memberships[0].companyId)!,own=await mockPrisma.pricingComponent.findFirstOrThrow({where:{orderId:ownOrder.id}});
  for(const membership of memberships.slice(1)) {
    const order=fixture.orders.find(o=>o.ownerOrgId===membership.companyId)!;
    const leg=await mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:400,mode:"road"}}),before=await seedSnapshot();
    await expect(mockPrisma.pricingComponent.create({data:{orderId:ownOrder.id,orderLegId:leg.id,componentType:own.componentType,amount:"10",currency:"USD"}})).rejects.toMatchObject({code:"P2003"});
    await expect(mockPrisma.pricingComponent.update({where:{id:own.id},data:{orderLegId:leg.id}})).rejects.toMatchObject({code:"P2003"});
    await expect(mockPrisma.$transaction(async tx=>{
      await tx.pricingComponent.update({where:{id:own.id},data:{description:"Must roll back"}});
      await tx.pricingComponent.create({data:{orderId:ownOrder.id,orderLegId:leg.id,componentType:own.componentType,amount:"10",currency:"USD"}});
    },{maxWait:2000,timeout:5000})).rejects.toMatchObject({code:"P2003"});
    expect(await seedSnapshot()).toEqual(before);
  }
  const sameOrderLeg=await mockPrisma.orderLeg.findUniqueOrThrow({where:{id:own.orderLegId!}}),before=await seedSnapshot();
  await expect(mockPrisma.orderLeg.update({where:{id:sameOrderLeg.id},data:{orderId:fixture.orders.find(o=>o.id!==ownOrder.id)!.id,sequence:499}})).rejects.toMatchObject({code:"P2003"});
  expect(await seedSnapshot()).toEqual(before);
  const catalog=await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='PricingComponent_order_leg_fkey'");expect(catalog.rows).toEqual([{convalidated:false}]);
});
it("pricing source PostgreSQL injected seed failure rolls back component leg and analytics state",async()=>{
  const m=memberships[1],order=fixture.orders.find(o=>o.ownerOrgId===m.companyId)!,g=await routingGraph(1);
  await mockPrisma.routeTemplateLeg.update({where:{id:g.leg.id},data:{sequence:400}});
  const before=await seedSnapshot(),original=mockPrisma;
  mockPrisma=new Proxy(original,{get(target,key){if(key==="$transaction")return(work:any,options:any)=>target.$transaction(async tx=>{await work(tx);throw Error("synthetic-seed-rollback");},options);const value=(target as any)[key];return typeof value==="function"?value.bind(target):value;}});
  try{await expect(pricingSeed(order.id,{serviceCharge:10,currency:"USD",routeTemplateId:g.template.id},actor(m))).rejects.toThrow("synthetic-seed-rollback");}finally{mockPrisma=original;}
  expect(await seedSnapshot()).toEqual(before);
});
it("order leg template PostgreSQL optional links and populated graph preserve authoritative company",async()=>{
  const order=fixture.orders.find(o=>o.ownerOrgId===memberships[0].companyId)!,g=await routingGraph();
  const plain=await mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:700,mode:"road"}});
  expect(plain.templateCompanyId).toBeNull();
  const templated=await mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:701,mode:"road",templateCompanyId:memberships[0].companyId,routeTemplateId:g.template.id}});
  await expect(mockPrisma.orderLeg.update({where:{id:templated.id},data:{routeTemplateLegId:g.leg.id}})).resolves.toMatchObject({routeTemplateLegId:g.leg.id});
  const otherOrder=fixture.orders.find(o=>o.ownerOrgId===memberships[1].companyId)!,other=await routingGraph(1);
  await expect(mockPrisma.orderLeg.create({data:{orderId:otherOrder.id,sequence:702,mode:"road",templateCompanyId:memberships[1].companyId,routeTemplateId:other.template.id,routeTemplateLegId:other.leg.id}})).resolves.toMatchObject({templateCompanyId:memberships[1].companyId});
  const catalog=await pool.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=ANY($1::text[])",[["OrderLeg_template_order_company_fkey","OrderLeg_template_company_fkey","OrderLeg_template_child_fkey","OrderLeg_template_complete_check"]]);
  expect(catalog.rows).toHaveLength(4);expect(catalog.rows.every(r=>!r.convalidated)).toBe(true);
  expect(catalog.rows.find(r=>r.conname==="OrderLeg_template_order_company_fkey").definition).toContain('REFERENCES "Order"(id, "ownerOrgId")');
});
it("order leg template PostgreSQL foreign company tenant and child insert/update rejection leaves business state unchanged",async()=>{
  const order=fixture.orders.find(o=>o.ownerOrgId===memberships[0].companyId)!,own=await routingGraph();
  const leg=await mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:710,mode:"road",templateCompanyId:memberships[0].companyId,routeTemplateId:own.template.id,routeTemplateLegId:own.leg.id}});
  for(let i=1;i<memberships.length;i++){
    const foreign=await routingGraph(i),foreignOrder=fixture.orders.find(o=>o.ownerOrgId===memberships[i].companyId)!;
    const invalid=[{templateCompanyId:memberships[i].companyId,routeTemplateId:foreign.template.id,routeTemplateLegId:foreign.leg.id},{routeTemplateId:foreign.template.id,routeTemplateLegId:foreign.leg.id},{routeTemplateLegId:foreign.leg.id},{orderId:foreignOrder.id}];
    for(const refs of invalid){const before=await seedSnapshot();await expect(mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:711,mode:"road",templateCompanyId:memberships[0].companyId,routeTemplateId:own.template.id,routeTemplateLegId:own.leg.id,...refs}})).rejects.toMatchObject({code:"P2003"});await expect(mockPrisma.orderLeg.update({where:{id:leg.id},data:refs})).rejects.toMatchObject({code:"P2003"});expect(await seedSnapshot()).toEqual(before);}
  }
});
it("order leg template PostgreSQL partial references and failed transaction do not persist child pricing or events",async()=>{
  const order=fixture.orders.find(o=>o.ownerOrgId===memberships[0].companyId)!,g=await routingGraph();
  for(const refs of [{routeTemplateId:g.template.id},{routeTemplateLegId:g.leg.id},{templateCompanyId:memberships[0].companyId}]){
    const before=await seedSnapshot();await expect(mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:720,mode:"road",...refs}})).rejects.toThrow();expect(await seedSnapshot()).toEqual(before);
  }
  let reachedRejectedReference=false;const before=await seedSnapshot();await expect(mockPrisma.$transaction(async tx=>{
    const leg=await tx.orderLeg.create({data:{orderId:order.id,sequence:721,mode:"road"}});
    await tx.pricingComponent.create({data:{orderId:order.id,orderLegId:leg.id,componentType:"other",amount:"10",currency:"USD"}});
    await tx.integrationOutbox.create({data:{companyId:providers[0].companyId,providerId:providers[0].id,domain:"carrier",providerCode:"sandbox",environment:"sandbox",eventType:"synthetic-rollback",payload:{},idempotencyKey:randomUUID()}});
    reachedRejectedReference=true;await tx.orderLeg.update({where:{id:leg.id},data:{routeTemplateId:g.template.id}});
  },{maxWait:2000,timeout:5000})).rejects.toThrow();expect(reachedRejectedReference).toBe(true);expect(await seedSnapshot()).toEqual(before);
});
it("order leg template PostgreSQL competing template relocation and child insertion cannot commit a conflicting graph",async()=>{
  const order=fixture.orders.find(o=>o.ownerOrgId===memberships[0].companyId)!,g=await routingGraph();
  const settled=await Promise.allSettled([
    mockPrisma.orderLeg.create({data:{orderId:order.id,sequence:730,mode:"road",templateCompanyId:memberships[0].companyId,routeTemplateId:g.template.id,routeTemplateLegId:g.leg.id}}),
    mockPrisma.routeTemplate.update({where:{id:g.template.id},data:{companyId:memberships[1].companyId}}),
  ]);
  expect(settled.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const stored=await mockPrisma.orderLeg.findFirst({where:{orderId:order.id,sequence:730}}),template=await mockPrisma.routeTemplate.findUniqueOrThrow({where:{id:g.template.id}});
  if(stored){expect(template.companyId).toBe(stored.templateCompanyId);expect(stored.templateCompanyId).toBe(order.ownerOrgId);}else expect(template.companyId).toBe(memberships[1].companyId);
});
async function credentialSnapshot(){return {business:await snapshot(),providers:await mockPrisma.integrationProvider.findMany({orderBy:{id:"asc"}}),secrets:await mockPrisma.integrationProviderSecret.findMany({orderBy:{id:"asc"}})};}
async function credentialProvider(i=0){return mockPrisma.integrationProvider.create({data:{companyId:memberships[i].companyId,domain:"carrier",providerCode:randomUUID(),environment:"sandbox"}});}
it("secret pointer PostgreSQL valid optional and owned references use the exact secret provider target",async()=>{
  for(let i=0;i<memberships.length;i++){
    const p=await credentialProvider(i);expect(p.activeSecretId).toBeNull();
    const secret=await mockPrisma.integrationProviderSecret.create({data:{providerId:p.id,keyVersion:1,encryptedSecretJson:"synthetic-opaque-not-a-live-credential"}});
    await expect(mockPrisma.integrationProvider.update({where:{id:p.id},data:{secretRef:secret.id.toUpperCase(),activeSecretId:secret.id}})).resolves.toMatchObject({activeSecretId:secret.id});
    const before=await credentialSnapshot();await expect(mockPrisma.integrationProviderSecret.delete({where:{id:secret.id}})).rejects.toThrow("Integration secret versions are immutable");expect(await credentialSnapshot()).toEqual(before);
  }
  const catalog=await pool.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=ANY($1::text[])",[["IntegrationProvider_active_secret_owner_fkey","IntegrationProvider_active_secret_complete_check"]]);
  expect(catalog.rows).toHaveLength(2);expect(catalog.rows.every(r=>!r.convalidated)).toBe(true);expect(catalog.rows.find(r=>r.conname==="IntegrationProvider_active_secret_owner_fkey").definition).toContain('REFERENCES "IntegrationProviderSecret"(id, "providerId")');
});
it("secret pointer PostgreSQL foreign and partial inserts updates and rollback have no business effects",async()=>{
  const own=await credentialProvider(),secret=await mockPrisma.integrationProviderSecret.create({data:{providerId:own.id,encryptedSecretJson:"synthetic-opaque"}});
  for(const index of [0,1,2]){
    const foreign=await credentialProvider(index),before=await credentialSnapshot();
    await expect(mockPrisma.integrationProvider.update({where:{id:foreign.id},data:{secretRef:secret.id,activeSecretId:secret.id}})).rejects.toMatchObject({code:"P2003"});
    await expect(mockPrisma.integrationProvider.create({data:{id:randomUUID(),companyId:memberships[index].companyId,providerCode:randomUUID(),domain:"carrier",secretRef:secret.id,activeSecretId:secret.id}})).rejects.toMatchObject({code:"P2003"});expect(await credentialSnapshot()).toEqual(before);
  }
  for(const data of [{secretRef:secret.id},{activeSecretId:secret.id},{secretRef:randomUUID(),activeSecretId:secret.id}]){
    const before=await credentialSnapshot();await expect(mockPrisma.integrationProvider.update({where:{id:own.id},data})).rejects.toThrow();expect(await credentialSnapshot()).toEqual(before);
  }
  let reached=false;const before=await credentialSnapshot();await expect(mockPrisma.$transaction(async tx=>{
    await tx.integrationOutbox.create({data:{companyId:own.companyId,providerId:own.id,domain:"carrier",providerCode:own.providerCode,environment:"sandbox",eventType:"synthetic-pointer-rollback",payload:{},idempotencyKey:randomUUID()}});
    reached=true;await tx.integrationProvider.update({where:{id:own.id},data:{secretRef:secret.id}});
  },{maxWait:2000,timeout:5000})).rejects.toThrow();expect(reached).toBe(true);expect(await credentialSnapshot()).toEqual(before);
});
it("secret pointer PostgreSQL concurrent pointer acceptance versus secret reassignment cannot commit foreign ownership",async()=>{
  const own=await credentialProvider(),other=await credentialProvider(1),secret=await mockPrisma.integrationProviderSecret.create({data:{providerId:own.id,encryptedSecretJson:"synthetic-opaque"}});
  const settled=await Promise.allSettled([
    mockPrisma.integrationProvider.update({where:{id:own.id},data:{secretRef:secret.id,activeSecretId:secret.id}}),
    mockPrisma.integrationProviderSecret.update({where:{id:secret.id},data:{providerId:other.id}}),
  ]);
  expect(settled.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const p=await mockPrisma.integrationProvider.findUniqueOrThrow({where:{id:own.id}}),s=await mockPrisma.integrationProviderSecret.findUniqueOrThrow({where:{id:secret.id}});
  if(p.activeSecretId){expect(s.providerId).toBe(p.id);expect(p.secretRef).toBe(s.id);}else expect(s.providerId).toBe(other.id);
});
it("secret pointer PostgreSQL existing version uniqueness prevents concurrent duplicate version insertion",async()=>{
  const p=await credentialProvider(),before=await snapshot();
  const settled=await Promise.allSettled([1,2].map(()=>mockPrisma.integrationProviderSecret.create({data:{providerId:p.id,keyVersion:10,encryptedSecretJson:"synthetic-opaque"}})));
  expect(settled.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(await mockPrisma.integrationProviderSecret.count({where:{providerId:p.id,keyVersion:10}})).toBe(1);expect(await snapshot()).toEqual(before);
});
it("secret immutable PostgreSQL rejects every version rewrite delete cascade and truncate without changes",async()=>{
  const p=await credentialProvider(),other=await credentialProvider(1),secret=await mockPrisma.integrationProviderSecret.create({data:{providerId:p.id,keyVersion:1,encryptedSecretJson:"synthetic-immutable-cipher"}});
  for(const data of [{encryptedSecretJson:"synthetic-replacement"},{providerId:other.id},{keyVersion:2},{secretMasked:"synthetic-replacement"},{rotatedAt:new Date()},{id:randomUUID()}]){
    const before=await credentialSnapshot();await expect(mockPrisma.integrationProviderSecret.update({where:{id:secret.id},data})).rejects.toThrow("Integration secret versions are immutable");expect(await credentialSnapshot()).toEqual(before);
  }
  const before=await credentialSnapshot();await expect(mockPrisma.integrationProviderSecret.delete({where:{id:secret.id}})).rejects.toThrow("Integration secret versions are immutable");
  await expect(mockPrisma.integrationProvider.delete({where:{id:p.id}})).rejects.toThrow("Integration secret versions are immutable");
  // This guarded pool targets only this run's disposable DB; rejection must preserve every version.
  await expect(pool.query('TRUNCATE "IntegrationProviderSecret" CASCADE')).rejects.toMatchObject({code:"23514",constraint:"IntegrationProviderSecret_immutable"});expect(await credentialSnapshot()).toEqual(before);
});
it("secret immutable PostgreSQL new version insertion succeeds and failed rewrite rolls back related outbox",async()=>{
  const p=await credentialProvider(),first=await mockPrisma.integrationProviderSecret.create({data:{providerId:p.id,keyVersion:1,encryptedSecretJson:"synthetic-first"}});
  await expect(mockPrisma.integrationProviderSecret.create({data:{providerId:p.id,keyVersion:2,encryptedSecretJson:"synthetic-second"}})).resolves.toMatchObject({keyVersion:2});
  let reached=false;const before=await credentialSnapshot();await expect(mockPrisma.$transaction(async tx=>{
    await tx.integrationOutbox.create({data:{companyId:p.companyId,providerId:p.id,domain:"carrier",providerCode:p.providerCode,environment:"sandbox",eventType:"synthetic-immutable-rollback",payload:{},idempotencyKey:randomUUID()}});
    reached=true;await tx.integrationProviderSecret.update({where:{id:first.id},data:{encryptedSecretJson:"synthetic-must-rollback"}});
  },{maxWait:2000,timeout:5000})).rejects.toThrow("Integration secret versions are immutable");expect(reached).toBe(true);expect(await credentialSnapshot()).toEqual(before);
});
async function publicationGrants(){
  for(const key of ["integration.provider.manage","integration.provider.rotateSecret"]){const permission=await mockPrisma.permission.upsert({where:{key},create:{key,resource:"synthetic-config",action:"publish"},update:{}});for(const m of memberships){const roles=await mockPrisma.membershipRole.findMany({where:{membershipId:m.id}});await mockPrisma.rolePermission.createMany({data:roles.map(r=>({roleId:r.roleId,permissionId:permission.id})),skipDuplicates:true});}}
}
async function publicationSnapshot(){return {...await credentialSnapshot(),versions:await mockPrisma.integrationProviderConfigurationVersion.findMany({orderBy:{id:"asc"}})};}
it("publication PostgreSQL concurrent matching retries return one immutable journal and atomic pointer",async()=>{
  await publicationGrants();const p=await credentialProvider(),secret=await mockPrisma.integrationProviderSecret.create({data:{providerId:p.id,encryptedSecretJson:"synthetic-opaque"}}),operationId=randomUUID(),user=actor(memberships[0]);
  const intent={user,providerId:p.id,operationId,expectedRevision:0,secretId:secret.id};const results=await Promise.all([publishConfiguration(intent),publishConfiguration(intent)]);expect(results[0]).toEqual(results[1]);
  expect(await mockPrisma.integrationProviderConfigurationVersion.count({where:{providerId:p.id}})).toBe(1);
  expect(await mockPrisma.integrationProvider.findUniqueOrThrow({where:{id:p.id}})).toMatchObject({currentConfigurationId:results[0].id,configurationRevision:1,activeSecretId:secret.id,secretRef:secret.id});
  expect(Object.keys(results[0]).sort()).toEqual(["acceptedAt","id","operationId","providerId","revision"]);
  const before=await publicationSnapshot();await expect(publishConfiguration({...intent,expectedRevision:1})).rejects.toMatchObject({statusCode:409});expect(await publicationSnapshot()).toEqual(before);
  const scopes=await mockPrisma.membershipScope.findMany({where:{membershipId:memberships[0].id}});await mockPrisma.membershipScope.deleteMany({where:{membershipId:memberships[0].id}});
  try{await expect(publishConfiguration(intent)).rejects.toMatchObject({statusCode:403});expect(await publicationSnapshot()).toEqual(before);}finally{await mockPrisma.membershipScope.createMany({data:scopes});}
});
it("publication PostgreSQL competing revisions and cross-company operation reuse cannot publish twice",async()=>{
  await publicationGrants();const p=await credentialProvider(),user=actor(memberships[0]);const settled=await Promise.allSettled([randomUUID(),randomUUID()].map(operationId=>publishConfiguration({user,providerId:p.id,operationId,expectedRevision:0})));
  expect(settled.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(settled.find(r=>r.status==="rejected")).toMatchObject({reason:{statusCode:409}});expect(await mockPrisma.integrationProviderConfigurationVersion.count({where:{providerId:p.id}})).toBe(1);
  const accepted=await mockPrisma.integrationProviderConfigurationVersion.findFirstOrThrow({where:{providerId:p.id}}),other=await credentialProvider(1),before=await publicationSnapshot();
  await expect(publishConfiguration({user:actor(memberships[1]),providerId:other.id,operationId:accepted.operationId,expectedRevision:0})).rejects.toMatchObject({statusCode:409});expect(await publicationSnapshot()).toEqual(before);
});
it("publication PostgreSQL foreign providers secrets financial domain and suspended context cause no writes",async()=>{
  await publicationGrants();const p=await credentialProvider(),foreign=await credentialProvider(2),secret=await mockPrisma.integrationProviderSecret.create({data:{providerId:foreign.id,encryptedSecretJson:"synthetic-opaque"}}),user=actor(memberships[0]);
  for(const m of memberships.slice(1)){const before=await publicationSnapshot();await expect(publishConfiguration({user:actor(m),providerId:p.id,operationId:randomUUID(),expectedRevision:0})).rejects.toMatchObject({statusCode:404});expect(await publicationSnapshot()).toEqual(before);}
  let before=await publicationSnapshot();await expect(publishConfiguration({user,providerId:p.id,operationId:randomUUID(),expectedRevision:0,secretId:secret.id})).rejects.toMatchObject({statusCode:404});expect(await publicationSnapshot()).toEqual(before);
  await mockPrisma.integrationProvider.update({where:{id:p.id},data:{domain:"payment"}});before=await publicationSnapshot();await expect(publishConfiguration({user,providerId:p.id,operationId:randomUUID(),expectedRevision:0})).rejects.toMatchObject({statusCode:409});expect(await publicationSnapshot()).toEqual(before);
  await mockPrisma.tenant.update({where:{id:memberships[0].tenantId},data:{status:"suspended"}});before=await publicationSnapshot();try{await expect(publishConfiguration({user,providerId:p.id,operationId:randomUUID(),expectedRevision:0})).rejects.toMatchObject({statusCode:403});expect(await publicationSnapshot()).toEqual(before);}finally{await mockPrisma.tenant.update({where:{id:memberships[0].tenantId},data:{status:"active"}});}
});
it("publication PostgreSQL direct journal reference forgery and unjournaled snapshot changes are rejected",async()=>{
  await publicationGrants();const p=await credentialProvider(),result=await publishConfiguration({user:actor(memberships[0]),providerId:p.id,operationId:randomUUID(),expectedRevision:0});const stored=await mockPrisma.integrationProviderConfigurationVersion.findUniqueOrThrow({where:{id:result.id}});
  for(const data of [{timeoutMs:1234},{currentConfigurationId:null,configurationRevision:0},{capabilities:["changed"]}]){const before=await publicationSnapshot();await expect(mockPrisma.integrationProvider.update({where:{id:p.id},data})).rejects.toThrow();expect(await publicationSnapshot()).toEqual(before);}
  const before=await publicationSnapshot();await expect(mockPrisma.integrationProviderConfigurationVersion.update({where:{id:result.id},data:{intentSha256:"b".repeat(64)}})).rejects.toThrow("Integration configuration versions are immutable");await expect(mockPrisma.integrationProviderConfigurationVersion.delete({where:{id:result.id}})).rejects.toThrow("Integration configuration versions are immutable");expect(await publicationSnapshot()).toEqual(before);
  const fresh=await credentialProvider(),{id,acceptedAt,...base}=stored;
  const unpublishedBefore=await publicationSnapshot();await expect(mockPrisma.integrationProviderConfigurationVersion.create({data:{...base,providerId:fresh.id,providerCode:fresh.providerCode,operationId:randomUUID()}})).rejects.toThrow("Integration configuration receipt was not published");expect(await publicationSnapshot()).toEqual(unpublishedBefore);
  for(const refs of [{companyMembershipId:memberships[1].id},{tenantMembershipId:memberships[2].tenantMembershipId},{tenantId:memberships[2].tenantId}]){const before=await publicationSnapshot();await expect(mockPrisma.integrationProviderConfigurationVersion.create({data:{...base,providerId:fresh.id,providerCode:fresh.providerCode,operationId:randomUUID(),...refs}})).rejects.toMatchObject({code:"P2003"});expect(await publicationSnapshot()).toEqual(before);}
});
it("publication PostgreSQL injected failure rolls back journal pointer and any related outbox",async()=>{
  await publicationGrants();const p=await credentialProvider(),original=mockPrisma,before=await publicationSnapshot();let reached=false;
  mockPrisma=new Proxy(original,{get(target,key){if(key==="$transaction")return(work:any,options:any)=>target.$transaction(async tx=>{await work(tx);reached=true;await tx.integrationOutbox.create({data:{companyId:p.companyId,providerId:p.id,domain:"carrier",providerCode:p.providerCode,environment:"sandbox",eventType:"synthetic-publication-rollback",payload:{},idempotencyKey:randomUUID()}});throw Error("synthetic-publication-rollback");},options);const value=(target as any)[key];return typeof value==="function"?value.bind(target):value;}});
  try{await expect(publishConfiguration({user:actor(memberships[0]),providerId:p.id,operationId:randomUUID(),expectedRevision:0})).rejects.toThrow("synthetic-publication-rollback");}finally{mockPrisma=original;}
  expect(reached).toBe(true);expect(await publicationSnapshot()).toEqual(before);
});

it("publication PostgreSQL concurrent shared operation across companies returns one result and one conflict",async()=>{
  await publicationGrants();const own=await credentialProvider(),other=await credentialProvider(1),operationId=randomUUID();
  const settled=await Promise.allSettled([publishConfiguration({user:actor(memberships[0]),providerId:own.id,operationId,expectedRevision:0}),publishConfiguration({user:actor(memberships[1]),providerId:other.id,operationId,expectedRevision:0})]);
  expect(settled.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(settled.find(r=>r.status==="rejected")).toMatchObject({reason:{statusCode:409}});
  expect(await mockPrisma.integrationProviderConfigurationVersion.count({where:{tenantId:memberships[0].tenantId,operationId}})).toBe(1);
  const rows=await mockPrisma.integrationProvider.findMany({where:{id:{in:[own.id,other.id]}}});expect(rows.map(r=>r.configurationRevision).sort()).toEqual([0,1]);
});
it("configuration read PostgreSQL owns counts cursors revisions and projections across three selected companies",async()=>{
  await publicationGrants();const permission=await mockPrisma.permission.upsert({where:{key:"integration.provider.read"},create:{key:"integration.provider.read",resource:"synthetic-config",action:"read"},update:{}});
  const owned:any[]=[];for(let i=0;i<memberships.length;i++){
    const roles=await mockPrisma.membershipRole.findMany({where:{membershipId:memberships[i].id}});await mockPrisma.rolePermission.createMany({data:roles.map(r=>({roleId:r.roleId,permissionId:permission.id})),skipDuplicates:true});
    const p=await credentialProvider(i);await publishConfiguration({user:actor(memberships[i]),providerId:p.id,operationId:randomUUID(),expectedRevision:0});await publishConfiguration({user:actor(memberships[i]),providerId:p.id,operationId:randomUUID(),expectedRevision:1});owned.push(p);
  }
  const before=await publicationSnapshot();for(let i=0;i<memberships.length;i++){
    const user=actor(memberships[i]),first=await readConfigurations({user,providerId:owned[i].id,limit:1});expect(first.total).toBe(2);expect(first.currentRevision).toBe(2);expect(first.data.map(r=>r.revision)).toEqual([2]);expect(first.pageInfo.hasNextPage).toBe(true);
    const second=await readConfigurations({user,providerId:owned[i].id,limit:1,cursor:first.pageInfo.nextCursor!});expect(second.data.map(r=>r.revision)).toEqual([1]);expect(second.total).toBe(2);expect(second.pageInfo.hasNextPage).toBe(false);
    for(const key of ["secretId","secretRef","intentSha256","actorUserId","companyMembershipId","capabilities","retryPolicyId"])expect(JSON.stringify(first)).not.toContain(key);
    for(let j=0;j<memberships.length;j++)if(j!==i){await expect(readConfigurations({user,providerId:owned[j].id})).rejects.toMatchObject({statusCode:404});const foreign=await mockPrisma.integrationProviderConfigurationVersion.findFirstOrThrow({where:{providerId:owned[j].id}});await expect(readConfigurations({user,providerId:owned[i].id,cursor:foreign.id})).rejects.toMatchObject({statusCode:404});}
  }
  expect(await publicationSnapshot()).toEqual(before);
  const plain=await credentialProvider();const zero=await readConfigurations({user:actor(memberships[0]),providerId:plain.id});expect(zero).toMatchObject({currentRevision:0,currentConfigurationId:null,total:0,data:[]});
  const afterFixture=await publicationSnapshot();const scopes=await mockPrisma.membershipScope.findMany({where:{membershipId:memberships[0].id}});await mockPrisma.membershipScope.deleteMany({where:{membershipId:memberships[0].id}});
  try{await expect(readConfigurations({user:actor(memberships[0]),providerId:owned[0].id})).rejects.toMatchObject({statusCode:403});expect(await publicationSnapshot()).toEqual(afterFixture);}finally{await mockPrisma.membershipScope.createMany({data:scopes});}
  expect((await publicationSnapshot()).versions).toEqual(before.versions);
});


async function templatePublicationFixture(company=0){
 const permission=await mockPrisma.permission.upsert({where:{key:"integration.routing.manage"},create:{key:"integration.routing.manage",resource:"synthetic-template",action:"publish"},update:{}});
 for(const m of memberships){const roles=await mockPrisma.membershipRole.findMany({where:{membershipId:m.id}});await mockPrisma.rolePermission.createMany({data:roles.map(r=>({roleId:r.roleId,permissionId:permission.id})),skipDuplicates:true});}
 return mockPrisma.routeTemplate.create({data:{companyId:memberships[company].companyId,name:"Synthetic version "+randomUUID(),metadata:{canary:"DO-NOT-COPY"},legs:{create:{sequence:1,legCode:"road",mode:"road",metadata:{canary:"DO-NOT-COPY"}}}},include:{legs:true}});
}
async function templatePublicationSnapshot(){return {...await snapshot(),templates:await mockPrisma.routeTemplate.findMany({orderBy:{id:"asc"}}),legs:await mockPrisma.routeTemplateLeg.findMany({orderBy:{id:"asc"}}),versions:await mockPrisma.routeTemplateConfigurationVersion.findMany({orderBy:{id:"asc"}}),versionLegs:await mockPrisma.routeTemplateConfigurationLeg.findMany({orderBy:{versionId:"asc"}})};}
it("template publication PostgreSQL matching concurrent requests create one sealed snapshot and exact retry",async()=>{
 const t=await templatePublicationFixture(),intent={user:actor(memberships[0]),templateId:t.id,operationId:randomUUID(),expectedRevision:0};
 const results=await Promise.all([publishTemplateConfiguration(intent),publishTemplateConfiguration(intent)]);expect(results[0]).toEqual(results[1]);
 expect(await mockPrisma.routeTemplateConfigurationVersion.count({where:{templateId:t.id}})).toBe(1);
 expect(await mockPrisma.routeTemplateConfigurationLeg.count({where:{versionId:results[0].id}})).toBe(1);
 expect(await mockPrisma.routeTemplate.findUniqueOrThrow({where:{id:t.id}})).toMatchObject({configurationRevision:1,currentConfigurationId:results[0].id});
 const before=await templatePublicationSnapshot();await expect(publishTemplateConfiguration({...intent,expectedRevision:1})).rejects.toMatchObject({statusCode:409});expect(await templatePublicationSnapshot()).toEqual(before);
});
it("template publication PostgreSQL competing revision and same-tenant company operation reuse serialize",async()=>{
 const t=await templatePublicationFixture(),user=actor(memberships[0]);
 const outcomes=await Promise.allSettled([1,2].map(()=>publishTemplateConfiguration({user,templateId:t.id,operationId:randomUUID(),expectedRevision:0})));
 expect(outcomes.filter(x=>x.status==="fulfilled")).toHaveLength(1);expect(outcomes.find(x=>x.status==="rejected")).toMatchObject({reason:{statusCode:409}});
 const a=await templatePublicationFixture(),b=await templatePublicationFixture(1),operationId=randomUUID();
 const reused=await Promise.allSettled([publishTemplateConfiguration({user,templateId:a.id,operationId,expectedRevision:0}),publishTemplateConfiguration({user:actor(memberships[1]),templateId:b.id,operationId,expectedRevision:0})]);
 expect(reused.filter(x=>x.status==="fulfilled")).toHaveLength(1);expect(reused.find(x=>x.status==="rejected")).toMatchObject({reason:{statusCode:409}});
 expect(await mockPrisma.routeTemplateConfigurationVersion.count({where:{tenantId:memberships[0].tenantId,operationId}})).toBe(1);
});
it("template publication PostgreSQL foreign companies tenants missing scope and suspended context deny without writes",async()=>{
 const t=await templatePublicationFixture(),intent={user:actor(memberships[0]),templateId:t.id,operationId:randomUUID(),expectedRevision:0};
 for(const m of memberships.slice(1)){const before=await templatePublicationSnapshot();await expect(publishTemplateConfiguration({...intent,user:actor(m)})).rejects.toMatchObject({statusCode:404});expect(await templatePublicationSnapshot()).toEqual(before);}
 const scopes=await mockPrisma.membershipScope.findMany({where:{membershipId:memberships[0].id}});await mockPrisma.membershipScope.deleteMany({where:{membershipId:memberships[0].id}});
 try{const before=await templatePublicationSnapshot();await expect(publishTemplateConfiguration(intent)).rejects.toMatchObject({statusCode:403});expect(await templatePublicationSnapshot()).toEqual(before);}finally{await mockPrisma.membershipScope.createMany({data:scopes});}
 await mockPrisma.tenant.update({where:{id:memberships[0].tenantId},data:{status:"suspended"}});
 try{const before=await templatePublicationSnapshot();await expect(publishTemplateConfiguration(intent)).rejects.toMatchObject({statusCode:403});expect(await templatePublicationSnapshot()).toEqual(before);}finally{await mockPrisma.tenant.update({where:{id:memberships[0].tenantId},data:{status:"active"}});}
});
it("template publication PostgreSQL sealed immutable history and source snapshot cannot be altered or cleared",async()=>{
 const t=await templatePublicationFixture(),v=await publishTemplateConfiguration({user:actor(memberships[0]),templateId:t.id,operationId:randomUUID(),expectedRevision:0});
 const before=await templatePublicationSnapshot();
 await expect(mockPrisma.routeTemplateConfigurationVersion.update({where:{id:v.id},data:{name:"changed"}})).rejects.toThrow("history is immutable");
 await expect(mockPrisma.routeTemplateConfigurationVersion.delete({where:{id:v.id}})).rejects.toThrow("history is immutable");
 await expect(mockPrisma.routeTemplateConfigurationLeg.updateMany({where:{versionId:v.id},data:{label:"changed"}})).rejects.toThrow("history is immutable");
 await expect(mockPrisma.routeTemplateConfigurationLeg.deleteMany({where:{versionId:v.id}})).rejects.toThrow("history is immutable");
 await expect(mockPrisma.routeTemplate.update({where:{id:t.id},data:{name:"changed"}})).rejects.toThrow("snapshot disagrees");
 await expect(mockPrisma.routeTemplate.update({where:{id:t.id},data:{currentConfigurationId:null,configurationRevision:0}})).rejects.toThrow("history cannot be cleared");
 await expect(mockPrisma.routeTemplateLeg.update({where:{id:t.legs[0].id},data:{label:"changed"}})).rejects.toThrow("snapshot disagrees");
 await expect(mockPrisma.routeTemplateLeg.create({data:{routeTemplateId:t.id,sequence:2,legCode:"extra",mode:"road"}})).rejects.toThrow("snapshot disagrees");
 await expect(mockPrisma.routeTemplateConfigurationLeg.create({data:{versionId:v.id,templateId:t.id,sourceLegId:t.legs[0].id,sequence:2,legCode:"extra",mode:"road"}})).rejects.toThrow("children are sealed");
 for(const table of ["RouteTemplateConfigurationVersion","RouteTemplateConfigurationLeg","RouteTemplateLeg"])await expect(pool.query('TRUNCATE "'+table+'" CASCADE')).rejects.toMatchObject({code:"23514"});
 expect(await templatePublicationSnapshot()).toEqual(before);
});
it("template publication PostgreSQL unpublished receipts foreign actors and wrong template children cannot commit",async()=>{
 const t=await templatePublicationFixture(),foreign=await templatePublicationFixture(2),accepted=await publishTemplateConfiguration({user:actor(memberships[0]),templateId:t.id,operationId:randomUUID(),expectedRevision:0});
 const {id,acceptedAt,createdTransaction,...base}=await mockPrisma.routeTemplateConfigurationVersion.findUniqueOrThrow({where:{id:accepted.id}});
 const fresh=await templatePublicationFixture(),before=await templatePublicationSnapshot();
 await expect(mockPrisma.routeTemplateConfigurationVersion.create({data:{...base,templateId:fresh.id,operationId:randomUUID()}})).rejects.toThrow("receipt was not published");
 for(const override of [{companyMembershipId:memberships[1].id},{tenantMembershipId:memberships[2].tenantMembershipId},{tenantId:memberships[2].tenantId}])
  await expect(mockPrisma.routeTemplateConfigurationVersion.create({data:{...base,templateId:fresh.id,operationId:randomUUID(),...override}})).rejects.toMatchObject({code:"P2003"});
 await expect(mockPrisma.$transaction(async tx=>{
  const receipt=await tx.routeTemplateConfigurationVersion.create({data:{...base,templateId:fresh.id,operationId:randomUUID()}});
  await tx.routeTemplateConfigurationLeg.create({data:{versionId:receipt.id,templateId:fresh.id,sourceLegId:foreign.legs[0].id,sequence:1,legCode:"road",mode:"road"}});
 })).rejects.toMatchObject({code:"P2003"});
 expect(await templatePublicationSnapshot()).toEqual(before);
});
it("template publication PostgreSQL concurrent child edits preserve the committed snapshot",async()=>{
 expect((await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='TemplateConfiguration_source_parent_lock' AND NOT tgisinternal")).rows[0].n).toBe(1);
 const t=await templatePublicationFixture();
 const settled=await Promise.allSettled([
  publishTemplateConfiguration({user:actor(memberships[0]),templateId:t.id,operationId:randomUUID(),expectedRevision:0}),
  mockPrisma.routeTemplateLeg.update({where:{id:t.legs[0].id},data:{label:"synthetic concurrent edit"}}),
 ]);
 expect(settled.some(r=>r.status==="fulfilled")).toBe(true);
 const parent=await mockPrisma.routeTemplate.findUniqueOrThrow({where:{id:t.id}});
 const versions=await mockPrisma.routeTemplateConfigurationVersion.findMany({where:{templateId:t.id}});
 if(parent.currentConfigurationId){
  expect(versions).toHaveLength(1);expect(versions[0].id).toBe(parent.currentConfigurationId);
  const source=await mockPrisma.routeTemplateLeg.findUniqueOrThrow({where:{id:t.legs[0].id}});
  const stored=await mockPrisma.routeTemplateConfigurationLeg.findUniqueOrThrow({where:{versionId_sourceLegId:{versionId:parent.currentConfigurationId,sourceLegId:source.id}}});
  expect(stored.label).toBe(source.label);
 }else{expect(versions).toHaveLength(0);expect(parent.configurationRevision).toBe(0);}
});
it("template publication PostgreSQL oversized authoritative content rejects before journal writes",async()=>{
 const t=await templatePublicationFixture();
 await mockPrisma.routeTemplate.update({where:{id:t.id},data:{name:"x".repeat(2049)}});
 const before=await templatePublicationSnapshot();
 await expect(publishTemplateConfiguration({user:actor(memberships[0]),templateId:t.id,operationId:randomUUID(),expectedRevision:0})).rejects.toMatchObject({statusCode:409});
 expect(await templatePublicationSnapshot()).toEqual(before);
});
it("template publication PostgreSQL post-work failure rolls back version children pointer and related outbox",async()=>{
 const t=await templatePublicationFixture(),p=providers[0],before=await templatePublicationSnapshot(),original=mockPrisma;let reached=false;
 mockPrisma=new Proxy(original,{get(target,key){if(key==="$transaction")return(work:any,options:any)=>target.$transaction(async tx=>{
  await work(tx);reached=true;await tx.integrationOutbox.create({data:{companyId:p.companyId,providerId:p.id,domain:p.domain,providerCode:p.providerCode,environment:p.environment,eventType:"synthetic-template-rollback",payload:{},idempotencyKey:randomUUID()}});throw Error("synthetic-template-rollback");
 },options);const value=(target as any)[key];return typeof value==="function"?value.bind(target):value;}});
 try{await expect(publishTemplateConfiguration({user:actor(memberships[0]),templateId:t.id,operationId:randomUUID(),expectedRevision:0})).rejects.toThrow("synthetic-template-rollback");}finally{mockPrisma=original;}
 expect(reached).toBe(true);expect(await templatePublicationSnapshot()).toEqual(before);
});
