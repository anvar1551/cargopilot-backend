jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/orders-core/cash", () => ({ buildInitialOrderCashCollections: jest.fn(() => []) }));
jest.mock("../../src/modules/orders-core/sla", () => ({ resolveOrderSlaSnapshot: jest.fn(async () => ({})) }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventsTx: jest.fn(async () => undefined) }));
jest.mock("../../src/modules/orders-core/repo", () => ({ createOrder: require("../../src/modules/orders-core/repo/order-write.repo").createOrder }));
jest.mock("../../src/modules/orders-core/label", () => ({
  enqueueOrderLabelJob: jest.fn(async () => undefined), generateAndAttachParcelLabelsForOrder: jest.fn(async () => undefined),
  isOrderLabelAutoFallbackEnabled: jest.fn(() => false), resolveOrderLabelMode: jest.fn(() => "queue"),
  scheduleOrderLabelAutoFallback: jest.fn(), runOrderLabelAutoFallback: jest.fn(),
}));
jest.mock("../../src/modules/orders-legs", () => ({
  seedInitialServiceChargePricing: jest.fn(async () => undefined), autoBookCarrierForOrder: jest.fn(async () => []),
}));
jest.mock("../../src/modules/pricing-core", () => ({ quoteTariff: jest.fn() }));
jest.mock("../../src/modules/support-core/application/autoTriage", () => ({ createSystemSupportTicket: jest.fn(), createLabelFailureSupportTicket: jest.fn() }));

import { database as db } from "./fixtures";
import { mapCreateOrderDtoToRepoPayload } from "../../src/modules/orders-core/domain/orderCreate.mapper";
import { createOrder } from "../../src/modules/orders-core/repo/order-write.repo";
import { createOrderForActor } from "../../src/modules/orders-core/write/create-order";
import { getOrderImportTemplateCsv, importOrdersFromCsv, previewOrderImport } from "../../src/modules/orders-core/import/order-import";
import * as labels from "../../src/modules/orders-core/label";
import * as legs from "../../src/modules/orders-legs";
import { quoteTariff } from "../../src/modules/pricing-core";

const companyA = "10000000-0000-4000-8000-000000000001";
const companyB = "10000000-0000-4000-8000-000000000002";
const masterA = "20000000-0000-4000-8000-000000000001";
const masterB = "20000000-0000-4000-8000-000000000002";
const actor: any = { id: "user-a", membershipId: "membership-a", companyId: companyA, customerEntityId: masterA };
const body = () => ({
  sender: { name: "Sender", phone: "+49111" }, receiver: { name: "Receiver", phone: "+49222" },
  addresses: { pickupAddress: "Pickup Street 1", dropoffAddress: "Dropoff Street 2",
    senderAddress: { city: "Bremen" }, receiverAddress: { city: "Hamburg" } },
  shipment: { serviceType: "DOOR_TO_DOOR", codEnabled: false, currency: "UZS", weightKg: 1 },
  payment: { paymentType: "CASH" },
});

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.companyMembership.findFirst.mockResolvedValue({ companyId: companyA,
    scopes: [{ scopeType: "company", scopeRefId: companyA }],
    roles: [{ role: { companyId: companyA, isSystem: false, rolePermissions: [{ permission: { key: "shipment.create" } }] } }],
  });
  db.counter.upsert.mockResolvedValue({ value: 1 });
  db.order.create.mockImplementation(async ({ data }: any) => ({ id: "order-a", ...data }));
  (quoteTariff as jest.Mock).mockResolvedValue({ quoteAvailable: false, reason: "no_rule" });
});

function noBusinessEffects() {
  expect(db.order.create).not.toHaveBeenCalled(); expect(db.address.create).not.toHaveBeenCalled(); expect(db.counter.upsert).not.toHaveBeenCalled();
  expect(labels.enqueueOrderLabelJob).not.toHaveBeenCalled(); expect(labels.generateAndAttachParcelLabelsForOrder).not.toHaveBeenCalled();
  expect(legs.autoBookCarrierForOrder).not.toHaveBeenCalled(); expect(legs.seedInitialServiceChargePricing).not.toHaveBeenCalled();
}

it("preserves snapshot-only order creation and derives company from current membership without global customer fallback", async () => {
  const result = await createOrderForActor({ user: actor, body: body() });
  expect(result.statusCode).toBe(201);
  expect(db.order.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
    ownerOrgId: companyA, customerId: "user-a", customerEntityId: null, senderAddressId: null, receiverAddressId: null,
    paymentState: "UNPAID", codPaidStatus: "NOT_PAID", serviceChargePaidStatus: "NOT_PAID",
  }) }));
});

it("defers online checkout until invoice issuance while preserving the created order", async () => {
  (quoteTariff as jest.Mock).mockResolvedValue({ quoteAvailable: true, serviceCharge: 1200.25, currency: "UZS" });
  const input = body(); input.payment.paymentType = "CARD";
  const result = await createOrderForActor({ user: actor, body: input });
  expect(result.payload).toMatchObject({ paymentPendingInvoice: true, paymentUrl: null });
  expect(db.order.create).toHaveBeenCalledTimes(1); expect(db.paymentIntent.create).not.toHaveBeenCalled();
});

