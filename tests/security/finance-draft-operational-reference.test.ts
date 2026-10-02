jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/identity-access/access-control",()=>({buildOrderScopeWhere:jest.fn()}));
jest.mock("../../src/modules/customers-core/application/customerAccess",()=>({requireCustomerAccess:jest.fn()}));
jest.mock("../../src/modules/warehouse-core/application/warehouseAccess",()=>({requireWarehouseAccess:jest.fn()}));
jest.mock("../../src/modules/identity-access/application/managementAccess",()=>({requireIdentityManagementContext:jest.fn()}));
import { requireDraftOperationalReferences as validate } from "../../src/modules/finance-core/infrastructure/draft-operational-references";
import { buildOrderScopeWhere } from "../../src/modules/identity-access/access-control";
import { requireCustomerAccess } from "../../src/modules/customers-core/application/customerAccess";
import { requireWarehouseAccess } from "../../src/modules/warehouse-core/application/warehouseAccess";
import { requireIdentityManagementContext } from "../../src/modules/identity-access/application/managementAccess";
import { database } from "./fixtures";
const id=(n:number)=>`aaaaaaaa-aaaa-aaaa-aaaa-${String(n).padStart(12,"0")}`;
const actor:any={id:id(1),tenantId:id(2),companyId:id(3),tenantMembershipId:id(4),companyMembershipId:id(5),membershipId:id(5)};
const owner={tenantId:actor.tenantId,companyId:actor.companyId};
const line={orderId:id(10),orderLegId:id(11),customerEntityId:id(12),warehouseId:id(13),carrierProviderId:id(14)};
const orderScope={AND:[{tenantId:owner.tenantId},{currentWarehouseId:id(13)}]};
beforeEach(()=>{
  jest.clearAllMocks();
  jest.mocked(buildOrderScopeWhere).mockResolvedValue(orderScope);
  jest.mocked(requireCustomerAccess).mockResolvedValue({customerWhere:{tenantId:owner.tenantId,id:id(12)}}as any);
  jest.mocked(requireWarehouseAccess).mockResolvedValue({where:{tenantId:owner.tenantId,id:{in:[id(13)]}}}as any);
  jest.mocked(requireIdentityManagementContext).mockResolvedValue(actor);
  database.$queryRaw.mockReset().mockResolvedValue([]);
  database.order.findMany.mockReset().mockResolvedValue([{id:line.orderId,tenantId:owner.tenantId,ownerOrgId:owner.companyId,customerEntityId:line.customerEntityId}]);
  database.orderLeg.findMany.mockReset().mockResolvedValue([{id:line.orderLegId,orderId:line.orderId,carrierProviderId:line.carrierProviderId}]);
  database.customerEntity.findMany.mockReset().mockResolvedValue([{id:line.customerEntityId,tenantId:owner.tenantId}]);
  database.warehouse.findMany.mockReset().mockResolvedValue([{id:line.warehouseId,tenantId:owner.tenantId}]);
  database.integrationProvider.findMany.mockReset().mockResolvedValue([{id:line.carrierProviderId,companyId:owner.companyId,domain:"carrier",status:"active"}]);
});
afterEach(()=>{for(const model of ["financeJournalLine","financeJournalEntry","financeDocument","financeAuditEvent","financeDomainEventOutbox"])for(const op of ["create","update","updateMany","delete","upsert"])expect(database[model][op]).not.toHaveBeenCalled();});
it("valid scoped references use bounded bulk queries and transactional share locks without effects",async()=>{
  await validate(database,actor,[line,line],owner);
  expect(buildOrderScopeWhere).toHaveBeenCalledWith(actor,"shipment.view");expect(requireCustomerAccess).toHaveBeenCalledWith(actor,"customers.read");expect(requireWarehouseAccess).toHaveBeenCalledWith(actor,"shipment.view");expect(requireIdentityManagementContext).toHaveBeenCalledWith(actor,"integration.provider.read");
  expect(database.$queryRaw).toHaveBeenCalledTimes(5);for(const [sql]of database.$queryRaw.mock.calls){expect(sql.text).toContain("ORDER BY id FOR SHARE");expect(sql.values).toHaveLength(1);}
  expect(database.order.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{AND:[{id:{in:[line.orderId]},tenantId:owner.tenantId,ownerOrgId:owner.companyId},orderScope]}}));
  expect(database.warehouse.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{AND:[{id:{in:[line.warehouseId]},tenantId:owner.tenantId},{tenantId:owner.tenantId,id:{in:[line.warehouseId]}}]}}));
});
it("ordinary reference-free drafts require no additional operational queries",async()=>{await validate(database,actor,[{}],owner);expect(database.$queryRaw).not.toHaveBeenCalled();expect(buildOrderScopeWhere).not.toHaveBeenCalled();});
it.each([null,{...actor,tenantId:null},{...actor,companyId:id(99)},{...actor,membershipId:id(99)}])("missing/conflicting context rejects before protected work",async value=>{await expect(validate(database,value,[line],owner)).rejects.toMatchObject({code:"FINANCE_DRAFT_REFERENCE_REJECTED"});expect(database.$queryRaw).not.toHaveBeenCalled();});
it.each([{orderLegId:line.orderLegId},{orderId:""},{customerEntityId:7},{warehouseId:"foreign"}])("malformed or unbound references reject before queries",async value=>{await expect(validate(database,actor,[value as any],owner)).rejects.toMatchObject({code:"FINANCE_DRAFT_REFERENCE_REJECTED"});expect(database.$queryRaw).not.toHaveBeenCalled();});
it.each(["order","customer","warehouse","provider"])("missing %s permission/scope rejects before locks",async kind=>{
  if(kind==="order")jest.mocked(buildOrderScopeWhere).mockResolvedValue({id:"__no_access__"});
  if(kind==="customer")jest.mocked(requireCustomerAccess).mockRejectedValue(Object.assign(Error("Denied"),{statusCode:403}));
  if(kind==="warehouse")jest.mocked(requireWarehouseAccess).mockRejectedValue(Object.assign(Error("Denied"),{statusCode:403}));
  if(kind==="provider")jest.mocked(requireIdentityManagementContext).mockRejectedValue(Object.assign(Error("Denied"),{statusCode:403}));
  await expect(validate(database,actor,[line],owner)).rejects.toThrow();expect(database.$queryRaw).not.toHaveBeenCalled();
});
it.each(["order","orderLeg","customerEntity","warehouse","integrationProvider"])("unowned, foreign or scope-filtered %s cannot be accepted",async model=>{database[model].findMany.mockResolvedValue([]);await expect(validate(database,actor,[line],owner)).rejects.toMatchObject({code:"FINANCE_DRAFT_REFERENCE_REJECTED"});});
it.each(["order-tenant","order-company","customer-tenant","warehouse-tenant","provider-company","provider-disabled","provider-domain","leg-order","order-customer","leg-provider"])("conflicting %s graph rejects",async kind=>{
  if(kind.startsWith("order-")&&kind!=="order-customer")database.order.findMany.mockResolvedValue([{id:line.orderId,tenantId:kind==="order-tenant"?id(99):owner.tenantId,ownerOrgId:kind==="order-company"?id(99):owner.companyId,customerEntityId:line.customerEntityId}]);
  if(kind==="customer-tenant")database.customerEntity.findMany.mockResolvedValue([{id:line.customerEntityId,tenantId:null}]);
  if(kind==="warehouse-tenant")database.warehouse.findMany.mockResolvedValue([{id:line.warehouseId,tenantId:id(99)}]);
  if(kind.startsWith("provider-"))database.integrationProvider.findMany.mockResolvedValue([{id:line.carrierProviderId,companyId:kind==="provider-company"?id(99):owner.companyId,status:kind==="provider-disabled"?"disabled":"active",domain:kind==="provider-domain"?"sms":"carrier"}]);
  if(kind==="leg-order"||kind==="leg-provider")database.orderLeg.findMany.mockResolvedValue([{id:line.orderLegId,orderId:kind==="leg-order"?id(99):line.orderId,carrierProviderId:kind==="leg-provider"?id(99):line.carrierProviderId}]);
  if(kind==="order-customer")database.order.findMany.mockResolvedValue([{id:line.orderId,tenantId:owner.tenantId,ownerOrgId:owner.companyId,customerEntityId:id(99)}]);
  await expect(validate(database,actor,[line],owner)).rejects.toMatchObject({code:"FINANCE_DRAFT_REFERENCE_REJECTED"});
});
it("bounds line count before any work",async()=>{await expect(validate(database,actor,Array(501).fill(line),owner)).rejects.toMatchObject({code:"FINANCE_DRAFT_REFERENCE_REJECTED"});expect(database.$queryRaw).not.toHaveBeenCalled();});
