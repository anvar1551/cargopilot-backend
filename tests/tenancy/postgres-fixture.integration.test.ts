import { Pool, PoolClient } from "pg";
import { createTenantDemoFixture, TENANT_DEMO_IDS } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "./postgres-fixture.persistence";

const connectionString = process.env.CARGOPILOT_TENANCY_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CARGOPILOT_TENANCY_TEST_DATABASE_URL is required");
const target = new URL(connectionString);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_it" || target.pathname !== "/cp_tenant_it") {
  throw new Error("Refusing a PostgreSQL target outside the disposable tenant test instance");
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 1_000 });

async function inRollbackTransaction(run: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function expectSqlState(
  client: PoolClient,
  savepoint: string,
  sql: string,
  values: unknown[],
  expectedCode: string,
): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);
  let observedCode: string | undefined;
  try {
    await client.query(sql, values);
  } catch (error) {
    observedCode = (error as { code?: string }).code;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  expect(observedCode).toBe(expectedCode);
}

afterAll(async () => {
  await pool.end();
});

it("persists the complete valid synthetic fixture", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    const counts = await client.query(`
      SELECT
        (SELECT count(*)::int FROM "Tenant") AS tenants,
        (SELECT count(*)::int FROM "TenantMembership") AS tenant_memberships,
        (SELECT count(*)::int FROM "CompanyMembership") AS company_memberships,
        (SELECT count(*)::int FROM "Order") AS orders,
        (SELECT count(*)::int FROM "Invoice") AS invoices
    `);
    expect(counts.rows[0]).toEqual({ tenants: 2, tenant_memberships: 4, company_memberships: 5, orders: 3, invoices: 3 });
    const transAsiaEntities = await client.query(`
      SELECT count(DISTINCT i."companyId")::int AS companies
      FROM "Invoice" i JOIN "Order" o ON o."id" = i."orderId"
      WHERE i."tenantId" = $1 AND i."companyId" = o."ownerOrgId"
    `, [TENANT_DEMO_IDS.tenants.transAsia]);
    expect(transAsiaEntities.rows[0]).toEqual({ companies: 2 });
  });
});

it("installs every tenant ownership constraint and its order ownership target as validated", async () => {
  await inRollbackTransaction(async (client) => {
    const expectedConstraints: Record<string, string> = {
      Address_tenant_customer_fkey: `FOREIGN KEY ("tenantId", "customerEntityId") REFERENCES "CustomerEntity"`,
      CompanyMembership_tenant_company_fkey: `FOREIGN KEY ("tenantId", "companyId") REFERENCES "Organization"`,
      CustomerEntity_tenant_default_address_fkey: `FOREIGN KEY ("tenantId", "defaultAddressId") REFERENCES "Address"`,
      FinanceLegalEntity_tenant_company_fkey: `FOREIGN KEY ("tenantId", "companyId") REFERENCES "Organization"`,
      Invoice_tenant_company_fkey: `FOREIGN KEY ("tenantId", "companyId") REFERENCES "Organization"`,
      Invoice_tenant_order_owner_fkey: `FOREIGN KEY ("tenantId", "orderId", "companyId") REFERENCES "Order"`,
      Order_tenant_assigned_org_fkey: `FOREIGN KEY ("tenantId", "assignedOrgId") REFERENCES "Organization"`,
      Order_tenant_customer_fkey: `FOREIGN KEY ("tenantId", "customerEntityId") REFERENCES "CustomerEntity"`,
      Order_tenant_owner_org_fkey: `FOREIGN KEY ("tenantId", "ownerOrgId") REFERENCES "Organization"`,
      Order_tenant_receiver_address_fkey: `FOREIGN KEY ("tenantId", "receiverAddressId") REFERENCES "Address"`,
      Order_tenant_sender_address_fkey: `FOREIGN KEY ("tenantId", "senderAddressId") REFERENCES "Address"`,
      Order_tenant_warehouse_fkey: `FOREIGN KEY ("tenantId", "currentWarehouseId") REFERENCES "Warehouse"`,
      Organization_tenant_parent_fkey: `FOREIGN KEY ("tenantId", "parentOrgId") REFERENCES "Organization"`,
    };
    const names = Object.keys(expectedConstraints).sort();
    const constraints = await client.query<{ conname: string; convalidated: boolean; definition: string }>(`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = ANY($1::text[]) ORDER BY conname
    `, [names]);
    expect(constraints.rows.map(({ conname, convalidated }) => ({ conname, convalidated })))
      .toEqual(names.map((conname) => ({ conname, convalidated: true })));
    constraints.rows.forEach(({ conname, definition }) => {
      expect(definition).toContain(expectedConstraints[conname]);
      expect(definition).toContain("ON UPDATE RESTRICT ON DELETE RESTRICT");
    });
    const target = await client.query<{ indisvalid: boolean; indisunique: boolean }>(`
      SELECT indisvalid, indisunique FROM pg_index
      WHERE indexrelid = '"Order_tenant_owner_identity_key"'::regclass
    `);
    expect(target.rows).toEqual([{ indisvalid: true, indisunique: true }]);
  });
});

