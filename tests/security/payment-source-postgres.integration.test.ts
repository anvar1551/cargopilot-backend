import { Pool, PoolClient } from "pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL;
const run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable run identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${run}`) throw Error("Refusing existing database");
const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000 -c lock_timeout=4000" });
const fixture = createTenantDemoFixture();
const configs = new Map<string, string>();
const intents = new Map<string, any>();
const mutationIntents = new Map<string, any>();
const local = fixture.orders.find(o => o.id === ids.orders.transAsiaUz)!;

async function insert(client: Pool | PoolClient, table: string, row: Record<string, unknown>) {
  // Table/columns are fixed test source, never HTTP inputs.
  const fields = Object.keys(row);
  return (await client.query(`INSERT INTO "${table}" (${fields.map(k => `"${k}"`).join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, Object.values(row))).rows[0];
}
function intent(order = local, config = configs.get(order.ownerOrgId)!) {
  return { id: randomUUID(), companyId: order.ownerOrgId, orderId: order.id, providerConfigId: config, provider: "STRIPE", environment: "TEST", currency: "USD", amountMinor: "9007199254740993", idempotencyKey: randomUUID(), updatedAt: new Date("2026-01-01") };
}
function refund(source: any) {
  return { id: randomUUID(), paymentIntentId: source.id, companyId: source.companyId, orderId: source.orderId, provider: source.provider, environment: source.environment, currency: source.currency, amountMinor: "1", requestedByUserId: ids.users.multiTenant, idempotencyKey: randomUUID(), updatedAt: new Date("2026-01-01") };
}
function ledger(source: any) {
  return { id: randomUUID(), paymentIntentId: source.id, companyId: source.companyId, orderId: source.orderId, provider: source.provider, currency: source.currency, amountMinor: source.amountMinor, entryType: "payment" };
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ["PaymentIntent", "PaymentRefund", "PaymentLedgerEntry", "PaymentProviderConfig", "Order", "FinanceAuditEvent", "FinanceDomainEventOutbox"]) result[table] = (await pool.query(`SELECT * FROM "${table}" ORDER BY id`)).rows;
  return result;
}
async function rejected(work: (client: PoolClient) => Promise<unknown>, constraint: string) {
  const before = await snapshot(), client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('INSERT INTO "FinanceAuditEvent" ("legalEntityId",action) VALUES ($1,$2)', [fixture.financeLegalEntities.find(e => e.companyId === local.ownerOrgId)!.id, "synthetic-rollback"]);
    await insert(client, "FinanceDomainEventOutbox", { legalEntityId: fixture.financeLegalEntities.find(e => e.companyId === local.ownerOrgId)!.id, aggregateType: "synthetic", aggregateId: local.id, eventType: "synthetic.rejected", occurredAt: new Date(), payloadJson: {}, updatedAt: new Date() });
    await expect(work(client)).rejects.toMatchObject({ code: "23503", constraint });
  } finally { await client.query("ROLLBACK"); client.release(); }
  expect(await snapshot()).toEqual(before);
}
beforeAll(async () => {
  const marker = (await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if (marker.length !== 1 || marker[0].runId !== run) throw Error("Disposable storage ownership mismatch");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await persistTenantDemoFixture(client, fixture); await client.query("COMMIT"); }
  finally { await client.query("ROLLBACK"); client.release(); }
  for (const order of fixture.orders) {
    const config = await insert(pool, "PaymentProviderConfig", { companyId: order.ownerOrgId, provider: "STRIPE", environment: "TEST", secretEncrypted: "synthetic-not-a-credential", secretMasked: "synthetic", callbackPath: "/synthetic", updatedAt: new Date() });
    configs.set(order.ownerOrgId, config.id);
    intents.set(order.ownerOrgId, await insert(pool, "PaymentIntent", intent(order)));
    // Separate parent rows expose the parent's own FK rather than a child's
    // earlier retarget restriction. Do not loosen the named-constraint assertion.
    mutationIntents.set(order.ownerOrgId, await insert(pool, "PaymentIntent", intent(order)));
    await insert(pool, "PaymentRefund", refund(intents.get(order.ownerOrgId)));
    await insert(pool, "PaymentLedgerEntry", ledger(intents.get(order.ownerOrgId)));
  }
});
afterAll(async () => { await pool.end(); });

