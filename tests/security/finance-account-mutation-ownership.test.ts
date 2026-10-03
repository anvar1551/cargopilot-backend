jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/config/redis",()=>({getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"synthetic",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work()}));
jest.mock("../../src/modules/identity-access/access-control",()=>({loadAccessSnapshot:jest.fn()}));
jest.mock("../../src/modules/identity-access/transport/fastify-auth",()=>({fastifyAuth:()=>async(request:any)=>{request.user=mockActor;}}));
import Fastify from "fastify";
import { database as db } from "./fixtures";
import { loadAccessSnapshot } from "../../src/modules/identity-access/access-control";
import { prismaFinanceRepository as repo } from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";
import { FinanceService } from "../../src/modules/finance-core/application/finance.service";
import routes from "../../src/modules/finance-core/transport/fastify-routes";
const mockActor:any={id:"user-a",tenantId:"tenant-a",tenantMembershipId:"tm-a",companyId:"company-a",companyMembershipId:"cm-a",membershipId:"cm-a"};
const snapshot:any={...mockActor,userId:mockActor.id,permissionCodes:["finance.accounts.manage"],scopes:[{scopeType:"company",scopeRefId:"company-a"}]};
const entity={id:"entity-a",tenantId:"tenant-a",companyId:"company-a",isActive:true,baseCurrency:"UZS",tenant:{status:"active"},company:{tenantId:"tenant-a",isActive:true}};
const command:any={companyId:"company-a",actorUserId:"user-a",code:"SYNTHETIC",name:"Synthetic account",type:"asset",allowPosting:false};
const chart:any={companyId:"company-a",actorUserId:"user-a",templateCode:"logistics_standard",templateVersion:1,accounts:[]};
const mutations=[db.financeAccount.create,db.financeChartTemplateInstallation.create,db.financeAuditEvent.create,db.financeDomainEventOutbox.create];
beforeEach(()=>{
 jest.clearAllMocks();jest.mocked(loadAccessSnapshot).mockResolvedValue(snapshot);db.membershipScope.findFirst.mockResolvedValue({id:"scope-a"});db.financeLegalEntity.findUnique.mockResolvedValue(entity);db.$transaction.mockImplementation((work:any)=>work(db));db.financeAccount.create.mockResolvedValue({id:"account-a",...command,legalEntityId:"entity-a"});db.financeAccount.findFirst.mockResolvedValue(null);db.financeAuditEvent.create.mockResolvedValue({id:"audit-a"});db.financeDomainEventOutbox.create.mockResolvedValue({id:"outbox-a"});db.financeChartTemplateInstallation.findUnique.mockResolvedValue({id:"installation-a",legalEntityId:"entity-a",accountCount:1});db.financeAccount.findMany.mockResolvedValue([{id:"account-a",legalEntityId:"entity-a"}]);
});
const denied=["missing-context","foreign-company","wrong-actor","permission","stored-scope","revoked-membership","null-tenant","foreign-tenant","inactive-company"];
it.each(["account","chart"])("authorized %s operation uses exact selected ownership",async kind=>{
 const result:any=kind==="account"?await repo.createAccount(command,mockActor):await repo.bootstrapChart(chart,mockActor);
 expect(result).toBeDefined();expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({requireFresh:true,tenantId:mockActor.tenantId,companyId:mockActor.companyId,companyMembershipId:mockActor.companyMembershipId}));
 expect(db.financeLegalEntity.findUnique).toHaveBeenCalledWith({where:{companyId:mockActor.companyId},include:{tenant:true,company:true}});
 if(kind==="account"){expect(db.financeAccount.create).toHaveBeenCalledWith({data:expect.objectContaining({legalEntityId:"entity-a"})});expect(db.financeAuditEvent.create).toHaveBeenCalledTimes(1);expect(db.financeDomainEventOutbox.create).toHaveBeenCalledTimes(1);}else{expect(result.idempotent).toBe(true);mutations.forEach(spy=>expect(spy).not.toHaveBeenCalled());}
});
it.each(["account","chart"].flatMap(kind=>denied.map(reason=>[kind,reason])))("%s %s rejects without account/audit/outbox writes",async(kind,reason)=>{
 let actor:any=mockActor,intent:any=kind==="account"?command:chart;
 if(reason==="missing-context")actor=undefined;if(reason==="foreign-company")intent={...intent,companyId:"company-b"};if(reason==="wrong-actor")intent={...intent,actorUserId:"user-b"};if(reason==="permission")jest.mocked(loadAccessSnapshot).mockResolvedValue({...snapshot,permissionCodes:[]});if(reason==="stored-scope")db.membershipScope.findFirst.mockResolvedValue(null);if(reason==="revoked-membership")jest.mocked(loadAccessSnapshot).mockResolvedValue(null as any);if(reason==="null-tenant")db.financeLegalEntity.findUnique.mockResolvedValue({...entity,tenantId:null});if(reason==="foreign-tenant")db.financeLegalEntity.findUnique.mockResolvedValue({...entity,tenantId:"tenant-b",tenant:{status:"active"},company:{isActive:true,tenantId:"tenant-b"}});if(reason==="inactive-company")db.financeLegalEntity.findUnique.mockResolvedValue({...entity,company:{...entity.company,isActive:false}});
 await expect(kind==="account"?repo.createAccount(intent,actor):repo.bootstrapChart(intent,actor)).rejects.toBeDefined();mutations.forEach(spy=>expect(spy).not.toHaveBeenCalled());expect(db.financeAccount.findMany).not.toHaveBeenCalled();
});
it("foreign parent account rejects before configuration or events",async()=>{await expect(repo.createAccount({...command,parentId:"foreign-account"},mockActor)).rejects.toMatchObject({code:"FINANCE_PARENT_ACCOUNT_NOT_FOUND"});expect(db.financeAccount.findFirst).toHaveBeenCalledWith({where:{id:"foreign-account",legalEntityId:"entity-a"}});mutations.forEach(spy=>expect(spy).not.toHaveBeenCalled());});
it.each(["account","chart"])("%s service rejects missing context before repository entry",async kind=>{const port:any={createAccount:jest.fn(),bootstrapChart:jest.fn()},service=new FinanceService(port);await expect(kind==="account"?service.createAccount(command,undefined as any):service.bootstrapChart(chart,undefined as any)).rejects.toBeDefined();expect(port.createAccount).not.toHaveBeenCalled();expect(port.bootstrapChart).not.toHaveBeenCalled();});
it.each(["account","chart"])("HTTP %s passes verified actor without changing public input",async kind=>{const app=Fastify();await app.register(routes,{prefix:"/finance"});try{const response=await app.inject({method:"POST",url:kind==="account"?"/finance/accounts":"/finance/accounts/bootstrap",payload:kind==="account"?{code:"SYNTHETIC",name:"Synthetic",type:"asset",allowPosting:false}:{templateCode:"logistics_standard",templateVersion:1}});expect(response.statusCode).toBe(kind==="account"?201:200);expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({requireFresh:true,tenantId:mockActor.tenantId,companyId:mockActor.companyId}));}finally{await app.close();}});
it("new chart installation keeps every account and durable event in selected entity",async()=>{
 db.financeChartTemplateInstallation.findUnique.mockResolvedValue(null);db.financeAccount.count.mockResolvedValue(0);
 db.financeAccount.create.mockImplementation(async({data}:any)=>({id:`synthetic-${data.code}`,...data}));
 db.financeChartTemplateInstallation.create.mockResolvedValue({id:"installation-a",legalEntityId:"entity-a",accountCount:2});
 const result:any=await repo.bootstrapChart({...chart,accounts:[{code:"GROUP",name:"Synthetic group",type:"asset",allowPosting:false},{code:"CHILD",name:"Synthetic child",type:"asset",parentCode:"GROUP",allowPosting:false}]},mockActor);
 expect(result.idempotent).toBe(false);expect(db.financeAccount.create).toHaveBeenCalledTimes(2);
 for(const [call] of db.financeAccount.create.mock.calls)expect(call.data.legalEntityId).toBe("entity-a");
 expect(db.financeAccount.create.mock.calls[1][0].data.parentId).toBe("synthetic-GROUP");expect(db.financeAuditEvent.create).toHaveBeenCalledTimes(1);expect(db.financeDomainEventOutbox.create).toHaveBeenCalledTimes(1);
});
