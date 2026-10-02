jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
import { database as db } from "./fixtures";
import { replayIntegrationOutboxForActor as replay, retryIntegrationOutboxNowForActor as retry } from "../../src/modules/integrations-core/application/outbox-recovery";
const actor=(companyId="ca",tenantId="ta",membership="ma"):any=>({id:"same-user",companyId,tenantId,companyMembershipId:membership,membershipId:membership,
  tenantMembershipId:"tm-"+tenantId,permissions:["policy.override"]});
const a=actor(),b=actor("cb","tb","mb"),sameTenant=actor("cc","ta","mc");
beforeEach(()=>{jest.clearAllMocks();db.companyMembership.findFirst.mockReset().mockImplementation(async({where}:any)=>({companyId:where.companyId,tenantId:where.tenantId,
  scopes:[{scopeType:"company",scopeRefId:where.companyId}],roles:[{role:{companyId:where.companyId,isSystem:false,rolePermissions:[{permission:{key:"integration.outbox.replay"}}]}}]}));
  db.integrationOutbox.findFirst.mockReset().mockResolvedValue({id:"outbox",status:"processing",payload:{secret:"SYNTHETIC-CANARY"}});});
afterEach(()=>{expect(db.companyMembership.findMany).not.toHaveBeenCalled();expect(db.$transaction).not.toHaveBeenCalled();
  for(const model of ["integrationOutbox","integrationOutboxAttempt","integrationCanonicalEvent","order","paymentIntent"])
    for(const method of ["create","update","updateMany","upsert","delete"])expect(db[model][method]).not.toHaveBeenCalled();});
it.each([a,b,sameTenant])("authorized context is freshly scoped but cannot mint replay identity/reset a lease",async user=>{
  for(const fn of [replay,retry])await expect(fn({user,outboxId:"outbox"})).rejects.toMatchObject({statusCode:409,code:"INTEGRATION_OUTBOX_RECOVERY_REQUIRED"});
  for(const [query]of db.integrationOutbox.findFirst.mock.calls)expect(query).toMatchObject({where:{id:"outbox",companyId:user.companyId,
    company:{is:{tenantId:user.tenantId,isActive:true,tenant:{is:{status:"active"}}}}},select:{id:true}});
});
it.each(["pending","processing","sent","failed","dead_letter"])("%s state does not authorize manual recovery",async status=>{
  db.integrationOutbox.findFirst.mockResolvedValue({id:"outbox",status});for(const fn of [replay,retry])await expect(fn({user:a,outboxId:"outbox"})).rejects.toMatchObject({code:"INTEGRATION_OUTBOX_RECOVERY_REQUIRED"});
});
it.each([null,{...a,tenantId:null},{...a,tenantMembershipId:null},{...a,membershipId:"other"}])("missing context cannot read even an outbox payload",async user=>{
  for(const fn of [replay,retry])await expect(fn({user,outboxId:"outbox"})).rejects.toMatchObject({statusCode:403});expect(db.integrationOutbox.findFirst).not.toHaveBeenCalled();
});
it.each(["revoked","permission","scope"])("fresh %s denies before record lookup",async kind=>{
  const membership=await db.companyMembership.findFirst({where:a});db.companyMembership.findFirst.mockResolvedValue(kind==="revoked"?null:{...membership,...(kind==="permission"?{roles:[]}:{scopes:[]})});
  for(const fn of [replay,retry])await expect(fn({user:a,outboxId:"outbox"})).rejects.toMatchObject({statusCode:403});expect(db.integrationOutbox.findFirst).not.toHaveBeenCalled();
});
it("foreign/unowned outbox id produces no payload, lease change or cloned operation",async()=>{
  db.integrationOutbox.findFirst.mockResolvedValue(null);for(const fn of [replay,retry])await expect(fn({user:a,outboxId:"foreign"})).rejects.toMatchObject({statusCode:404});
});
it("missing id never selects a first stored operation",async()=>{
  for(const fn of [replay,retry])await expect(fn({user:a,outboxId:undefined as any})).rejects.toMatchObject({statusCode:400});expect(db.integrationOutbox.findFirst).not.toHaveBeenCalled();
});
