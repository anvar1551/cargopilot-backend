jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_t, key) => {
  const value = (mockPrisma as any)[key]; return typeof value === "function" ? value.bind(mockPrisma) : value;
} }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import http = require("http");
import https = require("https");
import { createTenantDemoFixture } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { proposeTariffVersion as propose, decideTariffVersion as decide, readTariffVersion as read } from "../../src/modules/pricing-core/repo/tariff-versions";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable run required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== "/cp_worker_" + run) throw Error("Refusing existing database");
const options = "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000";
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, options });
let mockPrisma: PrismaClient;
const fixture = createTenantDemoFixture(), memberships = fixture.companyMemberships;
const maker = memberships.findIndex(m => m.userId === fixture.users[1].id), checker = memberships.findIndex(m => m.userId === fixture.users[2].id);
const actor = (i = maker): any => ({ ...memberships[i], id: memberships[i].userId, membershipId: memberships[i].id, companyMembershipId: memberships[i].id });
const roles: string[] = [];
let fetchSpy: jest.SpyInstance, httpSpy: jest.SpyInstance, httpsSpy: jest.SpyInstance;
async function snapshot() {
  const result: any = {};
  for (const table of ["TariffPlan", "TariffRate", "TariffConfigurationVersion", "TariffPublicationDecision", "Order", "Invoice", "IntegrationOutbox", "Tracking", "AnalyticsDomainEventOutbox"])
    result[table] = (await pool.query('SELECT to_jsonb(t) AS row FROM "' + table + '" t ORDER BY to_jsonb(t)::text')).rows;
  return result;
}
async function plan(extra: any = {}) {
  const row = await mockPrisma.tariffPlan.create({ data: { tenantId: actor().tenantId, companyId: actor().companyId, name: "Synthetic tariff", serviceType: "DOOR_TO_DOOR", currency: "EUR",
    rates: { create: { zone: 1, weightFromKg: "0.01", weightToKg: "99.99", price: "1234567890.12" } }, ...extra } });
  return mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: row.id } });
}
function proposal(p: Awaited<ReturnType<typeof plan>>, user = actor()): any { return { user, planId: p.id, expectedGeneration: p.contentGeneration, operationId: randomUUID(), reason: "Synthetic publication" }; }
function approval(p: Awaited<ReturnType<typeof plan>>, v: any, user = actor(checker)): any { return { user, planId: p.id, versionId: v.id, operationId: randomUUID(), contentSha256: v.contentSha256, decision: "approved", reason: "Independent synthetic approval" }; }
beforeAll(async () => {
  const marker = (await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if (marker.length !== 1 || marker[0].runId !== run) throw Error("Ownership mismatch");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await persistTenantDemoFixture(client, fixture); await client.query("COMMIT"); } finally { await client.query("ROLLBACK"); client.release(); }
  mockPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 6, connectionTimeoutMillis: 3000, options }) });
  const permissions = await Promise.all(["pricing.tariffs.propose", "pricing.tariffs.approve", "pricing.read", "customers.read"].map(key => mockPrisma.permission.create({ data: { key, resource: "synthetic", action: "synthetic" } })));
  for (const m of memberships) {
    const role = await mockPrisma.role.create({ data: { code: randomUUID(), name: "Synthetic tariff authority", companyId: m.companyId } }); roles.push(role.id);
    for (const p of permissions) await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } });
    await mockPrisma.membershipRole.create({ data: { membershipId: m.id, roleId: role.id } });
    await mockPrisma.membershipScope.create({ data: { membershipId: m.id, scopeType: "company", scopeRefId: m.companyId } });
  }
  fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(Error("Provider network forbidden"));
  httpSpy = jest.spyOn(http, "request").mockImplementation(() => { throw Error("Provider HTTP forbidden"); });
  httpsSpy = jest.spyOn(https, "request").mockImplementation(() => { throw Error("Provider HTTPS forbidden"); });
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); expect(httpSpy).not.toHaveBeenCalled(); expect(httpsSpy).not.toHaveBeenCalled(); });
afterAll(async () => { fetchSpy?.mockRestore(); httpSpy?.mockRestore(); httpsSpy?.mockRestore(); await mockPrisma?.$disconnect(); await pool.end(); });

