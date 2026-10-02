jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:require("./fixtures").database}));
import {database as db} from "./fixtures";
import {listRouteTemplatesForActor as list,getRouteTemplateForActor as get,createRouteTemplateForActor as create,
  updateRouteTemplateForActor as update,deleteRouteTemplateForActor as remove} from "../../src/modules/integrations-core/application/route-template.service";
const actor=(companyId="ca",tenantId="ta",id="ma"):any=>({id:"same-user",companyId,tenantId,companyMembershipId:id,membershipId:id,tenantMembershipId:"tm-"+tenantId,permissions:["policy.override"]});
const row:any={id:"template-a",companyId:"ca",name:"Synthetic",priority:0,createdAt:new Date(),updatedAt:new Date(),metadata:"SENSITIVE-CANARY",
  legs:[{id:"leg-a",routeTemplateId:"template-a",sequence:1,legCode:"synthetic",createdAt:new Date(),updatedAt:new Date(),metadata:"SENSITIVE-CANARY"}]};
beforeEach(()=>{jest.clearAllMocks();db.$transaction.mockImplementation(async(work:any)=>work(db));db.$executeRaw.mockResolvedValue(0);
 db.companyMembership.findFirst.mockReset().mockImplementation(async({where}:any)=>({companyId:where.companyId,tenantId:where.tenantId,scopes:[{scopeType:"company",scopeRefId:where.companyId}],roles:[{role:{companyId:where.companyId,isSystem:false,rolePermissions:[{permission:{key:"integration.routing.read"}},{permission:{key:"integration.routing.manage"}}]}}]}));
 db.routeTemplate.findMany.mockReset().mockResolvedValue([row]);db.routeTemplate.findFirst.mockReset().mockResolvedValue(row);db.routeTemplate.count.mockReset().mockResolvedValue(1);
});
afterEach(()=>{expect(db.companyMembership.findMany).not.toHaveBeenCalled();for(const m of ["routeTemplate","routeTemplateLeg","carrierRoutingRule","integrationOutbox","integrationProvider"])for(const op of ["create","update","updateMany","upsert","delete","deleteMany"])expect(db[m][op]).not.toHaveBeenCalled();});
it.each([actor(),actor("cb","tb","mb"),actor("cc","ta","mc")])("list and detail require fresh exact company despite override",async user=>{
 await list({user,filters:{limit:1}});await get({user,routeTemplateId:row.id});
 const query=db.routeTemplate.findMany.mock.calls[0][0];expect(query.where).toMatchObject({companyId:user.companyId,company:{is:{tenantId:user.tenantId,isActive:true,tenant:{is:{status:"active"}}}}});
 expect(db.routeTemplate.count.mock.calls[0][0].where).toEqual(query.where);
 expect(db.companyMembership.findFirst.mock.calls[0][0].where).toMatchObject({id:user.membershipId,userId:user.id,tenantMembershipId:user.tenantMembershipId,status:"active"});
 expect(db.$transaction.mock.calls[0][1]).toMatchObject({isolationLevel:"RepeatableRead",maxWait:2000,timeout:5000});
 expect(db.$executeRaw.mock.calls[0][0].join("")).toBe("SET TRANSACTION READ ONLY");
});
it("default array and nested projection are bounded and omit custom metadata",async()=>{
 const result:any=await list({user:actor()});expect(Array.isArray(result)).toBe(true);expect(JSON.stringify(result)).not.toContain("SENSITIVE-CANARY");
 // Test fixture contains metadata; actual explicit select cannot fetch it.
 const query=db.routeTemplate.findMany.mock.calls[0][0];expect(query.take).toBe(100);expect(query.select).not.toHaveProperty("metadata");expect(query.select.legs).toMatchObject({take:101});expect(query.select.legs.select).not.toHaveProperty("metadata");
});
it("foreign/null-owned detail and cursor fail closed under repeated ownership",async()=>{
 db.routeTemplate.findFirst.mockResolvedValue(null);await expect(get({user:actor(),routeTemplateId:"foreign"})).rejects.toMatchObject({statusCode:404});
 await expect(list({user:actor(),filters:{limit:1,cursor:"foreign"}})).rejects.toMatchObject({statusCode:404});expect(db.routeTemplate.findMany).not.toHaveBeenCalled();
 expect(db.routeTemplate.findFirst.mock.calls[0][0].where).toMatchObject({id:"foreign",companyId:"ca",company:{is:{tenantId:"ta"}}});
});
it("scoped cursor counts and filters use the same snapshot",async()=>{
 await list({user:actor(),filters:{limit:1,cursor:row.id,q:"Synthetic",isActive:true}});
 const query=db.routeTemplate.findMany.mock.calls[0][0];expect(db.routeTemplate.findFirst.mock.calls[0][0].where.AND[0]).toEqual(query.where);expect(query).toMatchObject({take:2,cursor:{id:row.id},skip:1});
});
it.each([{limit:0},{limit:101},{limit:1.2},{cursor:"id"},{q:"x".repeat(181)}])("invalid bounds fail before configuration reads",async filters=>{await expect(list({user:actor(),filters})).rejects.toMatchObject({statusCode:400});expect(db.routeTemplate.findMany).not.toHaveBeenCalled();});
it.each([null,{...actor(),tenantId:null},{...actor(),membershipId:"other"}])("unbound callers cannot read or mutate",async user=>{
 for(const op of [()=>list({user}),()=>get({user,routeTemplateId:row.id}),()=>create({user,input:{companyId:"ca"} as any}),()=>update({user,routeTemplateId:row.id,input:{}}),()=>remove({user,routeTemplateId:row.id})])await expect(op()).rejects.toMatchObject({statusCode:403});
 expect(db.routeTemplate.findFirst).not.toHaveBeenCalled();expect(db.routeTemplate.findMany).not.toHaveBeenCalled();
});
it("removed permission/scope and foreign company selection cannot use override",async()=>{
 db.companyMembership.findFirst.mockResolvedValueOnce(null);await expect(list({user:actor()})).rejects.toMatchObject({statusCode:403});
 db.companyMembership.findFirst.mockResolvedValueOnce({companyId:"ca",tenantId:"ta",roles:[],scopes:[]});await expect(get({user:actor(),routeTemplateId:row.id})).rejects.toMatchObject({statusCode:403});
 await expect(create({user:actor(),input:{companyId:"cb"} as any})).rejects.toMatchObject({statusCode:403});
});
it("nested overflow or wrong child returns no protected projection",async()=>{
 db.routeTemplate.findFirst.mockResolvedValueOnce({...row,legs:Array.from({length:101},()=>row.legs[0])});await expect(get({user:actor(),routeTemplateId:row.id})).rejects.toMatchObject({statusCode:409,code:"INTEGRATION_READ_CAPACITY"});
 db.routeTemplate.findFirst.mockResolvedValueOnce({...row,legs:[{...row.legs[0],routeTemplateId:"foreign"}]});await expect(get({user:actor(),routeTemplateId:row.id})).rejects.toMatchObject({statusCode:409});
});
it("authorized mutation remains contained before nested writes or retirement",async()=>{
 for(const op of [()=>create({user:actor(),input:{companyId:"ca",legs:[{id:"foreign"}]} as any}),()=>update({user:actor(),routeTemplateId:row.id,input:{companyId:"foreign",legs:[]} as any}),()=>remove({user:actor(),routeTemplateId:row.id})])await expect(op()).rejects.toMatchObject({statusCode:409,code:"INTEGRATION_ROUTING_CONFIGURATION_WORKFLOW_REQUIRED"});
 expect(db.$transaction).not.toHaveBeenCalled();
 db.routeTemplate.findFirst.mockResolvedValueOnce(null);await expect(remove({user:actor(),routeTemplateId:"foreign"})).rejects.toMatchObject({statusCode:404});
});
