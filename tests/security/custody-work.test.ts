jest.mock("../../src/modules/identity-access/application/driver-eligibility", () => ({ requireAcceptedDriver: jest.fn() }));
import { requireAcceptedDriver } from "../../src/modules/identity-access/application/driver-eligibility";
jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: require("./fixtures").database }));
jest.mock("../../src/modules/orders-core/domain/custody-access", () => ({ requireCustodyActor: jest.fn(), requireCustodyReadActor: jest.fn(), requireCustodyDriver: jest.fn() }));
import { database as db } from "./fixtures";
import { listCustodyWork } from "../../src/modules/orders-core/read/custody-work";
import { requireCustodyReadActor, requireCustodyActor, requireCustodyDriver } from "../../src/modules/orders-core/domain/custody-access";
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const actor = { id:id(1), tenantId:id(2), tenantMembershipId:id(3), companyId:id(4), companyMembershipId:id(5), membershipId:id(5),
  permissionCodes:["shipment.view","shipment.custody.intake"], scopes:[{scopeType:"warehouse",scopeRefId:id(6)}] };
beforeEach(() => {
  jest.clearAllMocks(); (requireAcceptedDriver as jest.Mock).mockResolvedValue({driverType:"linehaul"});
  (requireCustodyReadActor as jest.Mock).mockImplementation((a:any)=>(requireCustodyActor as jest.Mock)(a)); (requireCustodyActor as jest.Mock).mockResolvedValue(actor); (requireCustodyDriver as jest.Mock).mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn:any)=>fn(db)); db.$executeRawUnsafe.mockResolvedValue(0);
  db.warehouse.findMany.mockResolvedValue([{id:id(6)}]); db.user.findUnique.mockResolvedValue({driverType:"linehaul"}); db.$queryRaw.mockResolvedValue([]);
});
it("rejects invalid limits, extra filters and malformed cursors before a work query", async () => {
  for (const input of [{kind:"global"},{kind:"warehouse",limit:51},{kind:"driver",limit:0},{kind:"driver",tenantId:id(9)},{kind:"warehouse",cursor:"x".repeat(1025)},{kind:"warehouse",cursor:"invalid"}]) {
    await expect(listCustodyWork(actor as any,input)).rejects.toThrow();
  }
  expect(db.$queryRaw).not.toHaveBeenCalled();
});
it("rejects missing context without reaching database work", async () => {
  (requireCustodyActor as jest.Mock).mockRejectedValue(Error("Missing context"));
  await expect(listCustodyWork({} as any,{kind:"warehouse"})).rejects.toThrow();
  expect(db.$transaction).not.toHaveBeenCalled(); expect(db.$queryRaw).not.toHaveBeenCalled();
});
it("company scope and view permission alone cannot discover warehouse or driver work", async () => {
  (requireCustodyActor as jest.Mock).mockResolvedValue({...actor,permissionCodes:["shipment.view"],scopes:[{scopeType:"company",scopeRefId:actor.companyId}]});
  await expect(listCustodyWork(actor as any,{kind:"warehouse"})).rejects.toThrow();
  await expect(listCustodyWork(actor as any,{kind:"driver"})).rejects.toThrow();
  expect(db.$queryRaw).not.toHaveBeenCalled();
});
it("denied current driver eligibility and excessive warehouse scopes fail before work reads", async () => {
  (requireCustodyActor as jest.Mock).mockResolvedValue({...actor,permissionCodes:["shipment.view","shipment.custody.transport-accept"]});
  (requireCustodyDriver as jest.Mock).mockRejectedValue(Error("Suspended"));
  await expect(listCustodyWork(actor as any,{kind:"driver"})).rejects.toThrow();
  (requireCustodyActor as jest.Mock).mockResolvedValue({...actor,scopes:Array.from({length:101},(_,i)=>({scopeType:"warehouse",scopeRefId:id(i+10)}))});
  await expect(listCustodyWork(actor as any,{kind:"warehouse"})).rejects.toThrow();
  expect(db.$queryRaw).not.toHaveBeenCalled();
});
it("scope, permission, membership and list-kind changes invalidate an existing cursor", async () => {
  db.$queryRaw.mockResolvedValue([1,2].map(n=>({orderId:id(20+n),orderNumber:"Synthetic",status:"picked_up",expectedUpdatedAt:new Date(0),expectedEventId:id(30+n),phase:"pickup-offered",currentWarehouseId:null,destinationWarehouseId:id(6),legId:null})));
  const first=await listCustodyWork(actor as any,{kind:"warehouse",limit:1}); expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
  db.$queryRaw.mockClear();
  for(const change of [{scopes:[]},{permissionCodes:["shipment.view"]},{companyMembershipId:id(9)},{tenantMembershipId:id(10)}]) {
    (requireCustodyActor as jest.Mock).mockResolvedValue({...actor,...change});
    await expect(listCustodyWork(actor as any,{kind:"warehouse",limit:1,cursor:first.nextCursor})).rejects.toThrow("cursor");
  }
  (requireCustodyActor as jest.Mock).mockResolvedValue(actor);
  await expect(listCustodyWork(actor as any,{kind:"driver",limit:1,cursor:first.nextCursor})).rejects.toThrow("cursor");
  expect(db.$queryRaw).not.toHaveBeenCalled();
});

it("initial pickup discovery keeps the existing fields with null journal identity and owned assignment predicates", async () => {
  (requireCustodyActor as jest.Mock).mockResolvedValue({...actor,scopes:[],permissionCodes:["shipment.view","shipment.changeStatus"]});
  (requireAcceptedDriver as jest.Mock).mockResolvedValue({driverType:"local"});
  db.$queryRaw.mockResolvedValue([{orderId:id(21),orderNumber:"Synthetic",status:"assigned",expectedUpdatedAt:new Date(0),expectedEventId:null,phase:"pickup-assigned",currentWarehouseId:null,destinationWarehouseId:null,legId:null}]);
  const result=await listCustodyWork(actor as any,{kind:"driver"});
  expect(result.items[0]).toMatchObject({phase:"pickup-assigned",expectedEventId:null,status:"assigned"});
  const call=(requireCustodyDriver as jest.Mock).mock.calls[0];
  expect(call[0]).toBe(db);expect(call[1]).toMatchObject({companyMembershipId:actor.companyMembershipId});expect(call.slice(2)).toEqual([actor.companyMembershipId,"local","shipment.changeStatus"]);
  const query=db.$queryRaw.mock.calls[0];
  const sql=query[0].join("?")+query.slice(1).filter((v:any)=>v && typeof v === "object" && typeof v.sql === "string").map((v:any)=>v.sql).join("?");
  expect(sql).toContain("LEFT JOIN LATERAL");expect(sql).toContain('o."assignedDriverId"');expect(sql).toContain('o."ownerOrgId"');expect(sql).toContain("NOT EXISTS");
});
