jest.mock("../../src/config/prismaClient", () => ({
  __esModule: true,
  default: require("./fixtures").database,
}));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn() }));
jest.mock("../../src/modules/customers-core/application/customerEntityRepo", () => ({
  requireCustomerEntityReference: jest.fn(),
}));
jest.mock("../../src/modules/orders-core/sla", () => ({ resolveOrderSlaSnapshot: jest.fn() }));

import { database } from "./fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { requireCustomerEntityReference } from "../../src/modules/customers-core/application/customerEntityRepo";
import {
  backfillOrderSlaSnapshots,
  createDeliverySlaRule,
  createPricingRegion,
  createTariffPlan,
  deleteDeliverySlaRule,
  deletePricingRegion,
  deleteTariffPlan,
  getOperationalSlaPolicy,
  listTariffPlans,
  quoteTariff,
  quoteTariffOptions,
  updateDeliverySlaRule,
  updateOperationalSlaPolicy,
  updatePricingRegion,
  updateTariffPlan,
  upsertZoneMatrix,
} from "../../src/modules/pricing-core/repo/pricing.repo";

const mockedLoad = loadAccessSnapshot as jest.Mock;
const mockedCustomer = requireCustomerEntityReference as jest.Mock;
const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  tenantA: "20000000-0000-4000-8000-000000000001",
  tenantB: "20000000-0000-4000-8000-000000000002",
  tenantMembership: "30000000-0000-4000-8000-000000000001",
  membership: "40000000-0000-4000-8000-000000000001",
  companyA: "50000000-0000-4000-8000-000000000001",
  companyB: "50000000-0000-4000-8000-000000000002",
  customerA: "60000000-0000-4000-8000-000000000001",
  routeA: "70000000-0000-4000-8000-000000000001",
  planA: "80000000-0000-4000-8000-000000000001",
};

function context(overrides: Record<string, unknown> = {}): any {
  return {
    id: ids.user,
    membershipId: ids.membership,
    companyMembershipId: ids.membership,
    companyId: ids.companyA,
    tenantId: ids.tenantA,
    tenantMembershipId: ids.tenantMembership,
    branchId: null,
    email: "pricing@example.test",
    name: "Synthetic Pricing User",
    warehouseId: null,
    customerEntityId: null,
    roleCodes: ["manager"],
    permissionCodes: ["pricing.read", "pricing.write", "customers.read", "shipment.create"],
    scopes: [{ scopeType: "company", scopeRefId: ids.companyA }],
    ...overrides,
  };
}

function snapshot(input = context()) {
  return {
    userId: input.id,
    membershipId: input.membershipId,
    companyMembershipId: input.companyMembershipId,
    companyId: input.companyId,
    tenantId: input.tenantId,
    tenantMembershipId: input.tenantMembershipId,
    branchId: input.branchId,
    email: input.email,
    name: input.name,
    warehouseId: input.warehouseId,
    customerEntityId: input.customerEntityId,
    roleCodes: input.roleCodes,
    permissionCodes: input.permissionCodes,
    scopes: input.scopes,
  };
}

const planInput: any = {
  name: "Synthetic plan",
  code: "SYNTHETIC-A",
  description: null,
  status: "active",
  serviceType: "DOOR_TO_DOOR",
  priceType: "bucket",
  pricingStrategy: "FIXED_LANE",
  coverageType: "domestic",
  transportMode: "ROAD",
  originCountryCode: null,
  destinationCountryCode: null,
  routeTemplateId: ids.routeA,
  currency: "EUR",
  priority: 1,
  isDefault: true,
  customerEntityId: ids.customerA,
  rates: [{ zone: 1, weightFromKg: 0, weightToKg: 10, price: 100 }],
  transitLegRates: [],
};

const quoteInput: any = {
  serviceType: "DOOR_TO_DOOR",
  weightKg: 5,
  originQuery: "Origin",
  destinationQuery: "Destination",
  originCountryCode: "DE",
  destinationCountryCode: "DE",
  transportMode: "ROAD",
  customerEntityId: ids.customerA,
};

function resetMocks() {
  mockedLoad.mockReset().mockResolvedValue(snapshot());
  mockedCustomer.mockReset().mockResolvedValue({ id: ids.customerA, tenantId: ids.tenantA });
  [database.$transaction, database.routeTemplate.findFirst, database.tariffPlan.findMany,
    database.tariffPlan.findFirst, database.tariffPlan.create, database.tariffPlan.updateMany,
    database.tariffPlan.deleteMany, database.tariffPlan.count, database.tariffRate.deleteMany,
    database.tariffRate.createMany, database.pricingRegion.findMany,
    database.zoneMatrixEntry.findUnique].forEach((mock) => mock.mockReset());
}

function configureRoute() {
  database.pricingRegion.findMany.mockResolvedValue([
    { id: "region-a", code: "ORIGIN", name: "Origin", aliases: [] },
    { id: "region-b", code: "DESTINATION", name: "Destination", aliases: [] },
  ]);
  database.zoneMatrixEntry.findUnique.mockResolvedValue({ zone: 1 });
}