it("independent publication preserves exact stored money and currency without financial or downstream effects", async () => {
  const p = await plan(), before = await snapshot(), v = await propose(proposal(p)), a = approval(p, v);
  const result = await decide(a);
  expect(await decide(a)).toEqual(result);
  expect(await mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ approvedVersionId: v.id, approvedDecision: "approved", status: "active" });
  const frozen = await read(actor(), p.id, v.id);
  expect(frozen.content).toMatchObject({ currency: "EUR", rates: [{ price: "1234567890.12", weightFromKg: "0.01", weightToKg: "99.99" }] });
  expect(frozen.decision).toMatchObject({ decision: "approved" });
  const after = await snapshot();
  for (const table of ["Order", "Invoice", "IntegrationOutbox", "Tracking", "AnalyticsDomainEventOutbox", "TariffRate"]) expect(after[table]).toEqual(before[table]);
});
it("concurrent matching proposals and approvals create one immutable version and decision", async () => {
  const p = await plan(), intent = proposal(p), versions = await Promise.all(Array.from({ length: 4 }, () => propose(intent)));
  expect(new Set(versions.map(v => v.id)).size).toBe(1);
  const a = approval(p, versions[0]), results = await Promise.all(Array.from({ length: 4 }, () => decide(a)));
  expect(results.every(r => r.versionId === versions[0].id)).toBe(true);
  expect(await mockPrisma.tariffConfigurationVersion.count({ where: { planId: p.id } })).toBe(1);
  expect(await mockPrisma.tariffPublicationDecision.count({ where: { planId: p.id } })).toBe(1);
});
it("competing approval and rejection yield one terminal outcome, never two facts", async () => {
  const p = await plan(), v = await propose(proposal(p)), a = approval(p, v);
  const outcomes = await Promise.allSettled([decide(a), decide({ ...a, operationId: randomUUID(), decision: "rejected" })]);
  expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
  expect(await mockPrisma.tariffPublicationDecision.count({ where: { planId: p.id } })).toBe(1);
  const d = await mockPrisma.tariffPublicationDecision.findUniqueOrThrow({ where: { versionId: v.id } });
  expect((await mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: p.id } })).approvedVersionId).toBe(d.decision === "approved" ? v.id : null);
});
it("conflicting reuse, forged digest, self approval and input ownership create no facts", async () => {
  const p = await plan(), intent = proposal(p), v = await propose(intent), a = approval(p, v), before = await snapshot();
  for (const call of [
    () => propose({ ...intent, reason: "Other intention" }),
    () => propose({ ...intent, user: actor(checker) }),
    () => propose({ ...intent, tenantId: actor().tenantId } as any),
    () => decide({ ...a, user: actor() }),
    () => decide({ ...a, contentSha256: "0".repeat(64) }),
  ]) await expect(call()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  await decide(a);
  const confirmed = await snapshot();
  await expect(decide({ ...a, decision: "rejected" })).rejects.toThrow();
  expect(await snapshot()).toEqual(confirmed);
});
it("foreign tenant, same-tenant company, missing and forged contexts deny proposal, read and approval", async () => {
  const p = await plan(), v = await propose(proposal(p)), before = await snapshot();
  for (const user of [actor(1), actor(2), {}, { ...actor(), tenantMembershipId: actor(2).tenantMembershipId }]) {
    await expect(propose(proposal(p, user))).rejects.toThrow();
    await expect(read(user, p.id, v.id)).rejects.toThrow();
    await expect(decide(approval(p, v, user))).rejects.toThrow();
  }
  expect(await snapshot()).toEqual(before);
});
it("fresh permission, scope and membership revocation deny even confirmed receipts", async () => {
  const p = await plan(), intent = proposal(p), v = await propose(intent);
  const grant = await mockPrisma.rolePermission.findFirstOrThrow({ where: { roleId: roles[maker], permission: { key: "pricing.tariffs.propose" } } });
  await mockPrisma.rolePermission.delete({ where: { id: grant.id } });
  try { const before = await snapshot(); await expect(propose(intent)).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.rolePermission.create({ data: grant }); }
  const scope = await mockPrisma.membershipScope.findFirstOrThrow({ where: { membershipId: actor().companyMembershipId } });
  await mockPrisma.membershipScope.delete({ where: { id: scope.id } });
  try { const before = await snapshot(); await expect(read(actor(), p.id, v.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.membershipScope.create({ data: scope }); }
  await mockPrisma.companyMembership.update({ where: { id: actor().companyMembershipId }, data: { status: "suspended" } });
  try { const before = await snapshot(); await expect(propose(intent)).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.companyMembership.update({ where: { id: actor().companyMembershipId }, data: { status: "active" } }); }
});
it("rate change and restoration still invalidate pending approval while preserving the original receipt", async () => {
  const p = await plan(), intent = proposal(p), v = await propose(intent), rate = await mockPrisma.tariffRate.findFirstOrThrow({ where: { tariffPlanId: p.id } });
  await mockPrisma.tariffRate.update({ where: { id: rate.id }, data: { price: "1" } });
  await mockPrisma.tariffRate.update({ where: { id: rate.id }, data: { price: rate.price } });
  expect((await mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: p.id } })).contentGeneration).toBeGreaterThan(p.contentGeneration);
  const before = await snapshot();
  await expect(decide(approval(p, v))).rejects.toMatchObject({ code: "TARIFF_PUBLICATION_CONFLICT" });
  expect(await propose(intent)).toEqual(v);
  expect(await snapshot()).toEqual(before);
});
it("later publication records supersession and historical retry never rewinds the current pointer", async () => {
  const p = await plan(), v = await propose(proposal(p)), a = approval(p, v), first = await decide(a);
  await mockPrisma.tariffPlan.update({ where: { id: p.id }, data: { name: "Synthetic changed tariff" } });
  const current = await mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: p.id } }), v2 = await propose(proposal(current));
  expect(await decide(approval(current, v2))).toMatchObject({ previousVersionId: v.id });
  const before = await snapshot();
  expect(await decide(a)).toEqual(first);
  expect(await snapshot()).toEqual(before);
  expect((await mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: p.id } })).approvedVersionId).toBe(v2.id);
  await expect(pool.query('UPDATE "TariffPlan" SET "approvedVersionId"=$1 WHERE id=$2', [v.id, p.id])).rejects.toMatchObject({ code: "23514" });
});
it("rejection is immutable evidence and cannot activate a tariff", async () => {
  const p = await plan(), v = await propose(proposal(p)), a = { ...approval(p, v), decision: "rejected" as const };
  expect(await decide(a)).toMatchObject({ decision: "rejected" });
  expect(await decide(a)).toMatchObject({ decision: "rejected" });
  const before = await snapshot();
  await expect(decide({ ...a, operationId: randomUUID(), decision: "approved" })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect((await mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: p.id } })).approvedVersionId).toBeNull();
});
it("legacy active, unowned, linear and transit tariffs are not silently approved", async () => {
  const legacy = await plan({ status: "active" });
  expect(legacy.approvedVersionId).toBeNull();
  for (const extra of [{ priceType: "linear" }, { pricingStrategy: "LEG_TRANSIT", transitPricingConfig: { legs: [] } }, { tenantId: null, companyId: null }]) {
    const p = await plan(extra), before = await snapshot();
    await expect(propose(proposal(p))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
});
it("decision and pointer publication roll back together on injected publication failure", async () => {
  const p = await plan(), v = await propose(proposal(p)), before = await snapshot();
  await pool.query('CREATE FUNCTION cp_test_tariff_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'Synthetic rollback\'; END $$');
  await pool.query('CREATE TRIGGER cp_test_tariff_fail BEFORE UPDATE OF "approvedVersionId" ON "TariffPlan" FOR EACH ROW EXECUTE FUNCTION cp_test_tariff_fail()');
  try { await expect(decide(approval(p, v))).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  finally { await pool.query('DROP TRIGGER cp_test_tariff_fail ON "TariffPlan"; DROP FUNCTION cp_test_tariff_fail()'); }
});
it("lost commit acknowledgement is safely retried with the original intent", async () => {
  const p = await plan(), v = await propose(proposal(p)), a = approval(p, v);
  const transact = mockPrisma.$transaction.bind(mockPrisma);
  const spy = jest.spyOn(mockPrisma, "$transaction").mockImplementationOnce(async (...args: any[]) => {
    await (transact as any)(...args); throw Error("Synthetic lost acknowledgement after commit");
  });
  try { await expect(decide(a)).rejects.toThrow("Synthetic lost acknowledgement"); } finally { spy.mockRestore(); }
  const result = await decide(a), before = await snapshot();
  expect(await decide(a)).toEqual(result);
  expect(await snapshot()).toEqual(before);
  expect(await mockPrisma.tariffPublicationDecision.count({ where: { planId: p.id } })).toBe(1);
});
it("database constraints bind owner, maker and exact source; history and partial pointers cannot be changed", async () => {
  const p = await plan(), v = await propose(proposal(p)), a = approval(p, v);
  await decide(a);
  const before = await snapshot();
  for (const table of ["TariffConfigurationVersion", "TariffPublicationDecision"]) {
    const key = table === "TariffConfigurationVersion" ? "id" : "versionId";
    await expect(pool.query('UPDATE "' + table + '" SET reason=\'changed\' WHERE "' + key + '"=$1', [v.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query('DELETE FROM "' + table + '" WHERE "' + key + '"=$1', [v.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query('TRUNCATE "' + table + '" CASCADE')).rejects.toMatchObject({ code: "23514" });
  }
  await expect(pool.query('UPDATE "TariffPlan" SET "approvedDecision"=NULL WHERE id=$1', [p.id])).rejects.toMatchObject({ code: "23514" });
  await expect(pool.query('UPDATE "TariffPlan" SET "companyId"=$1 WHERE id=$2', [actor(1).companyId, p.id])).rejects.toMatchObject({ code: "23503" });
  await expect(mockPrisma.$transaction(async tx => { await tx.tariffRate.deleteMany({ where: { tariffPlanId: p.id } }); await tx.tariffPlan.delete({ where: { id: p.id } }); })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const q = await plan(), w = await propose(proposal(q)), source = await mockPrisma.tariffConfigurationVersion.findUniqueOrThrow({ where: { id: w.id } });
  const data: any = { versionId: w.id, planId: q.id, tenantId: q.tenantId, companyId: q.companyId, sourceGeneration: w.sourceGeneration, contentSha256: w.contentSha256, decision: "approved",
    makerUserId: source.actorUserId, actorUserId: actor(checker).id, companyMembershipId: actor(checker).companyMembershipId, tenantMembershipId: actor(checker).tenantMembershipId, operationId: randomUUID(), intentSha256: "a".repeat(64), reason: "Synthetic constraint probe" };
  const unchanged = await snapshot();
  for (const extra of [{ contentSha256: "b".repeat(64) }, { companyId: actor(1).companyId }, { tenantId: actor(2).tenantId }, { makerUserId: actor(0).id }, { actorUserId: source.actorUserId, companyMembershipId: source.companyMembershipId, tenantMembershipId: source.tenantMembershipId }])
    await expect(mockPrisma.tariffPublicationDecision.create({ data: { ...data, ...extra } })).rejects.toThrow();
  expect(await snapshot()).toEqual(unchanged);
});
it("disabled tenant and company deny new work without effects", async () => {
  const p = await plan();
  await mockPrisma.tenant.update({ where: { id: actor().tenantId }, data: { status: "suspended" } });
  try { const before = await snapshot(); await expect(propose(proposal(p))).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.tenant.update({ where: { id: actor().tenantId }, data: { status: "active" } }); }
  await mockPrisma.organization.update({ where: { id: actor().companyId }, data: { isActive: false } });
  try { const before = await snapshot(); await expect(propose(proposal(p))).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.organization.update({ where: { id: actor().companyId }, data: { isActive: true } }); }
});
it("owned customer and template references are freshly scoped and frozen; changed template content cannot be approved", async () => {
  const template = await mockPrisma.routeTemplate.create({ data: { companyId: actor().companyId, name: "Synthetic route", legs: { create: { sequence: 1, legCode: "synthetic-leg" } } } });
  const p = await plan({ customerEntityId: fixture.customers[0].id, routeTemplateId: template.id }), v = await propose(proposal(p));
  expect((await read(actor(), p.id, v.id)).content).toMatchObject({ customerEntityId: fixture.customers[0].id, routeTemplate: { id: template.id, legs: [{ legCode: "synthetic-leg" }] } });
  await mockPrisma.routeTemplate.update({ where: { id: template.id }, data: { name: "Changed route" } });
  const before = await snapshot();
  await expect(decide(approval(p, v))).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const grant = await mockPrisma.rolePermission.findFirstOrThrow({ where: { roleId: roles[maker], permission: { key: "customers.read" } } });
  await mockPrisma.rolePermission.delete({ where: { id: grant.id } });
  try { await expect(read(actor(), p.id, v.id)).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  finally { await mockPrisma.rolePermission.create({ data: grant }); }
  await expect(plan({ customerEntityId: fixture.customers[1].id })).rejects.toThrow();
  await expect(plan({ routeTemplateId: (await mockPrisma.routeTemplate.create({ data: { companyId: actor(1).companyId, name: "Foreign company route" } })).id })).rejects.toThrow();
});
it("revocation during an authoring lock wait is rechecked before accepting a proposal", async () => {
  const p = await plan(), holder = await pool.connect(), grant = await mockPrisma.rolePermission.findFirstOrThrow({ where: { roleId: roles[maker], permission: { key: "pricing.tariffs.propose" } } });
  let pending: Promise<any> | undefined, removed = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [actor().tenantId + ":tariff-authoring:" + actor().companyId]);
    pending = propose(proposal(p)).then(value => ({ value }), error => ({ error }));
    const deadline = Date.now() + 1500;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') AS waiting")).rows[0].waiting;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await mockPrisma.rolePermission.delete({ where: { id: grant.id } }); removed = true;
    const before = await snapshot();
    await holder.query("ROLLBACK");
    expect((await pending).error).toBeDefined();
    expect(await snapshot()).toEqual(before);
  } finally {
    await holder.query("ROLLBACK"); holder.release();
    await pending;
    if (removed) await mockPrisma.rolePermission.create({ data: grant });
  }
});
it("catalog evidence matches selected Prisma targets, owner keys, restricted relationships and immutable triggers", async () => {
  const constraints = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid IN (to_regclass($1),to_regclass($2),to_regclass($3))", ['"TariffPlan"', '"TariffConfigurationVersion"', '"TariffPublicationDecision"'])).rows.map(r => r.conname);
  expect(constraints).toEqual(expect.arrayContaining(["TariffPlan_version_owner_key", "TariffPlan_approved_pointer_fkey", "TariffVersion_operation_key", "TariffVersion_generation_key", "TariffVersion_content_key", "TariffVersion_actor_fkey", "TariffVersion_bridge_fkey", "TariffDecision_maker_fkey", "TariffDecision_content_fkey", "TariffDecision_separation_check"]));
  const foreignKeys = (await pool.query("SELECT confdeltype,confupdtype FROM pg_constraint WHERE conrelid IN (to_regclass($1),to_regclass($2)) AND contype='f'", ['"TariffConfigurationVersion"', '"TariffPublicationDecision"'])).rows;
  expect(foreignKeys).toHaveLength(8);
  expect(foreignKeys.every(r => r.confdeltype === "r" && r.confupdtype === "r")).toBe(true);
  const defaults = (await pool.query("SELECT table_name,column_name,column_default FROM information_schema.columns WHERE table_name IN ('TariffConfigurationVersion','TariffPublicationDecision') AND column_name IN ('proposedAt','decidedAt')")).rows;
  expect(defaults).toHaveLength(2);
  expect(defaults.every(r => r.column_default.includes("CURRENT_TIMESTAMP"))).toBe(true);
});
