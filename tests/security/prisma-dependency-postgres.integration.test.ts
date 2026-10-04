// Explicitly owned disposable database only; no application configuration import.
import { Pool } from "pg";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createTenantDemoFixture } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL;
const run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable Prisma identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" ||
    target.password !== "synthetic-worker-only" || target.pathname !== `/cp_worker_${run}`) {
  throw Error("Refusing an existing database endpoint");
}
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 1000, options: "-c statement_timeout=5000 -c lock_timeout=2000" });
const fixture = createTenantDemoFixture();
let db: PrismaClient;
beforeAll(async () => {
  const marker = (await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if (marker.length !== 1 || marker[0].runId !== run) throw Error("Disposable marker mismatch");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await persistTenantDemoFixture(client, fixture); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4,
    connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
    options: "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000" }) });
}, 60000);
afterAll(async () => { await db?.$disconnect(); await pool.end(); });

it("upgraded client reads tenant-owned nested relations and exact invoice decimals", async () => {
  const source = fixture.invoices[1];
  const invoice = await db.invoice.findFirstOrThrow({ where: { id: source.id, tenantId: source.tenantId, companyId: source.companyId },
    select: { id: true, amount: true, currency: true, tenantId: true, companyId: true,
      order: { select: { id: true, tenantId: true, ownerOrgId: true } } } });
  expect(invoice.amount.toFixed(4)).toBe(new Prisma.Decimal(source.amount).toFixed(4));
  expect(invoice.currency).toBe(source.currency);
  expect(invoice.order).toEqual({ id: source.orderId, tenantId: source.tenantId, ownerOrgId: source.companyId });
});
it("adapter preserves parameterized BigInt Decimal DateTime and JSON round trips", async () => {
  const integer = 9007199254740993n, money = new Prisma.Decimal("12345678901234567890.1234");
  const time = new Date("2026-10-04T12:00:00.000Z");
  const rows = await db.$queryRaw<any[]>(Prisma.sql`SELECT ${integer}::bigint AS value,
    ${money}::numeric(24,4) AS money, ${time}::timestamptz AS time,
    ${JSON.stringify({ synthetic: true })}::jsonb AS payload`);
  expect(rows).toHaveLength(1); expect(rows[0].value).toBe(integer);
  expect(rows[0].money.toFixed(4)).toBe(money.toFixed(4));
  expect(rows[0].time).toEqual(time); expect(rows[0].payload).toEqual({ synthetic: true });
});
it("unique and compound foreign-key errors retain codes and rejected writes leave records unchanged", async () => {
  const code = `synthetic-prisma-${run}`;
  await db.tenant.create({ data: { code, name: "Synthetic unique test" } });
  await expect(db.tenant.create({ data: { code, name: "Conflicting synthetic name" } })).rejects.toMatchObject({ code: "P2002" });
  expect(await db.tenant.count({ where: { code } })).toBe(1);
  const address = fixture.addresses[0];
  const before = await db.address.findUniqueOrThrow({ where: { id: address.id } });
  await expect(db.address.update({ where: { id: address.id }, data: { tenantId: fixture.tenants[1].id } })).rejects.toMatchObject({ code: "P2003" });
  expect(await db.address.findUniqueOrThrow({ where: { id: address.id } })).toEqual(before);
});
it("interactive transaction rollback leaves no partially created record", async () => {
  const code = `synthetic-rollback-${run}`;
  await expect(db.$transaction(async tx => {
    await tx.tenant.create({ data: { code, name: "Synthetic rollback test" } });
    throw Error("Injected synthetic transaction failure");
  }, { timeout: 10000, maxWait: 2000 })).rejects.toThrow("Injected synthetic transaction failure");
  expect(await db.tenant.findUnique({ where: { code } })).toBeNull();
});