it("valid two-tenant/three-company source tuples preserve exact integers and separate legal entities", async () => {
  for (const order of fixture.orders) {
    const source = intents.get(order.ownerOrgId)!;
    expect(source.amountMinor).toBe("9007199254740993");
    const r = (await pool.query('SELECT * FROM "PaymentRefund" WHERE "paymentIntentId"=$1', [source.id])).rows[0];
    const l = (await pool.query('SELECT * FROM "PaymentLedgerEntry" WHERE "paymentIntentId"=$1', [source.id])).rows[0];
    expect(r.companyId).toBe(order.ownerOrgId); expect(l.amountMinor).toBe(source.amountMinor);
    expect(fixture.financeLegalEntities.find(e => e.companyId === source.companyId)?.tenantId).toBe(order.tenantId);
  }
});
it.each([ids.organizations.unrelated, ids.organizations.transAsiaDe])("foreign company %s order/config inserts and updates reject with complete rollback", async company => {
  const source = mutationIntents.get(local.ownerOrgId)!;
  const foreign = fixture.orders.find(o => o.ownerOrgId === company)!;
  await rejected(c => insert(c, "PaymentIntent", { ...intent(), orderId: foreign.id }), "PaymentIntent_order_owner_fkey");
  await rejected(c => c.query('UPDATE "PaymentIntent" SET "orderId"=$1 WHERE id=$2', [foreign.id, source.id]), "PaymentIntent_order_owner_fkey");
  await rejected(c => insert(c, "PaymentIntent", intent(local, configs.get(company))), "PaymentIntent_provider_context_fkey");
  await rejected(c => c.query('UPDATE "PaymentIntent" SET "providerConfigId"=$1 WHERE id=$2', [configs.get(company), source.id]), "PaymentIntent_provider_context_fkey");
});
it("provider/environment mismatches reject at insertion and retarget; source config cannot be rewritten", async () => {
  const source = mutationIntents.get(local.ownerOrgId)!;
  for (const change of [{ provider: "CLICK" }, { environment: "PRODUCTION" }]) {
    await rejected(c => insert(c, "PaymentIntent", { ...intent(), ...change }), "PaymentIntent_provider_context_fkey");
    const field = Object.keys(change)[0];
    await rejected(c => c.query(`UPDATE "PaymentIntent" SET "${field}"=$1 WHERE id=$2`, [Object.values(change)[0], source.id]), "PaymentIntent_provider_context_fkey");
  }
  await rejected(c => c.query('UPDATE "PaymentProviderConfig" SET environment=\'PRODUCTION\' WHERE id=$1', [configs.get(local.ownerOrgId)]), "PaymentIntent_provider_context_fkey");
});
it("refund intent/order/company/provider/environment/currency inserts and updates reject mismatches", async () => {
  const source = intents.get(local.ownerOrgId)!;
  const existing = (await pool.query('SELECT * FROM "PaymentRefund" WHERE "paymentIntentId"=$1', [source.id])).rows[0];
  const changes = [{ paymentIntentId: intents.get(ids.organizations.unrelated).id }, { orderId: ids.orders.transAsiaDe }, { companyId: ids.organizations.transAsiaDe }, { provider: "CLICK" }, { environment: "PRODUCTION" }, { currency: "UZS" }];
  for (const change of changes) {
    await rejected(c => insert(c, "PaymentRefund", { ...refund(source), ...change }), "PaymentRefund_intent_context_fkey");
    const field = Object.keys(change)[0];
    await rejected(c => c.query(`UPDATE "PaymentRefund" SET "${field}"=$1 WHERE id=$2`, [Object.values(change)[0], existing.id]), "PaymentRefund_intent_context_fkey");
  }
});
it("ledger source mismatch inserts and updates reject without financial/audit/outbox effects", async () => {
  const source = intents.get(local.ownerOrgId)!;
  const existing = (await pool.query('SELECT * FROM "PaymentLedgerEntry" WHERE "paymentIntentId"=$1', [source.id])).rows[0];
  for (const change of [{ paymentIntentId: intents.get(ids.organizations.transAsiaDe).id }, { orderId: ids.orders.unrelated }, { companyId: ids.organizations.transAsiaDe }, { provider: "CLICK" }, { currency: "UZS" }]) {
    await rejected(c => insert(c, "PaymentLedgerEntry", { ...ledger(source), ...change }), "PaymentLedgerEntry_intent_context_fkey");
    const field = Object.keys(change)[0];
    await rejected(c => c.query(`UPDATE "PaymentLedgerEntry" SET "${field}"=$1 WHERE id=$2`, [Object.values(change)[0], existing.id]), "PaymentLedgerEntry_intent_context_fkey");
  }
});
it("catalog matches four NOT VALID compound paths; required source columns have no null bypass", async () => {
  const names = ["PaymentIntent_order_owner_fkey", "PaymentIntent_provider_context_fkey", "PaymentRefund_intent_context_fkey", "PaymentLedgerEntry_intent_context_fkey"];
  const rows = (await pool.query('SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=ANY($1)', [names])).rows;
  expect(rows).toHaveLength(4); for (const row of rows) { expect(row.convalidated).toBe(false); expect(row.definition).toContain("ON UPDATE RESTRICT ON DELETE RESTRICT"); }
  const nullable = (await pool.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) AND column_name=ANY($2) AND is_nullable='YES'`, [["PaymentRefund", "PaymentIntent", "PaymentLedgerEntry"], ["companyId", "orderId", "paymentIntentId", "providerConfigId", "provider", "environment", "currency"]])).rows;
  expect(nullable).toEqual([]);
});
it("concurrent config retarget waits on accepted source key then rejects after commit", async () => {
  const config = await insert(pool, "PaymentProviderConfig", { companyId: local.ownerOrgId, provider: "PAYME", environment: "TEST", secretEncrypted: "synthetic", secretMasked: "synthetic", callbackPath: "/synthetic", updatedAt: new Date() });
  const first = await pool.connect(), second = await pool.connect(); let committed = false;
  try {
    await first.query("BEGIN"); await insert(first, "PaymentIntent", { ...intent(local, config.id), provider: "PAYME" });
    await second.query("BEGIN"); const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    // Catch immediately: a failure cannot become an unhandled rejection while observing the lock.
    const competing = second.query('UPDATE "PaymentProviderConfig" SET environment=\'PRODUCTION\' WHERE id=$1', [config.id]).then(() => ({ error: null }), error => ({ error }));
    const deadline = Date.now() + 2500; let blocked = false;
    while (Date.now() < deadline) { blocked = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type === "Lock"; if (blocked) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    expect(blocked).toBe(true); await first.query("COMMIT"); committed = true;
    expect((await competing).error).toMatchObject({ code: "23503", constraint: "PaymentIntent_provider_context_fkey" });
    await second.query("ROLLBACK");
    expect((await pool.query('SELECT environment FROM "PaymentProviderConfig" WHERE id=$1', [config.id])).rows[0].environment).toBe("TEST");
    expect((await pool.query('SELECT count(*)::int AS count FROM "PaymentIntent" WHERE "providerConfigId"=$1', [config.id])).rows[0].count).toBe(1);
  } finally { if (!committed) await first.query("ROLLBACK"); await second.query("ROLLBACK"); first.release(); second.release(); }
});
