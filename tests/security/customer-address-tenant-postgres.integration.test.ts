import { Pool, PoolClient } from "pg";
import { createTenantDemoFixture, TENANT_DEMO_IDS } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";

const connectionString = process.env.CARGOPILOT_CUSTOMER_ADDRESS_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CARGOPILOT_CUSTOMER_ADDRESS_TEST_DATABASE_URL is required");
const target = new URL(connectionString);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_customer_it"
  || target.pathname !== "/cp_customer_it") {
  throw new Error("Refusing a PostgreSQL target outside the disposable customer test instance");
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 1_000 });

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

afterAll(async () => pool.end());

it("enforces exact customer ownership for new and updated default-address relationships", async () => {
  await inRollbackTransaction(async (client) => {
    const customerId = TENANT_DEMO_IDS.customers.transAsia;
    const validAddressId = TENANT_DEMO_IDS.addresses.transAsiaSender;
    const otherCustomerId = "019b1000-0000-7000-8b00-000000000001";
    const otherAddressId = "019b1000-0000-7000-8b00-000000000002";
    await client.query(`
      INSERT INTO "CustomerEntity" ("id", "tenantId", "name", "createdAt", "updatedAt")
      VALUES ($1, $2, 'Synthetic other customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [otherCustomerId, TENANT_DEMO_IDS.tenants.transAsia]);
    await client.query(`
      INSERT INTO "Address" ("id", "tenantId", "customerEntityId", "addressLine1", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'Synthetic other address', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [otherAddressId, TENANT_DEMO_IDS.tenants.transAsia, otherCustomerId]);

    await client.query(`UPDATE "CustomerEntity" SET "defaultAddressId" = $1 WHERE "id" = $2`,
      [validAddressId, customerId]);
    const before = await client.query(`SELECT "defaultAddressId" FROM "CustomerEntity" WHERE "id" = $1`,
      [customerId]);
    expect(before.rows[0].defaultAddressId).toBe(validAddressId);

    await client.query("SAVEPOINT wrong_customer");
    let sqlState: string | undefined;
    try {
      await client.query(`UPDATE "CustomerEntity" SET "defaultAddressId" = $1 WHERE "id" = $2`,
        [otherAddressId, customerId]);
    } catch (error) {
      sqlState = (error as { code?: string }).code;
    }
    await client.query("ROLLBACK TO SAVEPOINT wrong_customer");
    expect(sqlState).toBe("23503");
    const after = await client.query(`SELECT "defaultAddressId" FROM "CustomerEntity" WHERE "id" = $1`,
      [customerId]);
    expect(after.rows[0].defaultAddressId).toBe(validAddressId);
  });
});