it("rejects duplicate TenantMembership rows for one tenant and user", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await expectSqlState(client, "duplicate_membership", `
      INSERT INTO "TenantMembership" ("id", "tenantId", "userId", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8b00-000000000001", TENANT_DEMO_IDS.tenants.transAsia,
      TENANT_DEMO_IDS.users.multiTenant], "23505");
  });
});

it("rejects partial-null company membership and refresh-session bridges", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await expectSqlState(client, "partial_company_bridge", `
      UPDATE "CompanyMembership" SET "tenantMembershipId" = NULL WHERE "id" = $1
    `, [TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz], "23514");
    await expectSqlState(client, "partial_session_bridge", `
      INSERT INTO "UserRefreshSession"
      ("id", "userId", "tokenHash", "expiresAt", "updatedAt", "tenantId")
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP, $4)
    `, ["019b0000-0000-7000-8b00-000000000002", TENANT_DEMO_IDS.users.multiTenant,
      "synthetic-non-secret-session-value", TENANT_DEMO_IDS.tenants.transAsia], "23514");
  });
});

it("rejects company membership bridges to the wrong user or tenant", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await expectSqlState(client, "wrong_membership_user", `
      UPDATE "CompanyMembership" SET "tenantMembershipId" = $1 WHERE "id" = $2
    `, [TENANT_DEMO_IDS.tenantMemberships.makerTransAsia,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz], "23503");
    await expectSqlState(client, "wrong_membership_tenant", `
      UPDATE "CompanyMembership" SET "tenantMembershipId" = $1 WHERE "id" = $2
    `, [TENANT_DEMO_IDS.tenantMemberships.multiUnrelated,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz], "23503");
  });
});

it("rejects refresh-session bridges to a company membership for the wrong user or tenant", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await expectSqlState(client, "wrong_session_user", `
      INSERT INTO "UserRefreshSession"
      ("id", "userId", "tokenHash", "expiresAt", "updatedAt", "tenantId", "tenantMembershipId", "companyMembershipId")
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP, $4, $5, $6)
    `, ["019b0000-0000-7000-8b00-000000000003", TENANT_DEMO_IDS.users.maker,
      "synthetic-non-secret-session-value", TENANT_DEMO_IDS.tenants.transAsia,
      TENANT_DEMO_IDS.tenantMemberships.makerTransAsia,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz], "23503");
    await expectSqlState(client, "wrong_session_tenant", `
      INSERT INTO "UserRefreshSession"
      ("id", "userId", "tokenHash", "expiresAt", "updatedAt", "tenantId", "tenantMembershipId", "companyMembershipId")
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP, $4, $5, $6)
    `, ["019b0000-0000-7000-8b00-000000000004", TENANT_DEMO_IDS.users.multiTenant,
      "synthetic-non-secret-session-value", TENANT_DEMO_IDS.tenants.unrelated,
      TENANT_DEMO_IDS.tenantMemberships.multiUnrelated,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz], "23503");
  });
});

it("rejects references to nonexistent tenants", async () => {
  await inRollbackTransaction(async (client) => {
    await expectSqlState(client, "unknown_tenant", `
      INSERT INTO "Warehouse" ("id", "tenantId", "name", "location") VALUES ($1, $2, $3, $4)
    `, ["019b0000-0000-7000-8b00-000000000005", "019b0000-0000-7000-8b00-000000000099",
      "Synthetic invalid warehouse", "Synthetic invalid location"], "23503");
  });
});

it("rejects company and organization ownership changes across tenants without changing records", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await expectSqlState(client, "membership_company_tenant", `
      UPDATE "CompanyMembership" SET "companyId" = $1 WHERE "id" = $2
    `, [TENANT_DEMO_IDS.organizations.unrelated,
      TENANT_DEMO_IDS.companyMemberships.makerTransAsiaUz], "23503");
    await expectSqlState(client, "organization_parent_tenant", `
      UPDATE "Organization" SET "parentOrgId" = $1 WHERE "id" = $2
    `, [TENANT_DEMO_IDS.organizations.unrelated,
      TENANT_DEMO_IDS.organizations.transAsiaUzBranch], "23503");

    const membership = await client.query(`SELECT "companyId" FROM "CompanyMembership" WHERE "id" = $1`,
      [TENANT_DEMO_IDS.companyMemberships.makerTransAsiaUz]);
    const branch = await client.query(`SELECT "parentOrgId" FROM "Organization" WHERE "id" = $1`,
      [TENANT_DEMO_IDS.organizations.transAsiaUzBranch]);
    expect(membership.rows[0].companyId).toBe(TENANT_DEMO_IDS.organizations.transAsiaUz);
    expect(branch.rows[0].parentOrgId).toBe(TENANT_DEMO_IDS.organizations.transAsiaUz);

    await expectSqlState(client, "insert_membership_company_tenant", `
      INSERT INTO "CompanyMembership"
      ("id", "userId", "companyId", "tenantId", "tenantMembershipId", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8c00-000000000001", TENANT_DEMO_IDS.users.maker,
      TENANT_DEMO_IDS.organizations.unrelated, TENANT_DEMO_IDS.tenants.transAsia,
      TENANT_DEMO_IDS.tenantMemberships.makerTransAsia], "23503");
    await expectSqlState(client, "insert_organization_parent_tenant", `
      INSERT INTO "Organization" ("id", "name", "type", "code", "parentOrgId", "tenantId", "createdAt", "updatedAt")
      VALUES ($1, $2, 'branch', $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8c00-000000000002", "Synthetic invalid branch", "INVALID_CROSS_TENANT_BRANCH",
      TENANT_DEMO_IDS.organizations.unrelated, TENANT_DEMO_IDS.tenants.transAsia], "23503");
  });
});

it("rejects customer/address ownership mismatches on inserts and updates without changing records", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await expectSqlState(client, "address_customer_tenant", `
      UPDATE "Address" SET "customerEntityId" = $1 WHERE "id" = $2
    `, [TENANT_DEMO_IDS.customers.unrelated, TENANT_DEMO_IDS.addresses.transAsiaSender], "23503");
    await expectSqlState(client, "customer_default_address_tenant", `
      UPDATE "CustomerEntity" SET "defaultAddressId" = $1 WHERE "id" = $2
    `, [TENANT_DEMO_IDS.addresses.unrelatedSender, TENANT_DEMO_IDS.customers.transAsia], "23503");

    const address = await client.query(`SELECT "customerEntityId" FROM "Address" WHERE "id" = $1`,
      [TENANT_DEMO_IDS.addresses.transAsiaSender]);
    const customer = await client.query(`SELECT "defaultAddressId" FROM "CustomerEntity" WHERE "id" = $1`,
      [TENANT_DEMO_IDS.customers.transAsia]);
    expect(address.rows[0].customerEntityId).toBe(TENANT_DEMO_IDS.customers.transAsia);
    expect(customer.rows[0].defaultAddressId).toBeNull();

    await expectSqlState(client, "insert_address_customer_tenant", `
      INSERT INTO "Address" ("id", "tenantId", "customerEntityId", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8c00-000000000003", TENANT_DEMO_IDS.tenants.transAsia,
      TENANT_DEMO_IDS.customers.unrelated], "23503");
    await expectSqlState(client, "insert_customer_default_address_tenant", `
      INSERT INTO "CustomerEntity" ("id", "tenantId", "name", "defaultAddressId", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8c00-000000000004", TENANT_DEMO_IDS.tenants.transAsia,
      "Synthetic invalid customer", TENANT_DEMO_IDS.addresses.unrelatedSender], "23503");
  });
});

it("rejects every populated cross-tenant order ownership relation on update and insert", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    const orderId = TENANT_DEMO_IDS.orders.transAsiaUz;
    const invalidUpdates: Array<[string, string, string]> = [
      ["order_owner_tenant", "ownerOrgId", TENANT_DEMO_IDS.organizations.unrelated],
      ["order_assigned_tenant", "assignedOrgId", TENANT_DEMO_IDS.organizations.unrelated],
      ["order_customer_tenant", "customerEntityId", TENANT_DEMO_IDS.customers.unrelated],
      ["order_sender_tenant", "senderAddressId", TENANT_DEMO_IDS.addresses.unrelatedSender],
      ["order_receiver_tenant", "receiverAddressId", TENANT_DEMO_IDS.addresses.unrelatedReceiver],
      ["order_warehouse_tenant", "currentWarehouseId", TENANT_DEMO_IDS.warehouses.unrelated],
    ];
    for (const [savepoint, column, invalidId] of invalidUpdates) {
      await expectSqlState(client, savepoint,
        `UPDATE "Order" SET "${column}" = $1 WHERE "id" = $2`, [invalidId, orderId], "23503");
    }
    const unchanged = await client.query(`
      SELECT "ownerOrgId", "assignedOrgId", "customerEntityId", "senderAddressId", "receiverAddressId", "currentWarehouseId"
      FROM "Order" WHERE "id" = $1
    `, [orderId]);
    expect(unchanged.rows[0]).toEqual({
      ownerOrgId: TENANT_DEMO_IDS.organizations.transAsiaUz,
      assignedOrgId: TENANT_DEMO_IDS.organizations.transAsiaUzBranch,
      customerEntityId: TENANT_DEMO_IDS.customers.transAsia,
      senderAddressId: TENANT_DEMO_IDS.addresses.transAsiaSender,
      receiverAddressId: TENANT_DEMO_IDS.addresses.transAsiaReceiver,
      currentWarehouseId: TENANT_DEMO_IDS.warehouses.transAsiaUz,
    });
    await expectSqlState(client, "insert_order_warehouse_tenant", `
      INSERT INTO "Order"
      ("id", "tenantId", "orderNumber", "customerId", "currentWarehouseId", "pickupAddress", "dropoffAddress", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8c00-000000000005", TENANT_DEMO_IDS.tenants.transAsia,
      "INVALID-CROSS-TENANT-ORDER", TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.warehouses.unrelated, "Synthetic pickup", "Synthetic dropoff"], "23503");
    const invalidOrder = await client.query(`SELECT count(*)::int AS count FROM "Order" WHERE "orderNumber" = $1`,
      ["INVALID-CROSS-TENANT-ORDER"]);
    expect(invalidOrder.rows[0].count).toBe(0);
  });
});

