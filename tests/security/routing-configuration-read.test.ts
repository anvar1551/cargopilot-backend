jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
import {database as db} from "./fixtures";
import {listTemplateConfigurationsForActor,listRoutingConfigurationsForActor} from "../../src/modules/integrations-core/application/routing-configuration-read";
const id="019b3000-0000-7000-8b00-000000000031",cursor="019b3000-0000-7000-8b00-000000000032";
const user:any={id:"same-user",companyId:"ca",tenantId:"ta",membershipId:"ma",companyMembershipId:"ma",tenantMembershipId:"tm"};
beforeEach(()=>{
 jest.clearAllMocks();db.companyMembership.findFirst.mockReset().mockImplementation(async({where}:any)=>({companyId:where.companyId,tenantId:where.tenantId,scopes:[{scopeType:"company",scopeRefId:where.companyId}],roles:[{role:{companyId:where.companyId,rolePermissions:[{permission:{key:"integration.routing.read"}}]}}]}));
 db.$transaction.mockImplementation(async(work:any)=>work(db));db.$executeRaw.mockResolvedValue(0);
 for(const parent of ["routeTemplate","carrierRoutingRule"])db[parent].findFirst.mockReset().mockResolvedValue({id,configurationRevision:2,currentConfigurationId:cursor});
 for(const version of ["routeTemplateConfigurationVersion","carrierRoutingConfigurationVersion"]){
  db[version].findFirst.mockReset().mockResolvedValue({revision:2});db[version].count.mockReset().mockResolvedValue(2);
  db[version].findMany.mockReset().mockResolvedValue([{id:cursor,revision:2,acceptedAt:new Date(),isActive:true,priority:1,providerVersionId:"PRIVATE-CANARY",intentSha256:"PRIVATE-CANARY",actorUserId:"PRIVATE-CANARY"}]);
 }
});
describe.each([["template",listTemplateConfigurationsForActor,"routeTemplate","routeTemplateConfigurationVersion"],["routing",listRoutingConfigurationsForActor,"carrierRoutingRule","carrierRoutingConfigurationVersion"]] as const)("%s bounded history",(_kind,list,parent,version)=>{
 afterEach(()=>{for(const model of [parent,version,"integrationOutbox"])for(const op of ["create","update","updateMany","delete"])expect(db[model][op]).not.toHaveBeenCalled();});
 it.each([user,{...user,companyId:"cb",tenantId:"tb",membershipId:"mb",companyMembershipId:"mb"},{...user,companyId:"cc",membershipId:"mc",companyMembershipId:"mc"}])("keeps exact selected ownership across page and count",async actor=>{
  const result=await list({user:actor,resourceId:id,limit:1});expect(JSON.stringify(result)).not.toContain("PRIVATE-CANARY");
  expect(db[version].findMany.mock.calls[0][0]).toMatchObject({where:{tenantId:actor.tenantId,companyId:actor.companyId},take:2});expect(db[version].count.mock.calls[0][0].where).toMatchObject({tenantId:actor.tenantId,companyId:actor.companyId});
  expect(db.$transaction.mock.calls[0][1]).toMatchObject({isolationLevel:"RepeatableRead",timeout:5000});
 });
 it.each(["missing","permission","scope","foreign-parent","foreign-cursor"])("rejects %s without queries or effects",async reason=>{
  let actor=user;if(reason==="missing")actor={id:user.id};
  if(reason==="permission")db.companyMembership.findFirst.mockResolvedValue({companyId:"ca",tenantId:"ta",scopes:[{scopeType:"company",scopeRefId:"ca"}],roles:[]});
  if(reason==="scope")db.companyMembership.findFirst.mockResolvedValue({companyId:"ca",tenantId:"ta",scopes:[],roles:[{role:{companyId:"ca",rolePermissions:[{permission:{key:"integration.routing.read"}}]}}]});
  if(reason==="foreign-parent")db[parent].findFirst.mockResolvedValue(null);if(reason==="foreign-cursor")db[version].findFirst.mockResolvedValue(null);
  await expect(list({user:actor,resourceId:id,...(reason==="foreign-cursor"?{cursor}:{})})).rejects.toThrow();expect(db[version].findMany).not.toHaveBeenCalled();
 });
 it("keeps cursor inside scoped snapshot",async()=>{await list({user,resourceId:id,cursor});expect(db[version].findFirst.mock.calls[0][0].where).toMatchObject({id:cursor,companyId:"ca",tenantId:"ta"});expect(db[version].findMany.mock.calls[0][0].where.revision).toEqual({lt:2});});
 it("rejects owner selector fields and invalid limits",async()=>{for(const args of [{user,resourceId:id,tenantId:"foreign"},{user,resourceId:id,limit:101}])await expect(list(args as any)).rejects.toMatchObject({statusCode:400});expect(db.$transaction).not.toHaveBeenCalled();});
});
