jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_t, key) => { const value = (mockPrisma as any)[key]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,runId=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!runId||!/^[a-f0-9]{12}$/.test(runId))throw Error("Disposable identity required");
const target=new URL(url);
if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${runId}`)throw Error("Refusing existing target");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"});
let mockPrisma:PrismaClient;
const contexts:any[]=[
{id:ids.users.multiTenant,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.multiTransAsia,companyId:ids.organizations.transAsiaUz,companyMembershipId:ids.companyMemberships.multiTransAsiaUz},
{id:ids.users.multiTenant,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.multiTransAsia,companyId:ids.organizations.transAsiaDe,companyMembershipId:ids.companyMemberships.multiTransAsiaDe},
{id:ids.users.multiTenant,tenantId:ids.tenants.unrelated,tenantMembershipId:ids.tenantMemberships.multiUnrelated,companyId:ids.organizations.unrelated,companyMembershipId:ids.companyMemberships.multiUnrelated}].map(c=>({...c,membershipId:c.companyMembershipId}));
const a=contexts[0];
beforeAll(async()=>{
const marker=await pool.query('SELECT "runId" FROM "_CPDisposableRun"');if(marker.rows.length!==1||marker.rows[0].runId!==runId)throw Error("Storage ownership mismatch");
const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,createTenantDemoFixture());await client.query("COMMIT");}finally{client.release();}
mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});
for(const c of contexts){const role=await mockPrisma.role.create({data:{companyId:c.companyId,code:randomUUID(),name:"Synthetic verification"}});
for(const key of PERMISSIONS){const p=await mockPrisma.permission.upsert({where:{key},create:{key,resource:"synthetic",action:"test"},update:{}});await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:p.id}});}
await mockPrisma.membershipRole.create({data:{membershipId:c.membershipId,roleId:role.id}});
if(!await mockPrisma.membershipScope.findFirst({where:{membershipId:c.membershipId,scopeType:"company",scopeRefId:c.companyId}}))await mockPrisma.membershipScope.create({data:{membershipId:c.membershipId,scopeType:"company",scopeRefId:c.companyId}});
}
await setup();
},60000);
afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();});

import { listIntegrationProvidersForActor as list } from "../../src/modules/integrations-core/application/provider-access";
const PERMISSIONS=["integration.provider.read"];
let owned:any[],foreign:any[],unowned:any;
async function setup(){
owned=[];foreign=[];
for(const c of contexts)for(const code of ["aa","bb","cc"]){const row=await mockPrisma.integrationProvider.create({data:{companyId:c.companyId,domain:"carrier",providerCode:code,environment:"sandbox",retryPolicyId:"synthetic-policy"}});const secret=await mockPrisma.integrationProviderSecret.create({data:{providerId:row.id,keyVersion:1,encryptedSecretJson:"SYNTHETIC-SECRET-CANARY"}});await mockPrisma.integrationProvider.update({where:{id:row.id},data:{secretRef:secret.id,activeSecretId:secret.id}});(c===a?owned:foreign).push(row);}
const org=await mockPrisma.organization.create({data:{code:randomUUID(),name:"Synthetic unowned",type:"company",tenantId:null}});
unowned=await mockPrisma.integrationProvider.create({data:{companyId:org.id,domain:"carrier",providerCode:"aa",environment:"sandbox"}});
}
const snapshot=async()=>({providers:await mockPrisma.integrationProvider.findMany({orderBy:{id:"asc"}}),secrets:await mockPrisma.integrationProviderSecret.findMany({orderBy:{id:"asc"}}),outbox:await mockPrisma.integrationOutbox.findMany({orderBy:{id:"asc"}})});
it("SQL selected context excludes foreign and legacy null ownership; projection omits credentials",async()=>{
const before=await snapshot();for(const c of contexts){const result:any=await list({user:c});expect(result).toHaveLength(3);expect(result.every((r:any)=>r.companyId===c.companyId)).toBe(true);
for(const row of result)expect(Object.keys(row).sort()).toEqual(["id","companyId","domain","providerCode","status","environment","capabilities","rateLimitRps","timeoutMs","retryPolicyId","createdAt","updatedAt"].sort());expect(JSON.stringify(result)).not.toContain("SYNTHETIC-SECRET-CANARY");expect(result.some((r:any)=>r.id===unowned.id)).toBe(false);}
expect(await snapshot()).toEqual(before);
});
it("SQL cursor pagination, filtered count and search remain scoped",async()=>{
const first:any=await list({user:a,limit:1});expect(first.total).toBe(3);expect(first.data[0].id).toBe(owned[0].id);expect(first.pageInfo.hasNextPage).toBe(true);
const second:any=await list({user:a,limit:1,cursor:first.pageInfo.nextCursor});expect(second.data[0].id).toBe(owned[1].id);expect(second.total).toBe(3);
const last:any=await list({user:a,limit:1,cursor:second.pageInfo.nextCursor});expect(last.data[0].id).toBe(owned[2].id);expect(last.pageInfo.hasNextPage).toBe(false);
const filtered:any=await list({user:a,limit:2,providerCode:" BB ",q:"policy",domain:"carrier",environment:"sandbox",status:"active"});expect(filtered.total).toBe(1);expect(filtered.data.map((r:any)=>r.id)).toEqual([owned[1].id]);
});
it("SQL foreign/null/filtered cursors and requested company reject without mutation",async()=>{const before=await snapshot();for(const cursor of [foreign[0].id,unowned.id,owned[0].id])await expect(list({user:a,limit:1,cursor,providerCode:"bb"})).rejects.toMatchObject({statusCode:404});await expect(list({user:a,companyId:contexts[1].companyId})).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);});
it.each(["membership","scope","permission","tenant"])("SQL fresh %s denial overrides stale claims and writes nothing",async kind=>{
const before=await snapshot();let restore:()=>Promise<any>;
if(kind==="membership"){await mockPrisma.companyMembership.update({where:{id:a.membershipId},data:{status:"suspended"}});restore=()=>mockPrisma.companyMembership.update({where:{id:a.membershipId},data:{status:"active"}});}
else if(kind==="tenant"){await mockPrisma.tenant.update({where:{id:a.tenantId},data:{status:"suspended"}});restore=()=>mockPrisma.tenant.update({where:{id:a.tenantId},data:{status:"active"}});}
else if(kind==="scope"){const links=await mockPrisma.membershipScope.findMany({where:{membershipId:a.membershipId}});await mockPrisma.membershipScope.deleteMany({where:{membershipId:a.membershipId}});restore=()=>mockPrisma.membershipScope.createMany({data:links});}
else{const links=await mockPrisma.membershipRole.findMany({where:{membershipId:a.membershipId}});await mockPrisma.membershipRole.deleteMany({where:{membershipId:a.membershipId}});restore=()=>mockPrisma.membershipRole.createMany({data:links});}
try{await expect(list({user:{...a,permissions:["policy.override","integration.provider.read"]}})).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);}finally{await restore();}
});