it("rejects FinanceLegalEntity companies from another tenant on insert and update", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    const extraCompanyId = "019b0000-0000-7000-8c00-000000000006";
    await client.query(`
      INSERT INTO "Organization" ("id", "tenantId", "name", "type", "code", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'company', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [extraCompanyId, TENANT_DEMO_IDS.tenants.unrelated, "Synthetic unrelated extra company", "UNRELATED_EXTRA"]);
    await expectSqlState(client, "update_legal_entity_tenant", `
      UPDATE "FinanceLegalEntity" SET "companyId" = $1 WHERE "id" = $2
    `, [extraCompanyId, TENANT_DEMO_IDS.legalEntities.transAsiaUz], "23503");
    const unchanged = await client.query(`SELECT "companyId" FROM "FinanceLegalEntity" WHERE "id" = $1`,
      [TENANT_DEMO_IDS.legalEntities.transAsiaUz]);
    expect(unchanged.rows[0].companyId).toBe(TENANT_DEMO_IDS.organizations.transAsiaUz);
    await expectSqlState(client, "insert_legal_entity_tenant", `
      INSERT INTO "FinanceLegalEntity"
      ("id", "tenantId", "companyId", "baseCurrency", "createdByUserId", "updatedByUserId", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'USD', $4, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8c00-000000000007", TENANT_DEMO_IDS.tenants.transAsia,
      extraCompanyId, TENANT_DEMO_IDS.users.maker], "23503");
  });
});

