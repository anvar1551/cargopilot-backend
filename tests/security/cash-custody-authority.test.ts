jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventsTx: jest.fn() }));
import { Prisma } from "@prisma/client";
import { database as db } from "./fixtures";
import { collectOrderCash, handoffOrderCash, settleOrderCash } from "../../src/modules/orders-core/cash/custody.service";
import { collectCashForActor, collectCashBulkForActor } from "../../src/modules/orders-core/operations/cash";
import { listCashQueueForActor, getCashQueueSummaryForActor } from "../../src/modules/orders-core/cash/collection.service";
import { enqueueCargoPilotDomainEventsTx } from "../../src/modules/analytics-core/infrastructure/analyticsOutbox";
const actor: any = { id: "user-a", companyMembershipId: "membership-a", membershipId: "membership-a", tenantId: "tenant-a", tenantMembershipId: "tm-a", companyId: "company-a" };
let membership: any, order: any, collection: any, receipt: any;
const eventId = "019b0000-0000-7000-8b00-000000000001";
const input: any = { actor, orderId: "order-a", kind: "cod", operationId: "collect-key-a" };
function held() {
  collection = { id: "collection-a", orderId: "order-a", kind: "cod", status: "held", currency: "USD", expectedAmount: 100.25, collectedAmount: 100.25,
    currentHolderType: "driver", currentHolderUserId: "user-a", currentHolderWarehouseId: null, events: [{ id: eventId, actorId: "user-a" }] };
  receipt = { tenantId: "tenant-a", companyId: "company-a", orderId: "order-a", collectionId: "collection-a", currency: "USD", amount: new Prisma.Decimal("100.25") };
}
function noWrites() {
  for (const call of [db.cashCollection.create, db.cashCollection.update, db.cashCollectionEvent.create, db.cashCustodyOperation.create, db.order.update, enqueueCargoPilotDomainEventsTx]) expect(call).not.toHaveBeenCalled();
}
beforeEach(() => {
  jest.clearAllMocks(); collection = null; receipt = null;
  membership = { id: actor.membershipId, userId: actor.id, companyId: actor.companyId, tenantId: actor.tenantId, tenantMembershipId: actor.tenantMembershipId,
    status: "active", tenant: { id: actor.tenantId, status: "active" }, tenantMembership: { id: actor.tenantMembershipId, userId: actor.id, tenantId: actor.tenantId, status: "active" },
    company: { id: actor.companyId, tenantId: actor.tenantId, isActive: true }, user: { id: actor.id, warehouseId: null },
    scopes: [{ scopeType: "company", scopeRefId: "company-a" }, { scopeType: "warehouse", scopeRefId: "warehouse-a" }],
    roles: [{ role: { code: "cash-actor", rolePermissions: ["shipment.update", "shipment.view", "finance.settleCash"].map(key => ({ permission: { key } })) } }] };
  order = { id: "order-a", orderNumber: "SYNTHETIC", status: "in_transit", tenantId: "tenant-a", ownerOrgId: "company-a", assignedDriverId: "user-a", codAmount: 100.25, codPaidStatus: "NOT_PAID", currency: "USD",
    pricingComponents: [{ currency: "USD", fxRateSnapshot: new Prisma.Decimal(1), baseCurrency: "USD", createdAt: new Date() }] };
  db.companyMembership.findFirst.mockImplementation(async () => membership);
  db.$transaction.mockImplementation(async (fn: any) => Array.isArray(fn) ? Promise.all(fn) : fn(db)); db.$queryRaw.mockResolvedValue([]);
  db.order.findFirst.mockImplementation(async () => order); db.order.findMany.mockResolvedValue([]);
  db.financeLegalEntity.findUnique.mockResolvedValue({ tenantId: "tenant-a", isActive: true, baseCurrency: "USD",
    tenant: { id: "tenant-a", status: "active" }, company: { id: "company-a", tenantId: "tenant-a", isActive: true } });
  db.cashCollection.findUnique.mockImplementation(async () => collection);
  db.cashCollection.create.mockImplementation(async ({ data }: any) => ({ id: "collection-a", ...data }));
  db.cashCollection.update.mockImplementation(async ({ data }: any) => ({ id: "collection-a", kind: "cod", ...data }));
  db.cashCollectionEvent.create.mockImplementation(async ({ data }: any) => ({ id: eventId, ...data }));
  db.cashCollectionEvent.findFirst.mockResolvedValue({ actorId: "user-a" });
  db.cashCustodyOperation.findUnique.mockImplementation(async ({ where }: any) => where.eventId ? receipt : null);
  db.cashCustodyOperation.create.mockResolvedValue({ id: "op-a" }); db.order.update.mockResolvedValue(order);
  db.warehouse.findFirst.mockResolvedValue({ id: "warehouse-a", name: "Synthetic warehouse", type: "warehouse" });
  db.cashCollection.count.mockResolvedValue(0); db.cashCollection.findMany.mockResolvedValue([]);
});
it("collects the server amount with one exact receipt and transactional finance events", async () => {
  const result = await collectOrderCash(input);
  expect(result.cashCollections[0].collectedAmount).toBe("100.25");
  expect(db.cashCustodyOperation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "tenant-a", companyId: "company-a", amount: new Prisma.Decimal("100.25") }) }));
  expect((enqueueCargoPilotDomainEventsTx as jest.Mock).mock.calls[0][0]).toBe(db);
  expect((enqueueCargoPilotDomainEventsTx as jest.Mock).mock.calls[0][1]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "finance_source_event", payload: expect.objectContaining({ amounts: { cod_amount: "100.2500" } }) })]));
});
it.each(["missing-context", "tenant-null", "foreign-tenant", "foreign-company", "missing-permission", "suspended", "unbound", "wrong-actor", "amount", "paid", "partial-paid", "precision", "currency", "invalid-state", "fx", "legacy-held", "legal-entity"])("rejects %s without writes", async kind => {
  const request = { ...input, actor: { ...actor } };
  if (kind === "missing-context") request.actor.tenantId = null;
  if (kind === "tenant-null") order.tenantId = null;
  if (kind === "foreign-tenant") order.tenantId = "tenant-b";
  if (kind === "foreign-company") order.ownerOrgId = "company-b";
  if (kind === "missing-permission") membership.roles = [];
  if (kind === "suspended") membership.tenant.status = "suspended";
  if (kind === "unbound") membership.tenantMembershipId = null;
  if (kind === "wrong-actor") order.assignedDriverId = "user-b";
  if (kind === "amount") request.amount = 1;
  if (kind === "paid") (request as any).codPaidStatus = "PAID";
  if (kind === "partial-paid") order.codPaidStatus = "PARTIAL";
  if (kind === "legal-entity") db.financeLegalEntity.findUnique.mockResolvedValue(null);
  if (kind === "precision") order.codAmount = 1.00001;
  if (kind === "currency") order.currency = null;
  if (kind === "invalid-state") order.status = "cancelled";
  if (kind === "fx") order.pricingComponents = [];
  if (kind === "legacy-held") held();
  await expect(collectOrderCash(request)).rejects.toBeDefined(); noWrites();
});
it("returns the matching durable result and rejects conflicting reuse", async () => {
  const result = await collectOrderCash(input);
  const row = db.cashCustodyOperation.create.mock.calls[0][0].data;
  jest.clearAllMocks(); db.cashCustodyOperation.findUnique.mockResolvedValue(row);
  await expect(collectOrderCash(input)).resolves.toEqual(result); noWrites();
  await expect(collectOrderCash({ ...input, note: "conflicting" })).rejects.toMatchObject({ statusCode: 409 }); noWrites();
});
it("hands off only current bound custody to a scoped owned warehouse", async () => {
  held(); const result = await handoffOrderCash({ ...input, operationId: "handoff-key-a", expectedEventId: eventId, toHolderType: "warehouse", toWarehouseId: "warehouse-a" });
  expect(result.cashCollections[0].currentHolderWarehouseId).toBe("warehouse-a");
});
it("allows collection at the verified scoped current warehouse", async () => {
  order.assignedDriverId = "other-driver"; order.currentWarehouseId = "warehouse-a";
  membership.user.warehouseId = "warehouse-a";
  const result = await collectOrderCash(input);
  expect(result.cashCollections[0]).toMatchObject({ currentHolderType: "warehouse", currentHolderUserId: null, currentHolderWarehouseId: "warehouse-a" });
});
it.each(["stale-event", "foreign-warehouse", "wrong-custodian", "unaccepted", "mismatched-receipt", "changed-amount", "foreign-driver"])("rejects handoff %s without writes", async kind => {
  held(); const request: any = { ...input, operationId: "handoff-key-a", expectedEventId: eventId, toHolderType: "warehouse", toWarehouseId: "warehouse-a" };
  if (kind === "stale-event") request.expectedEventId = "019b0000-0000-7000-8b00-000000000002";
  if (kind === "foreign-warehouse") db.warehouse.findFirst.mockResolvedValue(null);
  if (kind === "wrong-custodian") collection.currentHolderUserId = "user-b";
  if (kind === "unaccepted") receipt = null;
  if (kind === "mismatched-receipt") receipt.companyId = "company-b";
  if (kind === "changed-amount") collection.collectedAmount = 1;
  if (kind === "foreign-driver") { request.toHolderType = "driver"; request.toDriverId = "foreign-driver"; request.toWarehouseId = null; }
  await expect(handoffOrderCash(request)).rejects.toBeDefined(); noWrites();
});
it("enforces maker-checker separation and allows a distinct scoped checker", async () => {
  held(); const request = { ...input, operationId: "settle-key-a", expectedEventId: eventId };
  await expect(settleOrderCash(request)).rejects.toMatchObject({ statusCode: 403 }); noWrites();
  membership.user.id = "checker"; membership.userId = "checker"; membership.tenantMembership.userId = "checker";
  const result = await settleOrderCash({ ...request, actor: { ...actor, id: "checker" } });
  expect(result.cashCollections[0]).toMatchObject({ status: "settled", currentHolderType: "finance", collectedAmount: "100.25" });
});
it("rejects alternate HTTP ownership/amount inputs, including bulk items", async () => {
  await expect(collectCashForActor({ actor, orderId: "order-a", body: { kind: "cod", operationId: "collect-key-a", amount: 1 } })).rejects.toBeDefined();
  await expect(collectCashBulkForActor({ actor, body: { items: [{ orderId: "order-a", kind: "cod", operationId: "collect-key-a", tenantId: "tenant-b" }] } })).rejects.toBeDefined(); noWrites();
});
it("scopes queue rows and empty summaries to fresh selected context", async () => {
  await listCashQueueForActor({ actor });
  expect(JSON.stringify(db.cashCollection.findMany.mock.calls[0][0].where)).toContain('"ownerOrgId":"company-a"');
  expect(JSON.stringify(db.cashCollection.count.mock.calls[0][0].where)).toContain('"tenantId":"tenant-a"');
  await expect(getCashQueueSummaryForActor({ actor })).resolves.toMatchObject({ totalCount: 0 });
});
