import { Pool, PoolClient } from "pg";
import { createTenantDemoFixture, TENANT_DEMO_IDS } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";

const connectionString = process.env.CARGOPILOT_PRICING_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CARGOPILOT_PRICING_TEST_DATABASE_URL is required");
const target = new URL(connectionString);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_pricing_it"
  || target.pathname !== "/cp_pricing_it") {
  throw new Error("Refusing a PostgreSQL target outside the disposable pricing test instance");
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 1_000 });

const ids = {
  routeUz: "019b2000-0000-7000-8b00-000000000001",
  routeDe: "019b2000-0000-7000-8b00-000000000002",
  routeUnrelated: "019b2000-0000-7000-8b00-000000000003",
  plan: "019b2000-0000-7000-8b00-000000000010",
  planDe: "019b2000-0000-7000-8b00-000000000017",
};

async function inRollbackTransaction(run: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await client.query(`
      INSERT INTO "RouteTemplate" ("id", "companyId", "name", "createdAt", "updatedAt")
      VALUES
        ($1, $4, 'Synthetic UZ route', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($2, $5, 'Synthetic DE route', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $6, 'Synthetic unrelated route', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [ids.routeUz, ids.routeDe, ids.routeUnrelated,
      TENANT_DEMO_IDS.organizations.transAsiaUz,
      TENANT_DEMO_IDS.organizations.transAsiaDe,
      TENANT_DEMO_IDS.organizations.unrelated]);
    await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function rejectedSqlState(client: PoolClient, name: string, run: () => Promise<unknown>) {
  await client.query(`SAVEPOINT ${name}`);
  let sqlState: string | undefined;
  try {
    await run();
  } catch (error) {
    sqlState = (error as { code?: string }).code;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  return sqlState;
}

function insertPlan(client: PoolClient, values: {
  id: string;
  tenantId: string | null;
  companyId: string | null;
  customerEntityId?: string | null;
  routeTemplateId?: string | null;
}) {
  return client.query(`
    INSERT INTO "TariffPlan"
      ("id", "tenantId", "companyId", "name", "status", "serviceType", "priceType",
       "pricingStrategy", "coverageType", "transportMode", "currency", "customerEntityId",
       "routeTemplateId", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, 'Synthetic tenant tariff', 'active', 'DOOR_TO_DOOR', 'bucket',
      'FIXED_LANE', 'domestic', 'ROAD', 'UZS', $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [values.id, values.tenantId, values.companyId,
    values.customerEntityId ?? null, values.routeTemplateId ?? null]);
}

afterAll(async () => pool.end());

it("enforces populated tariff tenant, company, customer and route ownership on inserts and updates", async () => {
  await inRollbackTransaction(async (client) => {
    const tenantA = TENANT_DEMO_IDS.tenants.transAsia;
    const companyUz = TENANT_DEMO_IDS.organizations.transAsiaUz;
    const companyDe = TENANT_DEMO_IDS.organizations.transAsiaDe;
    const companyB = TENANT_DEMO_IDS.organizations.unrelated;
    const customerA = TENANT_DEMO_IDS.customers.transAsia;
    const customerB = TENANT_DEMO_IDS.customers.unrelated;

    await insertPlan(client, {
      id: ids.plan,
      tenantId: tenantA,
      companyId: companyUz,
      customerEntityId: customerA,
      routeTemplateId: ids.routeUz,
    });
    const valid = await client.query(
      `SELECT "tenantId", "companyId", "customerEntityId", "routeTemplateId"
       FROM "TariffPlan" WHERE "id" = $1`, [ids.plan],
    );
    expect(valid.rows[0]).toEqual({
      tenantId: tenantA,
      companyId: companyUz,
      customerEntityId: customerA,
      routeTemplateId: ids.routeUz,
    });

    await insertPlan(client, {
      id: ids.planDe,
      tenantId: tenantA,
      companyId: companyDe,
      customerEntityId: customerA,
      routeTemplateId: ids.routeDe,
    });

    expect(await rejectedSqlState(client, "partial_owner", () => insertPlan(client, {
      id: "019b2000-0000-7000-8b00-000000000011", tenantId: tenantA, companyId: null,
    }))).toBe("23514");
    expect(await rejectedSqlState(client, "cross_tenant_company", () => insertPlan(client, {
      id: "019b2000-0000-7000-8b00-000000000012", tenantId: tenantA, companyId: companyB,
    }))).toBe("23503");
    expect(await rejectedSqlState(client, "cross_tenant_customer", () => insertPlan(client, {
      id: "019b2000-0000-7000-8b00-000000000013", tenantId: tenantA, companyId: companyUz,
      customerEntityId: customerB,
    }))).toBe("23503");
    expect(await rejectedSqlState(client, "cross_company_route", () => insertPlan(client, {
      id: "019b2000-0000-7000-8b00-000000000014", tenantId: tenantA, companyId: companyUz,
      routeTemplateId: ids.routeDe,
    }))).toBe("23503");
    expect(await rejectedSqlState(client, "cross_tenant_route", () => insertPlan(client, {
      id: "019b2000-0000-7000-8b00-000000000015", tenantId: tenantA, companyId: companyUz,
      routeTemplateId: ids.routeUnrelated,
    }))).toBe("23503");

    expect(await rejectedSqlState(client, "update_company", () => client.query(
      `UPDATE "TariffPlan" SET "companyId" = $1 WHERE "id" = $2`, [companyDe, ids.plan],
    ))).toBe("23503");
    expect(await rejectedSqlState(client, "update_customer", () => client.query(
      `UPDATE "TariffPlan" SET "customerEntityId" = $1 WHERE "id" = $2`, [customerB, ids.plan],
    ))).toBe("23503");

    const unchanged = await client.query(
      `SELECT "tenantId", "companyId", "customerEntityId", "routeTemplateId"
       FROM "TariffPlan" WHERE "id" = $1`, [ids.plan],
    );
    expect(unchanged.rows[0]).toEqual(valid.rows[0]);
    expect(await client.query(`SELECT count(*)::int AS count FROM "TariffPlan"`))
      .toMatchObject({ rows: [{ count: 2 }] });

    // Transitional compatibility remains explicit: a completely unowned legacy row is accepted.
    await insertPlan(client, {
      id: "019b2000-0000-7000-8b00-000000000016", tenantId: null, companyId: null,
    });
    expect(await client.query(
      `SELECT count(*)::int AS count FROM "TariffPlan" WHERE "tenantId" IS NULL`,
    )).toMatchObject({ rows: [{ count: 1 }] });

  });
});