it("rejects same-tenant cross-legal-entity invoice/order links on insert and update", async () => {
  await inRollbackTransaction(async (client) => {
    await persistTenantDemoFixture(client, createTenantDemoFixture());
    await expectSqlState(client, "invoice_order_legal_entity", `
      UPDATE "Invoice" SET "companyId" = $1 WHERE "id" = $2
    `, [TENANT_DEMO_IDS.organizations.transAsiaDe, TENANT_DEMO_IDS.invoices.transAsiaUz], "23503");
    const unchanged = await client.query(`SELECT "companyId" FROM "Invoice" WHERE "id" = $1`,
      [TENANT_DEMO_IDS.invoices.transAsiaUz]);
    expect(unchanged.rows[0].companyId).toBe(TENANT_DEMO_IDS.organizations.transAsiaUz);

    const extraOrderId = "019b0000-0000-7000-8c00-000000000008";
    await client.query(`
      INSERT INTO "Order"
      ("id", "tenantId", "orderNumber", "customerId", "ownerOrgId", "pickupAddress", "dropoffAddress", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
    `, [extraOrderId, TENANT_DEMO_IDS.tenants.transAsia, "TA-DEMO-UZ-EXTRA",
      TENANT_DEMO_IDS.users.multiTenant, TENANT_DEMO_IDS.organizations.transAsiaUz,
      "Synthetic pickup", "Synthetic dropoff"]);
    await expectSqlState(client, "insert_invoice_order_legal_entity", `
      INSERT INTO "Invoice"
      ("id", "tenantId", "companyId", "orderId", "customerId", "invoiceNumber", "amount", "currency", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, 10.00, 'EUR', CURRENT_TIMESTAMP)
    `, ["019b0000-0000-7000-8c00-000000000009", TENANT_DEMO_IDS.tenants.transAsia,
      TENANT_DEMO_IDS.organizations.transAsiaDe, extraOrderId, TENANT_DEMO_IDS.users.multiTenant,
      "INVALID-CROSS-ENTITY-INVOICE"], "23503");
    const invalidInvoice = await client.query(`SELECT count(*)::int AS count FROM "Invoice" WHERE "invoiceNumber" = $1`,
      ["INVALID-CROSS-ENTITY-INVOICE"]);
    expect(invalidInvoice.rows[0].count).toBe(0);
  });
});