describe("pricing tenant containment (mocked repository evidence)", () => {
  beforeEach(resetMocks);

  it("fails closed on missing context before pricing queries", async () => {
    await expect(quoteTariff(context({ tenantId: "" }), quoteInput)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockedLoad).not.toHaveBeenCalled();
    expect(database.tariffPlan.findMany).not.toHaveBeenCalled();
  });

  it("requires selected-company scope in addition to pricing permission", async () => {
    mockedLoad.mockResolvedValue(snapshot(context({
      scopes: [{ scopeType: "company", scopeRefId: ids.companyB }],
    })));
    await expect(listTariffPlans(context(), {})).rejects.toMatchObject({ statusCode: 403 });
    expect(database.tariffPlan.findMany).not.toHaveBeenCalled();
  });

  it("rejects a caller-selected foreign company before customer or pricing reads", async () => {
    await expect(quoteTariff(context(), { ...quoteInput, companyId: ids.companyB }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mockedCustomer).not.toHaveBeenCalled();
    expect(database.pricingRegion.findMany).not.toHaveBeenCalled();
  });

  it("validates customer references through customer access controls", async () => {
    mockedCustomer.mockRejectedValue(Object.assign(new Error("Customer not found"), { statusCode: 404 }));
    await expect(quoteTariff(context(), quoteInput)).rejects.toMatchObject({ statusCode: 404 });
    expect(database.tariffPlan.findMany).not.toHaveBeenCalled();
  });

  it("keeps customer-specific precedence within the authoritative tenant and company", async () => {
    configureRoute();
    database.tariffPlan.findMany.mockResolvedValue([
      { id: "default", name: "Default", customerEntityId: null, isDefault: true, priority: 100,
        createdAt: new Date("2026-01-02"), coverageType: "domestic", currency: "EUR",
        priceType: "bucket", pricingStrategy: "FIXED_LANE", rates: [{ id: "r1", zone: 1,
          weightFromKg: 0, weightToKg: 10, price: 120 }] },
      { id: "specific", name: "Specific", customerEntityId: ids.customerA, isDefault: false, priority: 1,
        createdAt: new Date("2026-01-01"), coverageType: "domestic", currency: "EUR",
        priceType: "bucket", pricingStrategy: "FIXED_LANE", rates: [{ id: "r2", zone: 1,
          weightFromKg: 0, weightToKg: 10, price: 90 }] },
    ]);
    const quote = await quoteTariff(context(), quoteInput);
    expect(quote).toMatchObject({ quoteAvailable: true, serviceCharge: 90,
      tariffPlan: { id: "specific" } });
    expect(database.tariffPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: ids.tenantA, companyId: ids.companyA }),
    }));
  });

  it("scopes quote options to the same tenant and company", async () => {
    configureRoute();
    database.tariffPlan.findMany.mockResolvedValue([]);
    await quoteTariffOptions(context(), { ...quoteInput, transportMode: undefined });
    expect(database.tariffPlan.findMany).toHaveBeenCalledTimes(6);
    for (const [call] of database.tariffPlan.findMany.mock.calls) {
      expect(call.where).toMatchObject({ tenantId: ids.tenantA, companyId: ids.companyA });
    }
  });

  it("derives ownership for plan creation and validates route and customer", async () => {
    database.routeTemplate.findFirst.mockResolvedValue({ id: ids.routeA });
    database.$transaction.mockImplementation(async (run: any) => run(database));
    database.tariffPlan.updateMany.mockResolvedValue({ count: 0 });
    database.tariffPlan.create.mockResolvedValue({ id: ids.planA });
    await createTariffPlan(context(), planInput);
    expect(database.routeTemplate.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ids.routeA, companyId: ids.companyA, company: { tenantId: ids.tenantA } },
    }));
    expect(mockedCustomer).toHaveBeenCalledWith(expect.any(Object), ids.customerA);
    expect(database.tariffPlan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: ids.tenantA, companyId: ids.companyA }),
    }));
  });

  it("rejects request ownership fields before creating a plan", async () => {
    await expect(createTariffPlan(context(), { ...planInput, companyId: ids.companyB }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(database.routeTemplate.findFirst).not.toHaveBeenCalled();
    expect(mockedCustomer).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.tariffPlan.create).not.toHaveBeenCalled();
  });

  it("rejects a foreign-company route template without mutation", async () => {
    database.routeTemplate.findFirst.mockResolvedValue(null);
    await expect(createTariffPlan(context(), planInput)).rejects.toMatchObject({ statusCode: 400 });
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.tariffPlan.create).not.toHaveBeenCalled();
  });

  it("does not update or delete a plan outside the selected company", async () => {
    database.routeTemplate.findFirst.mockResolvedValue({ id: ids.routeA });
    database.tariffPlan.findFirst.mockResolvedValue(null);
    await expect(updateTariffPlan(context(), ids.planA, planInput)).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteTariffPlan(context(), ids.planA)).rejects.toMatchObject({ statusCode: 404 });
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.tariffPlan.updateMany).not.toHaveBeenCalled();
    expect(database.tariffPlan.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["create region", () => createPricingRegion({} as any)],
    ["update region", () => updatePricingRegion(ids.routeA, {} as any)],
    ["delete region", () => deletePricingRegion(ids.routeA)],
    ["create SLA rule", () => createDeliverySlaRule({} as any)],
    ["update SLA rule", () => updateDeliverySlaRule(ids.routeA, {} as any)],
    ["delete SLA rule", () => deleteDeliverySlaRule(ids.routeA)],
    ["update SLA policy", () => updateOperationalSlaPolicy({} as any)],
    ["upsert zone matrix", () => upsertZoneMatrix({ entries: [] })],
    ["backfill order SLA", () => backfillOrderSlaSnapshots({ dryRun: true })],
  ])("blocks unowned shared configuration mutation: %s", async (_name, mutate) => {
    await expect(mutate()).rejects.toMatchObject({ statusCode: 503 });
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.pricingRegion.findMany).not.toHaveBeenCalled();
    expect(database.order.findMany).not.toHaveBeenCalled();
  });

  it("does not create an unowned SLA policy as a side effect of reading it", async () => {
    database.operationalSlaPolicy.findUnique.mockResolvedValue(null);
    await expect(getOperationalSlaPolicy()).rejects.toMatchObject({ statusCode: 503 });
    expect(database.operationalSlaPolicy.upsert).not.toHaveBeenCalled();
  });
});