it.each([masterA, masterB])("rejects even an apparently owned/global customer reference %s before writes", async (customerEntityId) => {
  await expect(createOrderForActor({ user: actor, body: { ...body(), customerEntityId } })).rejects.toMatchObject({ statusCode: 403 });
  noBusinessEffects(); expect(db.customerEntity.findUnique).not.toHaveBeenCalled();
});

it.each(["senderAddressId", "receiverAddressId"])("rejects %s without ownership lookups or business effects", async (field) => {
  for (const id of [masterA, masterB]) {
    const input = body(); Object.assign(input.addresses, { [field]: id });
    await expect(createOrderForActor({ user: actor, body: input })).rejects.toMatchObject({ statusCode: 403 });
  }
  noBusinessEffects(); expect(db.address.findUnique).not.toHaveBeenCalled(); expect(db.address.findFirst).not.toHaveBeenCalled();
});

it.each(["savePickupToAddressBook", "saveDropoffToAddressBook"])("rejects %s before an address write", async (field) => {
  const input = body(); Object.assign(input.addresses, { [field]: true });
  await expect(createOrderForActor({ user: actor, body: input })).rejects.toMatchObject({ statusCode: 403 }); noBusinessEffects();
});

it.each(["codPaidStatus", "serviceChargePaidStatus", "paymentState", "payment_status", "status", "isPaid", "paid", "amount", "amountMinor", "serviceCharge"])(
  "rejects client financial field %s at root, payment and alternate shipment paths", async (field) => {
    for (const location of ["root", "payment", "shipment"]) {
      const input: any = body(); (location === "root" ? input : input[location])[field] = field.includes("Status") ? "NOT_PAID" : null;
      await expect(createOrderForActor({ user: actor, body: input })).rejects.toMatchObject({ statusCode: 400 });
    }
    noBusinessEffects();
  },
);

it("rejects anonymous and revoked-member creation before business effects", async () => {
  await expect(createOrderForActor({ user: undefined, body: body() })).rejects.toMatchObject({ statusCode: 401 });
  db.companyMembership.findFirst.mockResolvedValue(null);
  await expect(createOrderForActor({ user: actor, body: body() })).rejects.toMatchObject({ statusCode: 403 }); noBusinessEffects();
});

it("rejects missing scope even when token claims a company permission", async () => {
  db.companyMembership.findFirst.mockResolvedValue({ companyId: companyA, scopes: [], roles: [] });
  await expect(createOrderForActor({ user: { ...actor, permissionCodes: ["shipment.create"] }, body: body() })).rejects.toMatchObject({ statusCode: 403 }); noBusinessEffects();
});

it("rejects foreign role grants on a selected company", async () => {
  db.companyMembership.findFirst.mockResolvedValue({ companyId: companyA,
    scopes: [{ scopeType: "company", scopeRefId: companyA }],
    roles: [{ role: { companyId: companyB, isSystem: false, rolePermissions: [{ permission: { key: "shipment.create" } }] } }],
  });
  await expect(createOrderForActor({ user: actor, body: body() })).rejects.toMatchObject({ statusCode: 403 }); noBusinessEffects();
});

it("contains direct repository reference/status bypasses before writes", async () => {
  const payload = await mapCreateOrderDtoToRepoPayload(body());
  await expect(createOrder(actor.id, { ...payload, customerEntityId: masterA }, actor)).rejects.toMatchObject({ statusCode: 403 });
  await expect(createOrder(actor.id, { ...payload, senderAddressId: masterB }, actor)).rejects.toMatchObject({ statusCode: 403 });
  await expect(createOrder(actor.id, { ...payload, codPaidStatus: "PAID" }, actor)).rejects.toMatchObject({ statusCode: 400 });
  noBusinessEffects();
});

it("ships a usable CSV template without financial-authority fields or required customer master", async () => {
  const csvText = getOrderImportTemplateCsv();
  expect(csvText.split("\n")[0]).not.toMatch(/serviceCharge|PaidStatus/);
  await expect(previewOrderImport({ csvText })).resolves.toMatchObject({ validRows: 1, invalidRows: 0 });
  await expect(importOrdersFromCsv({ actor, csvText })).resolves.toMatchObject({ count: 1 });
});

it.each(["codPaidStatus", "serviceChargePaidStatus", "paid", "payment_status", "amount", "serviceCharge", "customerEntityId", "receiverAddressId"])(
  "rejects the entire CSV before creating earlier rows when a forbidden %s column exists", async (field) => {
    const csvText = `receiverName,pickupAddress,dropoffAddress,${field}\nReceiver,Pickup Street,Dropoff Street,${masterB}\n`;
    await expect(importOrdersFromCsv({ actor, csvText })).rejects.toBeDefined(); noBusinessEffects();
  },
);

it("rejects the legacy CSV customer argument without inferring ownership from the actor", async () => {
  await expect(importOrdersFromCsv({ actor, csvText: getOrderImportTemplateCsv(), customerEntityId: masterA })).rejects.toMatchObject({ statusCode: 403 }); noBusinessEffects();
});
