jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/identity-access/access-control",()=>({loadAccessSnapshot:jest.fn(),hasAnyPermissionSync:jest.fn(()=>true)}));
jest.mock("../../src/modules/customers-core/application/customerEntityRepo",()=>({requireCustomerEntityReference:jest.fn()}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async(request:any)=>{request.user=actor;}}));
jest.mock("../../src/config/redis",()=>({getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"test",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work()}));
jest.mock("../../src/modules/analytics-core/realtime/analyticsEvents",()=>({buildCargoPilotDomainEvent:jest.fn()}));
import Fastify from "fastify";
import { database } from "./fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { requireCustomerEntityReference } from "../../src/modules/customers-core/application/customerEntityRepo";
import { prismaFinanceSubledgerRepository as repo } from "../../src/modules/finance-core/infrastructure/prisma-finance-subledger.repository";
import routes from "../../src/modules/finance-core/transport/fastify-routes";

const actor:any={id:"u",tenantId:"t",tenantMembershipId:"tm",companyId:"c",companyMembershipId:"cm",membershipId:"cm"};
const snapshot:any={...actor,userId:"u",permissionCodes:["finance.receivables.read","finance.payables.read"],scopes:[{scopeType:"company",scopeRefId:"c"}]};
const id="11111111-1111-4111-8111-111111111111";
const operations=["getReceivablesAging","getPayablesAging","listUnappliedCash"] as const;
const page=(op:string)=>op==="listUnappliedCash"?{limit:10}:{limit:10,asOf:new Date("2026-01-01")};
beforeEach(()=>{
  jest.clearAllMocks();jest.mocked(loadAccessSnapshot).mockResolvedValue(snapshot);
  database.membershipScope.findFirst.mockReset().mockResolvedValue({id:"grant"});
  database.financeLegalEntity.findFirst.mockReset().mockResolvedValue({id:"entity"});
  database.integrationProvider.findFirst.mockReset().mockResolvedValue({id});
  database.$transaction.mockReset().mockImplementation((fn:any)=>fn(database));
  database.$executeRaw.mockReset().mockResolvedValue(0);
  database.$queryRaw.mockReset().mockResolvedValue([]);
  database.financeUnappliedCashApplication.findMany.mockReset().mockResolvedValue([]);
  jest.mocked(requireCustomerEntityReference).mockResolvedValue({id,tenantId:"t"});
});
afterEach(()=>{
  for(const model of ["financeLegalEntity","financeReceivableItem","financePayableItem","financeUnappliedCash","financeAuditEvent","financeDomainEventOutbox"])
    for(const method of ["create","update","updateMany","upsert","delete"])expect(database[model][method]).not.toHaveBeenCalled();
});
it.each(operations)("%s requires fresh selected permission and read-only bounded transaction",async op=>{
  expect(await repo[op](actor,page(op) as any)).toMatchObject({items:[]});
  expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({requireFresh:true,companyMembershipId:"cm",tenantId:"t"}));
  expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:"RepeatableRead",maxWait:2000,timeout:10000});
  expect(database.$executeRaw.mock.calls[0][0][0]).toBe("SET TRANSACTION READ ONLY");
  const sql=database.$queryRaw.mock.calls.map((a:any[])=>a[0].text).join(" ");
  expect(sql).toContain('"tenantId"');expect(sql).toContain('"companyId"');expect(sql).not.toContain("SELECT *");
});
it.each(operations)("%s rejects missing context before protected lookup",async op=>{
  await expect(repo[op](null as any,page(op) as any)).rejects.toMatchObject({statusCode:403});
  expect(database.financeLegalEntity.findFirst).not.toHaveBeenCalled();expect(database.$transaction).not.toHaveBeenCalled();
});
it.each([null,{...snapshot,permissionCodes:[]},{...snapshot,tenantId:"foreign"},{...snapshot,companyId:"foreign"},{...snapshot,scopes:[]}])("all reads reject current revoked/mismatched context",async value=>{
  jest.mocked(loadAccessSnapshot).mockResolvedValue(value);
  for(const op of operations)await expect(repo[op](actor,page(op) as any)).rejects.toMatchObject({statusCode:403});
  expect(database.$queryRaw).not.toHaveBeenCalled();
});
it("missing explicit stored scope denies all reads",async()=>{
  database.membershipScope.findFirst.mockResolvedValue(null);
  for(const op of operations)await expect(repo[op](actor,page(op) as any)).rejects.toMatchObject({code:"FINANCE_COMPANY_SCOPE_REQUIRED"});
  expect(database.$transaction).not.toHaveBeenCalled();
});
it.each(operations)("%s hides null/inactive/unconfigured entity",async op=>{
  database.financeLegalEntity.findFirst.mockResolvedValue(null);
  await expect(repo[op](actor,page(op) as any)).rejects.toMatchObject({statusCode:404});expect(database.$transaction).not.toHaveBeenCalled();
});
it.each([{limit:0},{limit:101},{limit:10,companyId:"foreign"},{limit:10,cursor:"bad"}])("alternate callers cannot bypass page/ownership allowlist",async value=>{
  await expect(repo.listUnappliedCash(actor,value as any)).rejects.toMatchObject({statusCode:400});expect(database.$transaction).not.toHaveBeenCalled();
});
it("foreign or inaccessible customer filter uses existing customer access control",async()=>{
  jest.mocked(requireCustomerEntityReference).mockRejectedValue(Object.assign(new Error("Not found"),{statusCode:404}));
  await expect(repo.getReceivablesAging(actor,{...page("aging"),customerEntityId:id} as any)).rejects.toMatchObject({statusCode:404});
  expect(requireCustomerEntityReference).toHaveBeenCalledWith(actor,id);expect(database.$transaction).not.toHaveBeenCalled();
});
it("foreign or non-carrier provider filter denies without SQL",async()=>{
  database.integrationProvider.findFirst.mockResolvedValue(null);
  await expect(repo.getPayablesAging(actor,{...page("aging"),carrierProviderId:id} as any)).rejects.toMatchObject({statusCode:404});expect(database.$transaction).not.toHaveBeenCalled();
});
it.each(operations)("%s rejects foreign/filtered cursor",async op=>{
  await expect(repo[op](actor,{...page(op),cursor:id} as any)).rejects.toMatchObject({code:"FINANCE_AGING_CURSOR_INVALID"});
});
it.each(operations)("%s rejects inconsistent allocations rather than reporting a partial balance",async op=>{
  database.$queryRaw.mockResolvedValueOnce([{id}]);await expect(repo[op](actor,page(op) as any)).rejects.toMatchObject({code:"FINANCE_SUBLEDGER_REFERENCE_CONFLICT"});
  expect(database.$queryRaw).toHaveBeenCalledTimes(1);
});
it("cash children use a bounded allowlist and overflow fails closed",async()=>{
  database.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{id}]).mockResolvedValueOnce([]);
  database.financeUnappliedCashApplication.findMany.mockResolvedValue(Array(1001).fill({}));
  await expect(repo.listUnappliedCash(actor,{limit:10})).rejects.toMatchObject({code:"FINANCE_SUBLEDGER_DETAIL_LIMIT"});
  const query=database.financeUnappliedCashApplication.findMany.mock.calls[0][0];expect(query.take).toBe(1001);
  for(const key of ["metadataJson","idempotencyKey","sourceEventId","receivableId"])expect(query.select).not.toHaveProperty(key);
});
it("HTTP endpoints pass actor and reject request ownership fields",async()=>{
  const app=Fastify();await app.register(routes);
  try{for(const url of ["/receivables/aging?asOf=2026-01-01","/payables/aging?asOf=2026-01-01","/receivables/unapplied-cash"]){expect((await app.inject({method:"GET",url:url+(url.includes("?")?"&":"?")+"companyId=foreign"})).statusCode).toBe(400);expect((await app.inject({method:"GET",url})).statusCode).toBe(200);}}
  finally{await app.close();}
},15000);
