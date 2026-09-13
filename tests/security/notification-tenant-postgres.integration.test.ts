import { Pool, PoolClient } from "pg";
import { createTenantDemoFixture, TENANT_DEMO_IDS } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";

const connectionString = process.env.CARGOPILOT_NOTIFICATION_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CARGOPILOT_NOTIFICATION_TEST_DATABASE_URL is required");
const target = new URL(connectionString);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_notification_it"
  || target.pathname !== "/cp_notification_it") {
  throw new Error("Refusing a PostgreSQL target outside the disposable notification test instance");
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 1_000 });
const FIXED_TIME = new Date("2026-09-13T12:00:00.000Z");

async function inRollbackTransaction(run: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function expectSqlState(client: PoolClient, savepoint: string, sql: string,
  values: unknown[], expectedCode: string) {
  await client.query(`SAVEPOINT ${savepoint}`);
  let code: string | undefined;
  try {
    await client.query(sql, values);
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  expect(code).toBe(expectedCode);
}

const insertSql = `
  INSERT INTO "UserNotification"
    ("id", "userId", "tenantId", "companyId", "companyMembershipId", "type",
     "title", "body", "orderId", "createdAt")
  VALUES ($1, $2, $3, $4, $5, 'order'::"NotificationType", 'Synthetic', 'Synthetic', $6, $7)
`;

afterAll(async () => {
  await pool.end();
});

it("accepts valid ownership, retains legacy rows as unowned, and rejects invalid ownership tuples", async () => {
  await inRollbackTransaction(async (client) => {
    const validId = "019b0000-0000-7000-8b00-000000000001";
    await client.query(insertSql, [validId, TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.tenants.transAsia, TENANT_DEMO_IDS.organizations.transAsiaUz,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz,
      TENANT_DEMO_IDS.orders.transAsiaUz, FIXED_TIME]);

    await expectSqlState(client, "partial_owner", insertSql, [
      "019b0000-0000-7000-8b00-000000000002", TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.tenants.transAsia, null, null, null, FIXED_TIME,
    ], "23514");
    await expectSqlState(client, "wrong_company_membership", insertSql, [
      "019b0000-0000-7000-8b00-000000000003", TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.tenants.transAsia, TENANT_DEMO_IDS.organizations.transAsiaUz,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaDe,
      TENANT_DEMO_IDS.orders.transAsiaUz, FIXED_TIME,
    ], "23503");
    await expectSqlState(client, "cross_tenant_order", insertSql, [
      "019b0000-0000-7000-8b00-000000000004", TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.tenants.unrelated, TENANT_DEMO_IDS.organizations.unrelated,
      TENANT_DEMO_IDS.companyMemberships.multiUnrelated,
      TENANT_DEMO_IDS.orders.transAsiaUz, FIXED_TIME,
    ], "23503");
    await expectSqlState(client, "wrong_recipient", insertSql, [
      "019b0000-0000-7000-8b00-000000000005", TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.tenants.transAsia, TENANT_DEMO_IDS.organizations.transAsiaUz,
      TENANT_DEMO_IDS.companyMemberships.makerTransAsiaUz,
      TENANT_DEMO_IDS.orders.transAsiaUz, FIXED_TIME,
    ], "23503");

    const legacyId = "019b0000-0000-7000-8b00-000000000006";
    await client.query(`
      INSERT INTO "UserNotification" ("id", "userId", "type", "title", "body", "createdAt")
      VALUES ($1, $2, 'system'::"NotificationType", 'Legacy', 'Legacy', $3)
    `, [legacyId, TENANT_DEMO_IDS.users.multiTenant, FIXED_TIME]);
    const visible = await client.query(`
      SELECT "id" FROM "UserNotification"
      WHERE "userId" = $1 AND "tenantId" = $2 AND "companyId" = $3 AND "companyMembershipId" = $4
      ORDER BY "id"
    `, [TENANT_DEMO_IDS.users.multiTenant, TENANT_DEMO_IDS.tenants.transAsia,
      TENANT_DEMO_IDS.organizations.transAsiaUz, TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz]);
    expect(visible.rows.map((row) => row.id)).toEqual([validId]);
  });
});

it("rejects cross-context ownership updates and leaves the notification unchanged", async () => {
  await inRollbackTransaction(async (client) => {
    const validId = "019b0000-0000-7000-8b00-000000000007";
    await client.query(insertSql, [validId, TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.tenants.transAsia, TENANT_DEMO_IDS.organizations.transAsiaUz,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz,
      TENANT_DEMO_IDS.orders.transAsiaUz, FIXED_TIME]);

    await expectSqlState(client, "invalid_owner_update", `
      UPDATE "UserNotification"
      SET "companyId" = $2, "companyMembershipId" = $3
      WHERE "id" = $1
    `, [validId, TENANT_DEMO_IDS.organizations.transAsiaDe,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaDe], "23503");

    const unchanged = await client.query(`
      SELECT "tenantId", "companyId", "companyMembershipId" FROM "UserNotification" WHERE "id" = $1
    `, [validId]);
    expect(unchanged.rows[0]).toEqual({
      tenantId: TENANT_DEMO_IDS.tenants.transAsia,
      companyId: TENANT_DEMO_IDS.organizations.transAsiaUz,
      companyMembershipId: TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz,
    });
  });
});
