jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/identity-access/access-control",()=>({buildOrderScopeWhere:jest.fn()}));
jest.mock("../../src/modules/live-map-core/infrastructure/liveMapStore",()=>({publishLiveMapEvent:jest.fn(),readDriverLocation:jest.fn(),readDriverIdsInViewport:jest.fn(),readDriverLocations:jest.fn(),readDriverLocationsInViewport:jest.fn(),readDriverPresences:jest.fn(),touchDriverPresenceHeartbeat:jest.fn(),upsertDriverLocation:jest.fn(),upsertDriverPresence:jest.fn()}));
import {getLiveMapSnapshot} from "../../src/modules/live-map-core/application/liveMapService";
import {buildOrderScopeWhere} from "../../src/modules/identity-access/access-control";
import * as store from "../../src/modules/live-map-core/infrastructure/liveMapStore";
import {database as db} from "./fixtures";
const actor=(suffix="a",tenant="tenant-a"):any=>({id:"same-user",tenantId:tenant,companyId:"company-"+suffix,companyMembershipId:"cm-"+suffix,membershipId:"cm-"+suffix,tenantMembershipId:"tm-"+tenant,permissionCodes:["shipment.view","drivers.manage"]});
const marker=(id:string)=>({id,orderNumber:"synthetic-number",status:"pending",pickupLat:53.1,pickupLng:8.2,dropoffLat:53.2,dropoffLng:8.3,assignedDriverId:"PRIVATE-CANARY",currentWarehouseId:"PRIVATE-CANARY",currentWarehouse:{region:"PRIVATE-CANARY"}});
beforeEach(()=>{jest.clearAllMocks();(buildOrderScopeWhere as jest.Mock).mockImplementation(async actor=>({tenantId:actor.tenantId,ownerOrgId:actor.companyId}));db.order.findMany.mockResolvedValue([marker("order-a")]);});
afterEach(()=>{for(const fn of Object.values(store))if(typeof fn==="function")expect(fn).not.toHaveBeenCalled();expect(db.user.findMany).not.toHaveBeenCalled();expect(db.warehouse.findMany).not.toHaveBeenCalled();expect(db.order.create).not.toHaveBeenCalled();});
it("fresh selected order markers preserve the response envelope but never expose unowned telemetry",async()=>{
  const user=actor(),scope={tenantId:user.tenantId,ownerOrgId:user.companyId};const result=await getLiveMapSnapshot({actor:user});
  expect(buildOrderScopeWhere).toHaveBeenCalledWith(user,"shipment.view");expect(db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{AND:[{tenantId:user.tenantId},scope,{},expect.any(Object)]},take:180,select:{id:true,orderNumber:true,status:true,pickupLat:true,pickupLng:true,dropoffLat:true,dropoffLng:true}}));
  expect(result).toMatchObject({orders:[{id:"order-a",assignedDriverId:null,warehouseId:null,region:null}],drivers:[],warehouses:[],isPartial:true,isMock:false});expect(JSON.stringify(result)).not.toContain("PRIVATE-CANARY");
});
it("one user's tenant/company selections never reuse a snapshot or query scope",async()=>{
  db.order.findMany.mockResolvedValueOnce([marker("a")]).mockResolvedValueOnce([marker("b")]).mockResolvedValueOnce([marker("c")]);
  const users=[actor(),actor("b"),actor("c","tenant-b")];const snapshots=[];
  for(const user of users)snapshots.push(await getLiveMapSnapshot({actor:user}));expect(snapshots.map(s=>s.orders[0].id)).toEqual(["a","b","c"]);
  expect(buildOrderScopeWhere).toHaveBeenCalledTimes(3);expect(db.order.findMany).toHaveBeenCalledTimes(3);users.forEach((user,i)=>expect(db.order.findMany.mock.calls[i][0].where.AND[0]).toEqual({tenantId:user.tenantId}));
});
it.each(["tenantId","companyMembershipId","tenantMembershipId","companyId"])("missing %s denies before queries or Redis",async field=>{
  await expect(getLiveMapSnapshot({actor:{...actor(),[field]:null}})).rejects.toMatchObject({statusCode:403});expect(buildOrderScopeWhere).not.toHaveBeenCalled();expect(db.order.findMany).not.toHaveBeenCalled();
});
it.each([null,{id:"__no_access__"}])("denies absent permission/scope, including a manager claim",async scope=>{
  (buildOrderScopeWhere as jest.Mock).mockResolvedValue(scope);await expect(getLiveMapSnapshot({actor:actor()})).rejects.toMatchObject({statusCode:403});expect(db.order.findMany).not.toHaveBeenCalled();
});
it("preserves restricted object scope inside one tenant and applies viewport predicates alongside it",async()=>{
  const scope={tenantId:"tenant-a",id:{in:["owned-object"]}};(buildOrderScopeWhere as jest.Mock).mockResolvedValue(scope);
  await getLiveMapSnapshot({actor:actor(),viewport:{minLat:50,maxLat:55,minLng:5,maxLng:10}});expect(db.order.findMany.mock.calls[0][0].where.AND).toEqual([{tenantId:"tenant-a"},scope,{OR:[{pickupLat:{gte:50,lte:55},pickupLng:{gte:5,lte:10}},{dropoffLat:{gte:50,lte:55},dropoffLng:{gte:5,lte:10}}]},expect.any(Object)]);
});
it("current scope removal denies subsequent reads without a cached snapshot",async()=>{
  await getLiveMapSnapshot({actor:actor()});(buildOrderScopeWhere as jest.Mock).mockResolvedValue({id:"__no_access__"});await expect(getLiveMapSnapshot({actor:actor()})).rejects.toMatchObject({statusCode:403});expect(db.order.findMany).toHaveBeenCalledTimes(1);
});
it("malformed viewport does not become a broader query",async()=>{
  await expect(getLiveMapSnapshot({actor:actor(),viewport:{minLat:NaN,maxLat:55,minLng:5,maxLng:10}})).rejects.toMatchObject({statusCode:400});expect(db.order.findMany).not.toHaveBeenCalled();
});
