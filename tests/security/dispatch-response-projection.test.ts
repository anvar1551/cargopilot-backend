jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventsTx: jest.fn(async () => undefined) }));
import { database as db } from "./fixtures";
import { assignDriversBulk, updateOrdersStatusBulk, updateDriverOrderStatus } from "../../src/modules/orders-core/operations/order-status";
import { enqueueCargoPilotDomainEventsTx } from "../../src/modules/analytics-core/infrastructure/analyticsOutbox";
const actor = { id: "synthetic-actor", tenantId: "synthetic-tenant", companyId: "synthetic-company", scopes: [{ scopeType: "company" as const, scopeRefId: "synthetic-company" }] };
const summary = { id: "synthetic-order", orderNumber: "synthetic-number", status: "assigned", assignedDriverId: "synthetic-driver", currentWarehouseId: null, updatedAt: new Date("2026-10-03T00:00:00Z") };
const summarySelect = { id: true, orderNumber: true, status: true, assignedDriverId: true, currentWarehouseId: true, updatedAt: true };
beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.user.findUnique.mockResolvedValue({ id: summary.assignedDriverId, driverType: "local" });
  db.companyMembership.findFirst.mockResolvedValue({ id: "synthetic-driver-membership" });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.tracking.createMany.mockResolvedValue({ count: 1 }); db.tracking.create.mockResolvedValue({});
  db.order.findMany.mockReset(); db.order.findFirst.mockReset();
});
function assertResponseQuery(query: any) {
  expect(query.select).toEqual(summarySelect); expect(query.include).toBeUndefined();
  expect(JSON.stringify(query.where)).toContain(actor.tenantId); expect(JSON.stringify(query.where)).toContain(actor.companyId);
}
it.each([false, true])("assignment includeFull=%s returns only the explicit summary", async includeFull => {
  db.order.findMany.mockResolvedValueOnce([{ ...summary, status: "pending" }]).mockImplementation(async (query: any) => { assertResponseQuery(query); return [summary]; });
  expect(await assignDriversBulk({ orderIds: [summary.id], driverId: summary.assignedDriverId, actor, includeFull })).toEqual([summary]);
  expect(db.order.updateMany).toHaveBeenCalled(); expect(enqueueCargoPilotDomainEventsTx).toHaveBeenCalledTimes(1);
});
it.each([false, true])("bulk status includeFull=%s uses the same minimized response", async includeFull => {
  db.order.findMany.mockResolvedValueOnce([{ ...summary, cashCollections: [], codAmount: null, serviceCharge: null }]).mockImplementation(async (query: any) => { assertResponseQuery(query); return [summary]; });
  expect(await updateOrdersStatusBulk({ orderIds: [summary.id], status: "exception", reasonCode: "NO_CAPACITY_PICKUP", actor, includeFull })).toEqual([summary]);
  expect(enqueueCargoPilotDomainEventsTx).toHaveBeenCalledTimes(1);
});
it("driver mutation retains its authorized summary contract", async () => {
  const driverActor = { ...actor, id: summary.assignedDriverId };
  db.order.findFirst.mockResolvedValueOnce({ ...summary, cashCollections: [], codAmount: null, serviceCharge: null }).mockImplementation(async (query: any) => { assertResponseQuery(query); return summary; });
  expect(await updateDriverOrderStatus({ orderId: summary.id, status: "pickup_in_progress", actor: driverActor })).toEqual(summary);
});
it("out-of-scope mutation never reads a response or writes business events", async () => {
  db.order.findMany.mockResolvedValue([]);
  await expect(updateOrdersStatusBulk({ orderIds: [summary.id], status: "exception", reasonCode: "NO_CAPACITY_PICKUP", actor, includeFull: true })).rejects.toMatchObject({ statusCode: 403 });
  expect(db.order.findMany).toHaveBeenCalledTimes(1); expect(db.order.updateMany).not.toHaveBeenCalled(); expect(db.tracking.createMany).not.toHaveBeenCalled(); expect(enqueueCargoPilotDomainEventsTx).not.toHaveBeenCalled();
});
