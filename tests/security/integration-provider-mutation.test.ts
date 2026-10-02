jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/modules/identity-access",()=>({authorize:jest.fn(),hasAnyPermissionSync:jest.fn(()=>true)}));
import { database as db } from "./fixtures";
import { upsertIntegrationProviderForActor as create, updateIntegrationProviderStatusForActor as status,
  deleteIntegrationProviderForActor as remove, rotateIntegrationProviderSecretForActor as rotate } from "../../src/modules/integrations-core/application/integration-admin.service";
import { providerRegistryRepository } from "../../src/modules/integrations-core/infrastructure/provider-registry.repo";
const actor=(companyId="ca",tenantId="ta",membership="ma"):any=>({id:"same-user",companyId,tenantId,companyMembershipId:membership,membershipId:membership,
  tenantMembershipId:"tm-"+tenantId,permissions:["policy.override"]});
const a=actor(),b=actor("cb","tb","mb"),sameTenant=actor("cc","ta","mc");
const operations=[create,status,remove,rotate];
const input=(user=a):any=>({user,companyId:user?.companyId,providerId:"provider",providerCode:"sandbox",environment:"sandbox",domain:"carrier",status:"active",secretPayload:"SYNTHETIC-CANARY"});
beforeEach(()=>{jest.clearAllMocks();db.companyMembership.findFirst.mockReset().mockImplementation(async({where}:any)=>({companyId:where.companyId,tenantId:where.tenantId,
  scopes:[{scopeType:"company",scopeRefId:where.companyId}],roles:[{role:{companyId:where.companyId,isSystem:false,rolePermissions:["integration.provider.manage","integration.provider.rotateSecret"].map(key=>({permission:{key}}))}}]}));
  db.integrationProvider.findFirst.mockReset().mockResolvedValue({id:"provider",domain:"carrier"});});
afterEach(()=>{expect(db.companyMembership.findMany).not.toHaveBeenCalled();expect(db.$transaction).not.toHaveBeenCalled();
  for(const model of ["integrationProvider","integrationProviderSecret","integrationOutbox","integrationWebhookEvent","integrationCanonicalEvent","carrierRoutingRule"])
    for(const method of ["create","update","updateMany","upsert","delete","count"])expect(db[model][method]).not.toHaveBeenCalled();});
it.each([a,b,sameTenant])("authorized selected context reaches explicit workflow containment, never user-global mutation",async user=>{
  for(const operation of operations)await expect(operation(input(user))).rejects.toMatchObject({statusCode:409});
  const where=db.companyMembership.findFirst.mock.calls[0][0].where;
  expect(where).toMatchObject({id:user.companyMembershipId,userId:user.id,companyId:user.companyId,tenantId:user.tenantId,tenantMembershipId:user.tenantMembershipId});
  for(const [query]of db.integrationProvider.findFirst.mock.calls)expect(query).toMatchObject({where:{id:"provider",companyId:user.companyId,company:{is:{tenantId:user.tenantId,isActive:true,tenant:{is:{status:"active"}}}}},select:{id:true,domain:true}});
});
it.each(["carrier","sms","webhook_sink","payment"])("%s configuration requires its exact missing durable workflow",async domain=>{
  db.integrationProvider.findFirst.mockResolvedValue({id:"provider",domain});
  for(const operation of [create,status,rotate])await expect(operation({...input(),domain})).rejects.toMatchObject({statusCode:409,
    code:domain==="payment"?"INTEGRATION_FINANCE_CONFIGURATION_APPROVAL_REQUIRED":"INTEGRATION_CONFIGURATION_WORKFLOW_REQUIRED"});
  await expect(remove(input())).rejects.toMatchObject({code:"INTEGRATION_PROVIDER_HISTORY_REQUIRED"});
});
it.each([null,{...a,tenantId:null},{...a,membershipId:"other"},{...a,tenantMembershipId:null}])("missing bound identity fails before protected provider lookup",async user=>{
  for(const operation of operations)await expect(operation(input(user))).rejects.toMatchObject({statusCode:403});
  expect(db.integrationProvider.findFirst).not.toHaveBeenCalled();
});
it.each(["revoked","permission","scope","foreign-scope"])("fresh %s state cannot be replaced by override claims",async kind=>{
  const membership=await db.companyMembership.findFirst({where:a});db.companyMembership.findFirst.mockResolvedValue(kind==="revoked"?null:{...membership,
    ...(kind==="permission"?{roles:[]}:{}),...(kind==="scope"?{scopes:[]}:kind==="foreign-scope"?{scopes:[{scopeType:"company",scopeRefId:b.companyId}]}:{})});
  for(const operation of operations)await expect(operation(input())).rejects.toMatchObject({statusCode:403});expect(db.integrationProvider.findFirst).not.toHaveBeenCalled();
});
it("foreign creation company cannot choose ownership",async()=>{await expect(create({...input(),companyId:b.companyId})).rejects.toMatchObject({statusCode:403});expect(db.integrationProvider.findFirst).not.toHaveBeenCalled();});
it.each([status,remove,rotate])("foreign/null/legacy provider does not expose configuration or mutate it",async operation=>{
  db.integrationProvider.findFirst.mockResolvedValue(null);await expect(operation({...input(),providerId:"foreign"})).rejects.toMatchObject({statusCode:404});
  expect(db.integrationProvider.findFirst.mock.calls[0][0]).toMatchObject({where:{id:"foreign",companyId:a.companyId}});
});
it.each([status,remove,rotate])("missing provider id cannot become a first-record operation",async operation=>{
  await expect(operation({...input(),providerId:undefined})).rejects.toMatchObject({statusCode:400});expect(db.integrationProvider.findFirst).not.toHaveBeenCalled();
});
it("caller domain cannot relabel an authoritative financial provider",async()=>{
  db.integrationProvider.findFirst.mockResolvedValue({id:"provider",domain:"payment"});
  await expect(rotate({...input(),domain:"carrier"})).rejects.toMatchObject({code:"INTEGRATION_FINANCE_CONFIGURATION_APPROVAL_REQUIRED"});
});
it("unused context-free registry mutation ports are absent",()=>{
  expect(providerRegistryRepository).not.toHaveProperty("updateStatus");expect(providerRegistryRepository).not.toHaveProperty("rotateSecret");
});
