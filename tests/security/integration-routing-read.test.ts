jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
import {database as db} from "./fixtures";
import {listCarrierRoutingRulesForActor as list} from "../../src/modules/integrations-core/application/carrier-routing.service";
const actor=(companyId="ca",tenantId="ta",id="ma"):any=>({id:"same-user",companyId,tenantId,companyMembershipId:id,membershipId:id,tenantMembershipId:"tm-"+tenantId,permissions:["policy.override"]});
const row:any={id:"ra",companyId:"ca",name:"Synthetic routing",providerId:"pa",provider:{providerCode:"synthetic",environment:"sandbox"},routeTemplateId:"template-a",routeTemplateLegId:"leg-a",routeTemplateLeg:{routeTemplateId:"template-a",legCode:"synthetic",sequence:1},priority:1,createdAt:new Date(),updatedAt:new Date(),conditionsJson:"SENSITIVE-CANARY",internalCredentials:"SENSITIVE-CANARY"};
beforeEach(()=>{jest.clearAllMocks();db.$transaction.mockImplementation(async(work:any)=>work(db));db.$executeRaw.mockResolvedValue(0);
 db.companyMembership.findFirst.mockReset().mockImplementation(async({where}:any)=>({companyId:where.companyId,tenantId:where.tenantId,scopes:[{scopeType:"company",scopeRefId:where.companyId}],roles:[{role:{companyId:where.companyId,isSystem:false,rolePermissions:[{permission:{key:"integration.routing.read"}}]}}]}));
 db.carrierRoutingRule.findMany.mockReset().mockResolvedValue([row]);db.carrierRoutingRule.findFirst.mockReset().mockResolvedValue({id:row.id});db.carrierRoutingRule.count.mockReset().mockResolvedValue(1);
});
afterEach(()=>{expect(db.companyMembership.findMany).not.toHaveBeenCalled();for(const m of ["carrierRoutingRule","integrationOutbox","integrationProvider","routeTemplate","orderLeg"])for(const op of ["create","update","updateMany","delete","upsert"])expect(db[m][op]).not.toHaveBeenCalled();});
it.each([actor(),actor("cb","tb","mb"),actor("cc","ta","mc")])("inventory requires exact selected membership despite override and other memberships",async user=>{
 await list({user,filters:{limit:2}});const query=db.carrierRoutingRule.findMany.mock.calls[1][0];const scope=query.where.AND[0];
 expect(scope).toMatchObject({companyId:user.companyId,company:{is:{id:user.companyId,tenantId:user.tenantId,isActive:true,tenant:{is:{status:"active"}}}},provider:{is:{companyId:user.companyId,domain:"carrier"}}});
 expect(db.carrierRoutingRule.count.mock.calls[0][0].where).toEqual(query.where);
 expect(db.companyMembership.findFirst.mock.calls[0][0].where).toMatchObject({userId:user.id,id:user.membershipId,tenantMembershipId:user.tenantMembershipId,status:"active"});
});
it("safe projection and bounded default array hide raw custom configuration",async()=>{
 const result=await list({user:actor()});expect(Array.isArray(result)).toBe(true);expect(JSON.stringify(result)).not.toContain("SENSITIVE-CANARY");
 expect((result as any[])[0].conditionsJson).toBeNull();const query=db.carrierRoutingRule.findMany.mock.calls[1][0];expect(query.take).toBe(100);expect(query.select).not.toHaveProperty("conditionsJson");expect(db.carrierRoutingRule.count).not.toHaveBeenCalled();
});
it("candidate assessment excludes mismatched template children from query and count",async()=>{
 db.carrierRoutingRule.findMany.mockResolvedValueOnce([{...row,routeTemplateLeg:{routeTemplateId:"other-template"}}]).mockResolvedValueOnce([]);
 await list({user:actor(),filters:{limit:1}});expect(db.carrierRoutingRule.findMany.mock.calls[1][0].where.AND[1]).toEqual({id:{in:[]}});
 expect(db.carrierRoutingRule.count.mock.calls[0][0].where).toEqual(db.carrierRoutingRule.findMany.mock.calls[1][0].where);
});
it("changed child consistency between queries fails instead of returning protected projection",async()=>{
 db.carrierRoutingRule.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([{...row,routeTemplateLeg:{routeTemplateId:"other"}}]);await expect(list({user:actor()})).rejects.toMatchObject({statusCode:409});
});
it("cursor proof uses the same selected eligibility predicate before pagination",async()=>{
 await list({user:actor(),filters:{limit:1,cursor:"ra",q:" synthetic "}});const query=db.carrierRoutingRule.findMany.mock.calls[1][0];expect(db.carrierRoutingRule.findFirst.mock.calls[0][0].where.AND[0]).toEqual(query.where);expect(query).toMatchObject({take:2,cursor:{id:"ra"},skip:1});
 db.carrierRoutingRule.findFirst.mockResolvedValueOnce(null);await expect(list({user:actor(),filters:{limit:1,cursor:"foreign"}})).rejects.toMatchObject({statusCode:404});
});
it("foreign company assertion rejects before any routing lookup",async()=>{await expect(list({user:actor(),filters:{companyId:"cb"}})).rejects.toMatchObject({statusCode:403});expect(db.carrierRoutingRule.findMany).not.toHaveBeenCalled();});
it.each([null,{...actor(),tenantId:null},{...actor(),tenantMembershipId:null},{...actor(),membershipId:"foreign"}])("unbound context fails closed before routing reads",async user=>{await expect(list({user})).rejects.toMatchObject({statusCode:403});expect(db.carrierRoutingRule.findMany).not.toHaveBeenCalled();});
it("revoked permission and missing company scope fail before queries",async()=>{
 db.companyMembership.findFirst.mockResolvedValueOnce(null);await expect(list({user:actor()})).rejects.toMatchObject({statusCode:403});
 db.companyMembership.findFirst.mockResolvedValueOnce({companyId:"ca",tenantId:"ta",scopes:[],roles:[{role:{companyId:"ca",isSystem:false,rolePermissions:[{permission:{key:"integration.routing.read"}}]}}]});await expect(list({user:actor()})).rejects.toMatchObject({statusCode:403});expect(db.carrierRoutingRule.findMany).not.toHaveBeenCalled();
});
it.each([{limit:0},{limit:101},{limit:1.2},{limit:NaN},{cursor:"ra"},{limit:1,cursor:" "},{q:"x".repeat(181)}])("invalid resource bounds do not query routing",async filters=>{await expect(list({user:actor(),filters})).rejects.toMatchObject({statusCode:400});expect(db.carrierRoutingRule.findMany).not.toHaveBeenCalled();});
it("large assessment rejects explicitly rather than returning partial counts",async()=>{db.carrierRoutingRule.findMany.mockResolvedValueOnce(Array.from({length:101},()=>row));await expect(list({user:actor()})).rejects.toMatchObject({statusCode:409,code:"INTEGRATION_READ_CAPACITY"});expect(db.carrierRoutingRule.findMany).toHaveBeenCalledTimes(1);expect(db.carrierRoutingRule.count).not.toHaveBeenCalled();});

it("assessment pagination and count share a bounded read-only repeatable snapshot",async()=>{await list({user:actor(),filters:{limit:1}});expect(db.$transaction.mock.calls[0][1]).toMatchObject({isolationLevel:"RepeatableRead",maxWait:2000,timeout:5000});expect(db.$executeRaw.mock.calls[0][0].join("")).toBe("SET TRANSACTION READ ONLY");});
