jest.mock("../../src/config/prismaClient", () => ({__esModule:true,default:require("./fixtures").database}));
jest.mock("../../src/config/redis", () => ({getRedisClient:jest.fn(async()=>null),getRedisPrefix:()=>"test",withRedisTimeout:async(_name:string,work:()=>Promise<unknown>)=>work()}));
jest.mock("../../src/modules/identity-access/access-control",()=>({loadAccessSnapshot:jest.fn(),clearIdentityAccessCacheForUser:jest.fn(),authorize:jest.fn(async(actor:any,permission:string)=>{if(!actor.permissionCodes.includes(permission))throw Object.assign(new Error("Forbidden"),{statusCode:403});})}));
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import routes from "../../src/modules/identity-access/transport/fastify-routes";
import {database,expectNoDatabaseCalls} from "./fixtures";
import {loadAccessSnapshot} from "../../src/modules/identity-access/access-control";
import {createRoleForCompany,listPermissions,listRolesForCompany,seedSystemPermissions} from "../../src/modules/identity-access/application/iam.service";
import {createUserByCompanyAdmin,updateUserAccessByCompanyAdmin,deleteUserMembershipFromCompany,listUsersForCompany} from "../../src/modules/identity-access/application/auth.service";
import {BoundedLocalRateLimitStore,createAbuseRateLimiter} from "../../src/shared/http/abuseRateLimit";
const actor:any={id:"user-a",membershipId:"cm-a",companyMembershipId:"cm-a",companyId:"company-a",tenantId:"tenant-a",tenantMembershipId:"tm-a",permissionCodes:["roles.read","membership.invite","role.bindPermissions","membership.suspend","policy.override"],scopes:[{scopeType:"company",scopeRefId:"company-a"}]};
const snapshot:any={...actor,userId:actor.id};
const originalEnvironment={...process.env};const secret="synthetic-delegation-containment-32-characters";
beforeEach(()=>{
 process.env={NODE_ENV:"test",JWT_SECRET:secret,REFRESH_TOKEN_SECRET:secret};jest.clearAllMocks();
 jest.mocked(loadAccessSnapshot).mockReset().mockResolvedValue(snapshot);
 for(const [model,methods] of Object.entries({role:["findMany","create"],permission:["findMany","upsert"],rolePermission:["upsert","create"],membershipRole:["create","deleteMany"],membershipScope:["create","deleteMany"],companyMembership:["findFirst","findMany","count","create","update"],user:["create","update","delete"],userRefreshSession:["create","updateMany"]}))for(const method of methods)database[model][method].mockReset();
 database.$transaction.mockReset().mockImplementation(async(work:any)=>Array.isArray(work)?Promise.all(work):work(database));
 database.permission.findMany.mockResolvedValue([]);database.role.findMany.mockResolvedValue([]);database.companyMembership.findMany.mockResolvedValue([]);database.companyMembership.count.mockResolvedValue(0);
});
afterEach(()=>{process.env={...originalEnvironment};});
function noBusinessEffects(){for(const [model,methods] of Object.entries({role:["create"],rolePermission:["create","upsert"],membershipRole:["create","deleteMany"],membershipScope:["create","deleteMany"],companyMembership:["create","update"],user:["create","update","delete"],userRefreshSession:["create","updateMany"]}))for(const method of methods)expect(database[model][method]).not.toHaveBeenCalled();}
async function server(){const app=Fastify();await app.register(routes,{rateLimiter:createAbuseRateLimiter({localStore:new BoundedLocalRateLimitStore()})});await app.ready();return app;}
const token=()=>jwt.sign({...actor,tokenType:"access"},secret);
test.each([
 {method:"PATCH",url:"/user-a",payload:{roleCodes:["super_admin"],scopes:[{scopeType:"warehouse",scopeRefId:"foreign"}]}},
 {method:"PATCH",url:"/user-b",payload:{name:"Changed global identity",email:"synthetic@example.test",customerEntityId:"foreign"}},
 {method:"POST",url:"/roles",payload:{name:"Forged",permissionKeys:["policy.override"],isOwnerRole:true}},
 {method:"DELETE",url:"/user-b"},
])("HTTP containment denies anonymous and privileged callers before effects: $url",async(input:any)=>{
 const app=await server();try{for(const headers of [{},{authorization:"Bearer "+token()}]){const response=await app.inject({...input,headers});expect(response.statusCode).toBe(403);expect(response.json().code).toBe("DELEGATION_POLICY_REQUIRED");expect(response.headers["cache-control"]).toBe("no-store");}expectNoDatabaseCalls();expect(loadAccessSnapshot).not.toHaveBeenCalled();}finally{await app.close();}
});
test("malformed administrative request is contained before parsing or leaking provider internals",async()=>{
 const app=await server();try{const response=await app.inject({method:"PATCH",url:"/user-a",headers:{"content-type":"application/json"},payload:"{broken"});expect(response.statusCode).toBe(403);expectNoDatabaseCalls();}finally{await app.close();}
});
test.each([{roleCodes:["super_admin"]},{scopes:[]},{scopes:[{scopeType:"warehouse",scopeRefId:"foreign"}]},{branchId:"foreign"},{customerEntityId:"foreign"},{warehouseId:"foreign"},{name:"Changed",email:"synthetic@example.test"}])("alternate admin service caller cannot grant or mutate identity: %j",async(input:any)=>{
 await expect(updateUserAccessByCompanyAdmin({companyId:"company-a",userId:"user-a",...input})).rejects.toMatchObject({statusCode:403,code:"DELEGATION_POLICY_REQUIRED"});expectNoDatabaseCalls();
});
test("role definition, enrollment and permanent user deletion have no context-free mutation bypass",async()=>{
 await expect(createRoleForCompany({companyId:"foreign",name:"Escalation",permissionKeys:["policy.override"],isOwnerRole:true})).rejects.toMatchObject({statusCode:403});
 await expect(createUserByCompanyAdmin({companyId:"company-a",name:"Synthetic",email:"synthetic@example.test",password:"synthetic-only",roleCodes:["super_admin"]})).rejects.toMatchObject({statusCode:403});
 await expect(deleteUserMembershipFromCompany({actorUserId:"user-a",targetUserId:"user-b",companyId:"company-a"})).rejects.toMatchObject({statusCode:403});expectNoDatabaseCalls();
});
test.each([undefined,{...actor,tenantId:null},{...actor,membershipId:"other"}])("missing management selection fails before querying the catalog",async(value:any)=>{
 await expect(listRolesForCompany({actor:value})).rejects.toMatchObject({statusCode:403});expectNoDatabaseCalls();
});
test.each([null,{...snapshot,userId:"foreign"},{...snapshot,companyId:"foreign"},{...snapshot,tenantId:"foreign"},{...snapshot,tenantMembershipId:"foreign"},{...snapshot,companyMembershipId:"foreign"},{...snapshot,permissionCodes:["policy.override"]},{...snapshot,scopes:[{scopeType:"warehouse",scopeRefId:"warehouse-a"}]}])("fresh revoked/mismatched/unpermitted management context fails closed",async(value:any)=>{
 jest.mocked(loadAccessSnapshot).mockResolvedValue(value);await expect(listPermissions(actor)).rejects.toMatchObject({statusCode:403});expect(database.permission.findMany).not.toHaveBeenCalled();noBusinessEffects();
});
test("authorized role reads ignore forged selectors and never include global/system roles",async()=>{
 const result=await listRolesForCompany({actor,includeSystem:true,companyId:"foreign"} as any);expect(result).toEqual([]);
 expect(database.role.findMany.mock.calls[0][0].where).toEqual({companyId:actor.companyId,company:{is:{tenantId:actor.tenantId,isActive:true}},isSystem:false});
 expect(loadAccessSnapshot).toHaveBeenCalledWith(expect.objectContaining({requireFresh:true,companyId:actor.companyId,tenantId:actor.tenantId}));noBusinessEffects();
});
test("authorized directory and counts require populated active tenant bridges and safe identity fields",async()=>{
 database.companyMembership.findMany.mockResolvedValue([{id:"cm-other",createdAt:new Date(),branchId:null,user:{id:"user-b",name:"Synthetic",email:"synthetic@example.test",password:"CANARY",warehouseId:"foreign",customerEntityId:"foreign"},roles:[],scopes:[]}]);
 const result=await listUsersForCompany({actor,limit:500,companyId:"foreign"} as any);
 expect(result.items[0]).toMatchObject({warehouseId:null,customerEntityId:null});expect(JSON.stringify(result)).not.toContain("CANARY");expect(JSON.stringify(result)).not.toContain("foreign");expect(result.limit).toBe(100);
 for(const operation of [database.companyMembership.findMany,database.companyMembership.count])expect(operation.mock.calls[0][0].where).toMatchObject({tenantId:actor.tenantId,companyId:actor.companyId,status:"active",tenantMembership:{is:{tenantId:actor.tenantId,status:"active"}}});
 expect(database.companyMembership.findMany.mock.calls[0][0].select.roles.where).toEqual({role:{is:{companyId:actor.companyId,isSystem:false}}});noBusinessEffects();
});
test("HTTP catalog read preserves envelope using real token verification and fresh context",async()=>{
 const app=await server();try{const response=await app.inject({method:"GET",url:"/roles?includeSystem=true&companyId=foreign",headers:{authorization:"Bearer "+token()}});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({items:[]});expect(database.role.findMany.mock.calls[0][0].where.companyId).toBe(actor.companyId);}finally{await app.close();}
});
test("permission seeding cannot implicitly increase any owner-role ceiling",async()=>{
 database.permission.upsert.mockResolvedValue({});await seedSystemPermissions();expect(database.permission.upsert).toHaveBeenCalled();expect(database.role.findMany).not.toHaveBeenCalled();expect(database.rolePermission.upsert).not.toHaveBeenCalled();noBusinessEffects();
});

