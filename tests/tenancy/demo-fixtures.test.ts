jest.mock("../../src/config/prismaClient", () => {
  throw new Error("Tenant demo fixtures must not import Prisma");
});

import {
  createTenantDemoFixture,
  TENANT_DEMO_IDS,
} from "../../src/modules/tenancy/demo-fixtures";
import {
  assessTenantDemoFixture,
  resolveExplicitCompanyMembership,
} from "../../src/modules/tenancy/demo-fixture-consistency";

describe("deterministic tenant demo fixtures", () => {
  it("builds a valid, stable graph without CP_ROOT business ownership", () => {
    const first = createTenantDemoFixture();
    const second = createTenantDemoFixture();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.tenants[0].name = "mutated copy";
    expect(second.tenants[0].name).toBe("TransAsia Synthetic Demo Tenant");
    expect(assessTenantDemoFixture(second)).toEqual([]);
    expect(second.organizations.some((organization) => organization.code === "CP_ROOT")).toBe(false);
  });

  it("requires an explicit authorized company membership for a multi-tenant user", () => {
    const fixture = createTenantDemoFixture();
    const transAsia = resolveExplicitCompanyMembership(
      fixture,
      TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaDe,
    );
    const unrelated = resolveExplicitCompanyMembership(
      fixture,
      TENANT_DEMO_IDS.users.multiTenant,
      TENANT_DEMO_IDS.companyMemberships.multiUnrelated,
    );

    expect(transAsia.tenantId).toBe(TENANT_DEMO_IDS.tenants.transAsia);
    expect(unrelated.tenantId).toBe(TENANT_DEMO_IDS.tenants.unrelated);
    expect(() => resolveExplicitCompanyMembership(
      fixture,
      TENANT_DEMO_IDS.users.maker,
      TENANT_DEMO_IDS.companyMemberships.multiTransAsiaDe,
    )).toThrow("Explicit authorized company membership is required");
  });

  it("detects a cross-tenant order relationship", () => {
    const fixture = createTenantDemoFixture();
    const order = fixture.orders.find((item) => item.id === TENANT_DEMO_IDS.orders.transAsiaUz)!;
    order.currentWarehouseId = TENANT_DEMO_IDS.warehouses.unrelated;

    expect(assessTenantDemoFixture(fixture)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ORDER_RELATION_TENANT_MISMATCH", resourceId: order.id }),
    ]));
  });

  it("detects a same-tenant cross-legal-entity invoice/order relationship", () => {
    const fixture = createTenantDemoFixture();
    const invoice = fixture.invoices.find((item) => item.id === TENANT_DEMO_IDS.invoices.transAsiaUz)!;
    invoice.companyId = TENANT_DEMO_IDS.organizations.transAsiaDe;

    expect(assessTenantDemoFixture(fixture)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVOICE_ORDER_LEGAL_ENTITY_MISMATCH", resourceId: invoice.id }),
    ]));
  });

  it.each([
    ["wrong user", TENANT_DEMO_IDS.tenantMemberships.makerTransAsia],
    ["wrong tenant", TENANT_DEMO_IDS.tenantMemberships.multiUnrelated],
  ])("detects a company membership linked to a tenant membership for the %s", (_case, tenantMembershipId) => {
    const fixture = createTenantDemoFixture();
    const membership = fixture.companyMemberships.find(
      (item) => item.id === TENANT_DEMO_IDS.companyMemberships.multiTransAsiaUz,
    )!;
    membership.tenantMembershipId = tenantMembershipId;

    expect(assessTenantDemoFixture(fixture)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "COMPANY_MEMBERSHIP_TENANT_MEMBERSHIP_IDENTITY_MISMATCH",
        resourceId: membership.id,
      }),
    ]));
  });

  it("keeps maker and checker identities separate", () => {
    const fixture = createTenantDemoFixture();
    const maker = fixture.companyMemberships.find((item) => item.id === TENANT_DEMO_IDS.companyMemberships.makerTransAsiaUz)!;
    const checker = fixture.companyMemberships.find((item) => item.id === TENANT_DEMO_IDS.companyMemberships.checkerTransAsiaUz)!;

    expect(maker.userId).not.toBe(checker.userId);
    expect(maker.roleCodes).toEqual(["finance_maker"]);
    expect(checker.roleCodes).toEqual(["finance_checker"]);
  });
});
