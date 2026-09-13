import type { PoolClient } from "pg";
import type { TenantDemoFixture } from "../../src/modules/tenancy/demo-fixtures";
import { assessTenantDemoFixture } from "../../src/modules/tenancy/demo-fixture-consistency";

const FIXED_TIME = new Date("2026-01-01T00:00:00.000Z");

/** Test-only persistence adapter. The caller owns the client and transaction. */
export async function persistTenantDemoFixture(
  client: PoolClient,
  fixture: TenantDemoFixture,
): Promise<void> {
  const issues = assessTenantDemoFixture(fixture);
  if (issues.length > 0) {
    throw new Error(`Refusing to persist an inconsistent demo fixture: ${JSON.stringify(issues)}`);
  }

  for (const tenant of fixture.tenants) {
    await client.query(
      `INSERT INTO "Tenant" ("id", "code", "name", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $4)`,
      [tenant.id, tenant.code, tenant.name, FIXED_TIME],
    );
  }

  for (const user of fixture.users) {
    await client.query(
      `INSERT INTO "User" ("id", "name", "email", "password", "createdAt", "liveLocationUpdatedAt")
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [user.id, user.name, user.email, "synthetic-test-value-not-valid-for-login", FIXED_TIME],
    );
  }

  const organizations = [
    ...fixture.organizations.filter((item) => item.parentOrgId === null),
    ...fixture.organizations.filter((item) => item.parentOrgId !== null),
  ];
  for (const organization of organizations) {
    await client.query(
      `INSERT INTO "Organization" ("id", "tenantId", "name", "type", "code", "parentOrgId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::"OrganizationType", $5, $6, $7, $7)`,
      [organization.id, organization.tenantId, organization.name, organization.type,
        organization.code, organization.parentOrgId, FIXED_TIME],
    );
  }

  for (const membership of fixture.tenantMemberships) {
    await client.query(
      `INSERT INTO "TenantMembership" ("id", "tenantId", "userId", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::"MembershipStatus", $5, $5)`,
      [membership.id, membership.tenantId, membership.userId, membership.status, FIXED_TIME],
    );
  }

  for (const membership of fixture.companyMemberships) {
    await client.query(
      `INSERT INTO "CompanyMembership"
       ("id", "tenantId", "tenantMembershipId", "userId", "companyId", "branchId", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7::"MembershipStatus", $8, $8)`,
      [membership.id, membership.tenantId, membership.tenantMembershipId, membership.userId,
        membership.companyId, membership.branchId, membership.status, FIXED_TIME],
    );
  }

  for (const warehouse of fixture.warehouses) {
    await client.query(
      `INSERT INTO "Warehouse" ("id", "tenantId", "name", "location", "createdAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [warehouse.id, warehouse.tenantId, warehouse.name, "Synthetic test location", FIXED_TIME],
    );
  }

  for (const customer of fixture.customers) {
    await client.query(
      `INSERT INTO "CustomerEntity" ("id", "tenantId", "type", "name", "createdAt", "updatedAt")
       VALUES ($1, $2, 'COMPANY'::"CustomerType", $3, $4, $4)`,
      [customer.id, customer.tenantId, customer.name, FIXED_TIME],
    );
  }

  for (const address of fixture.addresses) {
    await client.query(
      `INSERT INTO "Address" ("id", "tenantId", "customerEntityId", "addressLine1", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [address.id, address.tenantId, address.customerEntityId, address.label, FIXED_TIME],
    );
  }

  for (const legalEntity of fixture.financeLegalEntities) {
    await client.query(
      `INSERT INTO "FinanceLegalEntity"
       ("id", "tenantId", "companyId", "baseCurrency", "createdByUserId", "updatedByUserId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $5, $6, $6)`,
      [legalEntity.id, legalEntity.tenantId, legalEntity.companyId, legalEntity.baseCurrency,
        fixture.users[0].id, FIXED_TIME],
    );
  }

  for (const order of fixture.orders) {
    await client.query(
      `INSERT INTO "Order"
       ("id", "tenantId", "orderNumber", "customerId", "customerEntityId", "ownerOrgId", "assignedOrgId",
        "currentWarehouseId", "senderAddressId", "receiverAddressId", "pickupAddress", "dropoffAddress",
        "currency", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [order.id, order.tenantId, order.orderNumber, order.customerId, order.customerEntityId,
        order.ownerOrgId, order.assignedOrgId, order.currentWarehouseId, order.senderAddressId,
        order.receiverAddressId, "Synthetic pickup", "Synthetic dropoff", "USD", FIXED_TIME],
    );
  }

  for (const invoice of fixture.invoices) {
    await client.query(
      `INSERT INTO "Invoice"
       ("id", "tenantId", "invoiceNumber", "orderId", "companyId", "customerId", "customerEntityId",
        "amount", "currency", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $10)`,
      [invoice.id, invoice.tenantId, invoice.invoiceNumber, invoice.orderId, invoice.companyId,
        invoice.customerId, invoice.customerEntityId, invoice.amount, invoice.currency, FIXED_TIME],
    );
  }
}
