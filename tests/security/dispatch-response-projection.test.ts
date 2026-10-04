jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/analytics-core/infrastructure/analyticsOutbox", () => ({ enqueueCargoPilotDomainEventsTx: jest.fn(async () => undefined) }));
jest.mock("../../src/modules/identity-access/access-control", () => ({ loadAccessSnapshot: jest.fn(), buildMembershipOrderScopeWhere: jest.fn() }));
import { loadAccessSnapshot, buildMembershipOrderScopeWhere } from "../../src/modules/identity-access/access-control";
import { database as db } from "./fixtures";
import { assignDriversBulk, updateOrdersStatusBulk, updateDriverOrderStatus } from "../../src/modules/orders-core/operations/order-status";
import { enqueueCargoPilotDomainEventsTx } from "../../src/modules/analytics-core/infrastructure/analyticsOutbox";
const actor = { id: "synthetic-actor", membershipId:"synthetic-membership",companyMembershipId:"synthetic-membership",tenantMembershipId:"synthetic-tenant-member",tenantId: "synthetic-tenant", companyId: "synthetic-company", scopes: [{ scopeType: "company" as const, scopeRefId: "synthetic-company" }] };
const summary = { id: "synthetic-order", orderNumber: "synthetic-number", status: "assigned", assignedDriverId: "synthetic-driver", currentWarehouseId: null, updatedAt: new Date("2026-10-03T00:00:00Z") };
const expected = (row:any) => [{orderId:row.id,updatedAt:row.updatedAt.toISOString(),status:row.status,assignedDriverId:row.assignedDriverId,currentWarehouseId:row.currentWarehouseId}];
const summarySelect = { id: true, orderNumber: true, status: true, assignedDriverId: true, currentWarehouseId: true, updatedAt: true };
beforeEach(() => {
  jest.clearAllMocks();
  db.orderCustodyAction.count.mockResolvedValue(0);
  db.$executeRawUnsafe.mockResolvedValue(0);
  db.$queryRaw.mockResolvedValue([{id:"synthetic-order"}]);
  (loadAccessSnapshot as jest.Mock).mockResolvedValue({...actor,userId:actor.id,permissionCodes:["shipment.assignCourier","shipment.changeStatus"],roleCodes:[],warehouseId:null});
  (buildMembershipOrderScopeWhere as jest.Mock).mockResolvedValue({tenantId:actor.tenantId,ownerOrgId:actor.companyId});
  db.$transaction.mockImplementation(async (fn: any) => { insideTransaction=true; try { return await fn(db); } finally { insideTransaction=false; } });
  db.user.findUnique.mockResolvedValue({ id: summary.assignedDriverId, driverType: "local" });
  db.companyMembership.findFirst.mockResolvedValue({ id: "synthetic-driver-membership",roles:[{role:{companyId:actor.companyId,isSystem:false,rolePermissions:[{permission:{key:"drivers.telemetry"}}]}}] });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.tracking.createMany.mockResolvedValue({ count: 1 }); db.tracking.create.mockResolvedValue({id:"tracking-a"}); db.tracking.findUnique.mockResolvedValue(null);
  db.order.findMany.mockReset(); db.order.findFirst.mockReset();
});
let insideTransaction = false;
function assertResponseQuery(query: any) {
  expect(query.select).toEqual(summarySelect); expect(query.include).toBeUndefined();
  expect(JSON.stringify(query.where)).toContain(actor.tenantId); expect(JSON.stringify(query.where)).toContain(actor.companyId);
}
it.each([false, true])("assignment includeFull=%s returns only the explicit summary", async includeFull => {
  db.order.findMany.mockResolvedValueOnce([{id:summary.id}]).mockResolvedValueOnce([{ ...summary, status: "pending" }]).mockImplementation(async (query: any) => { expect(insideTransaction).toBe(true); assertResponseQuery(query); return [summary]; });
  expect(await assignDriversBulk({ orderIds: [summary.id], expectedStates:expected({...summary,status:"pending"}), driverId: summary.assignedDriverId, actor, includeFull })).toEqual([summary]);
  expect(db.order.updateMany).toHaveBeenCalled(); expect(enqueueCargoPilotDomainEventsTx).toHaveBeenCalledTimes(1);
});
it.each([false, true])("bulk status includeFull=%s uses the same minimized response", async includeFull => {
  (loadAccessSnapshot as jest.Mock).mockResolvedValue({...actor,userId:summary.assignedDriverId,permissionCodes:["shipment.changeStatus"],roleCodes:[],warehouseId:null});
  db.order.findMany.mockResolvedValueOnce([{id:summary.id}]).mockResolvedValueOnce([{ ...summary,status:"out_for_delivery", cashCollections: [], codAmount: null, serviceCharge: null }]).mockImplementation(async (query: any) => { assertResponseQuery(query); return [summary]; });
  expect(await updateOrdersStatusBulk({ orderIds: [summary.id], expectedStates:expected({...summary,status:"out_for_delivery"}), status: "exception", reasonCode: "NO_CAPACITY_PICKUP", actor, includeFull })).toEqual([summary]);
  expect(enqueueCargoPilotDomainEventsTx).toHaveBeenCalledTimes(1);
});
it("driver mutation retains its authorized summary contract", async () => {
  const driverActor = { ...actor, id: summary.assignedDriverId };
  (loadAccessSnapshot as jest.Mock).mockResolvedValue({...driverActor,userId:driverActor.id,permissionCodes:["shipment.changeStatus"],roleCodes:[],warehouseId:null});
  db.order.findFirst.mockResolvedValueOnce({ ...summary, cashCollections: [], codAmount: null, serviceCharge: null }).mockResolvedValueOnce({ ...summary, cashCollections: [], codAmount: null, serviceCharge: null }).mockImplementation(async (query: any) => { expect(insideTransaction).toBe(true); assertResponseQuery(query); return summary; });
  expect(await updateDriverOrderStatus({ orderId: summary.id, status: "pickup_in_progress", actor: driverActor })).toEqual(summary);
});
it("out-of-scope mutation never reads a response or writes business events", async () => {
  db.order.findMany.mockResolvedValue([]);
  await expect(updateOrdersStatusBulk({ orderIds: [summary.id], status: "exception", reasonCode: "NO_CAPACITY_PICKUP", actor, expectedStates:expected(summary), includeFull: true })).rejects.toMatchObject({ statusCode: 403 });
  expect(db.order.findMany).toHaveBeenCalledTimes(1); expect(db.order.updateMany).not.toHaveBeenCalled(); expect(db.tracking.createMany).not.toHaveBeenCalled(); expect(enqueueCargoPilotDomainEventsTx).not.toHaveBeenCalled();
});
it.each([
  {name:"assignment",state:{...summary,assignedDriverId:"synthetic-other-driver"},status:"pickup_in_progress",message:"not assigned"},
  {name:"status",state:{...summary,status:"cancelled"},status:"pickup_in_progress",message:"final state"},
  {name:"cash",state:{...summary,status:"pickup_in_progress",deliveryChargePaidBy:"SENDER",cashCollections:[{kind:"service_charge",status:"expected",expectedAmount:5}]},status:"picked_up",message:"Collect cash first"},
])("driver rechecks $name after the lock before any write",async({state,status,message})=>{
  (loadAccessSnapshot as jest.Mock).mockResolvedValue({...actor,userId:summary.assignedDriverId,permissionCodes:["shipment.changeStatus"],roleCodes:[],warehouseId:null});
  db.order.findFirst.mockResolvedValueOnce(summary).mockResolvedValueOnce(state);
  await expect(updateDriverOrderStatus({actor:{...actor,id:summary.assignedDriverId},orderId:summary.id,status:status as any})).rejects.toThrow(message);
  expect(db.$queryRaw).toHaveBeenCalledTimes(1);expect(db.order.updateMany).not.toHaveBeenCalled();expect(db.tracking.create).not.toHaveBeenCalled();expect(enqueueCargoPilotDomainEventsTx).not.toHaveBeenCalled();
  expect(db.$transaction.mock.calls[0][1]).toEqual({isolationLevel:"ReadCommitted",maxWait:2000,timeout:10000});
});
it("missing lock target rejects without writes or a protected response",async()=>{
  (loadAccessSnapshot as jest.Mock).mockResolvedValue({...actor,userId:summary.assignedDriverId,permissionCodes:["shipment.changeStatus"],roleCodes:[],warehouseId:null});
  db.order.findFirst.mockResolvedValue(summary);db.$queryRaw.mockResolvedValueOnce([]);
  await expect(updateDriverOrderStatus({actor:{...actor,id:summary.assignedDriverId},orderId:summary.id,status:"pickup_in_progress"})).rejects.toMatchObject({statusCode:409});
  expect(db.order.findFirst).toHaveBeenCalledTimes(1);expect(db.order.updateMany).not.toHaveBeenCalled();expect(db.tracking.create).not.toHaveBeenCalled();expect(enqueueCargoPilotDomainEventsTx).not.toHaveBeenCalled();
});
