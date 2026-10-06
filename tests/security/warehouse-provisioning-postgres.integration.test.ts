jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, {
        get: (_target, key) => { const value = (mockDb as any)[key]; return typeof value === "function" ? value.bind(mockDb) : value; },
    }) }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: async () => null, getRedisPrefix: () => "synthetic",
    withRedisTimeout: (_name: any, work: any) => work() }));
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { generateKeyPairSync, createHash, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { onboardTenant, canonicalOnboardingPermit, ONBOARDING_OPERATOR, ONBOARDING_PROFILE, ONBOARDING_PERMISSIONS, ONBOARDING_PROFILE_V2 } from "../../src/modules/identity-access/application/tenant-onboarding";
import { normalizeTenantOnboardingIntent } from "../../src/modules/identity-access/application/tenant-onboarding-intent";
import { SYSTEM_PERMISSIONS } from "../../src/modules/identity-access/permission-registry";
import { loginUser } from "../../src/modules/identity-access/application/auth.service";
const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run))
    throw Error("Disposable onboarding identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.password !== "synthetic-worker-only" || target.pathname !== `/cp_worker_${run}`)
    throw Error("Refusing existing database");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000, options: "-c statement_timeout=5000 -c lock_timeout=3000" });
let mockDb: PrismaClient;
const keys = generateKeyPairSync("ed25519"); // In-memory test-only private key.
const keyFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "cp-onboarding-pg-")), registryPath = join(directory, "registry.json");
const registry = { version: 1, enabled: true, revoked: false, operatorId: ONBOARDING_OPERATOR,
    profileRevision: ONBOARDING_PROFILE_V2, keyFingerprint, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) };
const password = randomUUID() + "-test-only";
const credentialHash = bcrypt.hashSync(password, 12);
const credentialCommitment = createHash("sha256").update(credentialHash).digest("hex");
const intent = () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    return {
        operationId: randomUUID(), tenant: { code: `SYN-T-${suffix}`, name: "Synthetic tenant" },
        company: { code: `SYN-C-${suffix}`, name: "Synthetic company" },
        administrator: { email: `synthetic-${suffix}@example.invalid`, name: "Synthetic administrator" },
        profileRevision: ONBOARDING_PROFILE_V2, credentialCommitment, reason: "Synthetic owner-approved onboarding"
    };
};
function request(input = intent()) {
    const normalized = normalizeTenantOnboardingIntent(input), now = Date.now();
    const permit = { version: 1, operatorId: ONBOARDING_OPERATOR, keyFingerprint,
        operationId: normalized.intent.operationId, intentFingerprint: normalized.fingerprint,
        profileRevision: ONBOARDING_PROFILE_V2, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240000).toISOString() };
    return { intent: input, permit, signature: sign(null, Buffer.from(canonicalOnboardingPermit(permit)), keys.privateKey).toString("base64"), initialCredentialHash: credentialHash };
}
const tables = ["Tenant", "Organization", "User", "TenantMembership", "CompanyMembership", "Role", "RolePermission", "MembershipRole", "MembershipScope", "TenantOnboardingReceipt", "CompanyDelegationAuthority", "CompanyInvitation", "CompanyOperationalGrant", "CompanyDelegationAction", "UserRefreshSession", "CredentialSecurityEvent", "CompanyDriverDelegationAuthority", "CompanyDriverInvitation", "CompanyDriverEligibility", "CompanyDriverAction", "Warehouse", "WarehouseProvisioningAuthority", "WarehouseProvisioningAction", "Order", "Tracking", "OrderCustodyAction"];
async function counts() { const result: Record<string, number> = {}; for (const table of tables)
    result[table] = Number((await pool.query(`SELECT count(*) AS count FROM "${table}"`)).rows[0].count); return result; }
let warehouseOwner: ReturnType<typeof syntheticWarehouseOwner>;
beforeAll(async () => {
    const marker = await pool.query('SELECT "runId" FROM "_CPDisposableRun"');
    if (marker.rows.length !== 1 || marker.rows[0].runId !== run)
        throw Error("Disposable marker mismatch");
    mockDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4,
            connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
            options: "-c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000" }) });
    await mockDb.permission.createMany({ data: SYSTEM_PERMISSIONS, skipDuplicates: true });
    process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH = registryPath;
    process.env.JWT_SECRET = randomUUID();
    process.env.REFRESH_TOKEN_SECRET = randomUUID();
    warehouseOwner = syntheticWarehouseOwner();
}, 30000);
beforeEach(() => writeFileSync(registryPath, JSON.stringify(registry)));
afterAll(async () => {
    warehouseOwner?.cleanup();
    await mockDb?.$disconnect();
    await pool.end();
    unlinkSync(registryPath);
    rmdirSync(directory); // Exact run-owned public-key files only.
    delete process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH;
});

import { syntheticWarehouseOwner } from "./warehouse-provisioning.fixture";
import { authorizeWarehouseProvisioner } from "../../src/modules/warehouse-core/application/warehouseProvisioning";
import { createWarehouse, listWarehouses, getWarehouseById } from "../../src/modules/warehouse-core/application/warehouseRepo";
import { authorizeCompanyDelegator, createCompanyInvitation, acceptCompanyInvitation } from "../../src/modules/identity-access/application/company-delegation";
import { delegationFingerprint } from "../../src/modules/identity-access/application/operational-profiles";
import { listCustodyWork } from "../../src/modules/orders-core/read/custody-work";
import { readWarehouseCustody } from "../../src/modules/orders-core/operations/warehouse-custody";
import Fastify from "fastify";
import routes from "../../src/modules/warehouse-core/transport/fastify-routes";
async function admin() {
 process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH=registryPath; writeFileSync(registryPath,JSON.stringify(registry));
 const r=request(), result=await onboardTenant(mockDb,r),login=await loginUser({email:r.intent.administrator.email,password});
 return {...result,actor:{...login.user,id:login.user.userId},email:r.intent.administrator.email};
}
async function provisioner(){const a=await admin();warehouseOwner.register();const authorization=warehouseOwner.request(a.companyMembershipId);await authorizeWarehouseProvisioner(mockDb,authorization);return {...a,authorization};}
const input=()=>({operationId:randomUUID(),name:"Synthetic controlled warehouse",location:"Synthetic address",type:"warehouse"});
async function graph(){const data=[];for(const table of tables)data.push((await pool.query('SELECT to_jsonb(t) AS row FROM "'+table+'" t ORDER BY to_jsonb(t)::text')).rows);return createHash("sha256").update(JSON.stringify(data)).digest("hex");}
async function rejected(work:()=>Promise<unknown>){const before=await graph();await expect(work()).rejects.toThrow();expect(await graph()).toBe(before);}
async function operationalCeiling(membershipId:string,warehouseIds:string[]){
 process.env.CARGOPILOT_ONBOARDING_REGISTRY_PATH=registryPath;
 const intent={operationId:randomUUID(),membershipId,action:"operator-authorize",warehouseIds:[...warehouseIds].sort(),ceilingRevision:"operational-delegation.v1",profileRevision:ONBOARDING_PROFILE_V2,reason:"Synthetic separately reviewed warehouse ceiling"};
 const now=Date.now(),permit={version:1,operatorId:ONBOARDING_OPERATOR,keyFingerprint,operationId:intent.operationId,intentFingerprint:delegationFingerprint("operator-authority",intent),profileRevision:ONBOARDING_PROFILE_V2,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+240000).toISOString()};
 await authorizeCompanyDelegator(mockDb,{intent,permit,signature:sign(null,Buffer.from(canonicalOnboardingPermit(permit)),keys.privateKey).toString("base64")});warehouseOwner.register();
}
it("owner authority is separately accepted; exact permission only, normalized creation/retry and no implicit access/ceiling",async()=>{
 const a=await provisioner(),v=input();const roles=await mockDb.membershipRole.findMany({where:{membershipId:a.companyMembershipId},include:{role:{include:{rolePermissions:{include:{permission:true}}}}}});
 expect(roles.find(r=>r.role.code==="warehouse-provisioner.v1")?.role.rolePermissions.map(r=>r.permission.key)).toEqual(["warehouse.create"]);
 const scopes=await mockDb.membershipScope.findMany({where:{membershipId:a.companyMembershipId}}),ceiling=await mockDb.companyDelegationAuthority.findUniqueOrThrow({where:{membershipId:a.companyMembershipId}});
 const w=await createWarehouse(a.actor,{...v,name:"  "+v.name+"  ",region:"  "});expect((await mockDb.warehouse.findUniqueOrThrow({where:{id:w.id}})).tenantId).toBe(a.tenantId);
 const state=await graph();expect(await createWarehouse(a.actor,{...v,latitude:null,longitude:null,region:null})).toEqual(w);expect(await graph()).toBe(state);
 expect(await mockDb.membershipScope.findMany({where:{membershipId:a.companyMembershipId}})).toEqual(scopes);expect(await mockDb.companyDelegationAuthority.findUniqueOrThrow({where:{membershipId:a.companyMembershipId}})).toEqual(ceiling);
 await expect(listWarehouses(a.actor)).rejects.toThrow("Explicit warehouse scope");
 expect(await authorizeWarehouseProvisioner(mockDb,a.authorization)).toEqual({companyMembershipId:a.companyMembershipId,enabled:true,profileRevision:"warehouse-provisioning.v1"});expect(await graph()).toBe(state);
});
it("permission alone and operational v2 permit cannot establish warehouse provisioning authority",async()=>{
 const a=await admin();await rejected(()=>createWarehouse(a.actor,input()));
 const role=await mockDb.role.create({data:{companyId:a.companyId,code:randomUUID(),name:"Synthetic ordinary capability",rolePermissions:{create:{permission:{connect:{key:"warehouse.create"}}}}}});await mockDb.membershipRole.create({data:{membershipId:a.companyMembershipId,roleId:role.id}});
 await rejected(()=>createWarehouse(a.actor,input()));warehouseOwner.register();const r=warehouseOwner.request(a.companyMembershipId);r.permit.profileRevision=ONBOARDING_PROFILE_V2;await rejected(()=>authorizeWarehouseProvisioner(mockDb,r));
});
it.each([{tenantId:randomUUID()},{companyId:randomUUID()},{users:{connect:{id:randomUUID()}}},{latitude:91},{type:"unknown"},{operationId:undefined}])("strict invalid/ownership fields reject without writes: %j",async extra=>{const a=await provisioner();await rejected(()=>createWarehouse(a.actor,{...input(),...extra}));});
it("foreign selected ownership and missing context reject; unchanged unrelated company grants",async()=>{
 const a=await provisioner(),b=await provisioner();await rejected(()=>createWarehouse({...a.actor,tenantId:b.tenantId},input()));await rejected(()=>createWarehouse({...a.actor,companyId:b.companyId},input()));await rejected(()=>createWarehouse({...a.actor,tenantMembershipId:undefined} as any,input()));
 const r=warehouseOwner.request(a.companyMembershipId,"operator-revoke");const bAuthority=await mockDb.warehouseProvisioningAuthority.findUniqueOrThrow({where:{membershipId:b.companyMembershipId}});await authorizeWarehouseProvisioner(mockDb,r);expect(await mockDb.warehouseProvisioningAuthority.findUniqueOrThrow({where:{membershipId:b.companyMembershipId}})).toEqual(bAuthority);
});
it("concurrent matching creation and lost acknowledgement yield one warehouse and one creation audit",async()=>{
 const a=await provisioner(),v=input(),before=await counts();const results=await Promise.all([createWarehouse(a.actor,v),createWarehouse(a.actor,v),createWarehouse(a.actor,v)]);expect(new Set(results.map(r=>r.id)).size).toBe(1);
 const after=await counts();expect(after.Warehouse-before.Warehouse).toBe(1);expect(after.WarehouseProvisioningAction-before.WarehouseProvisioningAction).toBe(1);
 const state=await graph();expect(await createWarehouse(a.actor,v)).toEqual(results[0]);expect(await graph()).toBe(state);await rejected(()=>createWarehouse(a.actor,{...v,name:"Different intent"}));
});
it("revocation removes only provisioner role; confirmed retries require current authority",async()=>{
 const a=await provisioner(),v=input();await createWarehouse(a.actor,v);const originalRoles=await mockDb.membershipRole.findMany({where:{membershipId:a.companyMembershipId},include:{role:true}});
 await authorizeWarehouseProvisioner(mockDb,warehouseOwner.request(a.companyMembershipId,"operator-revoke"));
 const roles=await mockDb.membershipRole.findMany({where:{membershipId:a.companyMembershipId},include:{role:true}});expect(roles.map(r=>r.roleId).sort()).toEqual(originalRoles.filter(r=>r.role.code!=="warehouse-provisioner.v1").map(r=>r.roleId).sort());
 await rejected(()=>createWarehouse(a.actor,v));await rejected(()=>createWarehouse(a.actor,input()));
});
it.each(["create-first","revoke-first"])("creation versus owner revocation serializes %s",async first=>{
 const a=await provisioner(),v=input(),r=warehouseOwner.request(a.companyMembershipId,"operator-revoke"),before=await counts();
 const gate=await pool.connect();let one:Promise<unknown>|undefined,two:Promise<unknown>|undefined;
 const settled=(work:Promise<unknown>)=>work.then(value=>({ok:true,value}),error=>({ok:false,error}));
 async function waiting(n:number){const end=Date.now()+5000;while(Date.now()<end){const row=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()");if(row.rows[0].n>=n)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Expected PostgreSQL lock barrier');}
 try{await gate.query('BEGIN');await gate.query('SELECT id FROM "User" WHERE id=$1 FOR UPDATE',[a.actor.id]);
  one=settled(first==="create-first"?createWarehouse(a.actor,v):authorizeWarehouseProvisioner(mockDb,r));await waiting(1);
  two=settled(first==="create-first"?authorizeWarehouseProvisioner(mockDb,r):createWarehouse(a.actor,v));await waiting(2);await gate.query('COMMIT');
  const results=await Promise.all([one,two]) as Array<{ok:boolean,value?:unknown,error?:unknown}>;
  expect(results[0].ok).toBe(true);expect(results[1].ok).toBe(first==="create-first");
  const after=await counts();expect(after.Warehouse-before.Warehouse).toBe(first==="create-first"?1:0);expect(after.WarehouseProvisioningAction-before.WarehouseProvisioningAction).toBe(first==="create-first"?2:1);
  expect((await mockDb.warehouseProvisioningAuthority.findUniqueOrThrow({where:{membershipId:a.companyMembershipId}})).enabled).toBe(false);
  await rejected(()=>createWarehouse(a.actor,v));
 }finally{await gate.query('ROLLBACK');gate.release();await Promise.all([one,two].filter(Boolean));}
});
it("missing permission/company scope and suspended membership deny despite durable authority",async()=>{
 const a=await provisioner();await mockDb.membershipRole.deleteMany({where:{membershipId:a.companyMembershipId,role:{code:"warehouse-provisioner.v1"}}});await rejected(()=>createWarehouse(a.actor,input()));
 const b=await provisioner();await mockDb.membershipScope.deleteMany({where:{membershipId:b.companyMembershipId}});await rejected(()=>createWarehouse(b.actor,input()));
 const c=await provisioner();await mockDb.companyMembership.update({where:{id:c.companyMembershipId},data:{status:"suspended"}});await rejected(()=>createWarehouse(c.actor,input()));
});
it("final immutable-action failure rolls back warehouse, authority/grant/version/session changes",async()=>{
 const a=await provisioner();await pool.query(`CREATE FUNCTION cp_warehouse_fail() RETURNS trigger LANGUAGE plpgsql AS $warehouse_test$ BEGIN RAISE EXCEPTION 'Synthetic final action failure'; END $warehouse_test$; CREATE TRIGGER cp_warehouse_fail BEFORE INSERT ON "WarehouseProvisioningAction" FOR EACH ROW EXECUTE FUNCTION cp_warehouse_fail();`);
 try{await rejected(()=>createWarehouse(a.actor,input()));await rejected(()=>authorizeWarehouseProvisioner(mockDb,warehouseOwner.request(a.companyMembershipId,"operator-revoke")));}finally{await pool.query('DROP TRIGGER cp_warehouse_fail ON "WarehouseProvisioningAction"; DROP FUNCTION cp_warehouse_fail();');}
});
it.each(['UPDATE "WarehouseProvisioningAction" SET reason=\'changed\'','DELETE FROM "WarehouseProvisioningAction"','TRUNCATE "WarehouseProvisioningAction"'])("protected audit rejects %s preserving complete graph",async sql=>{const a=await provisioner(),v=input(),w=await createWarehouse(a.actor,v);await rejected(()=>pool.query(sql));expect(await createWarehouse(a.actor,v)).toEqual(w);});
it("compound acceptance and warehouse relationships reject foreign references",async()=>{
 const a=await provisioner(),b=await provisioner(),w=await createWarehouse(b.actor,input());
 await rejected(()=>pool.query('UPDATE "WarehouseProvisioningAuthority" SET "tenantId"=$1 WHERE "membershipId"=$2',[b.tenantId,a.companyMembershipId]));
 await rejected(()=>pool.query('UPDATE "WarehouseProvisioningAuthority" SET "acceptedOperationId"=$1 WHERE "membershipId"=$2',[b.authorization.intent.operationId,a.companyMembershipId]));
 await rejected(()=>pool.query('INSERT INTO "WarehouseProvisioningAction" ("operationId","tenantId","companyId","membershipId","userId","tenantMembershipId",action,fingerprint,"warehouseId",reason,result) VALUES ($1,$2,$3,$4,$5,$6,\'create\',$7,$8,\'Synthetic foreign receipt\',\'{}\')',[randomUUID(),a.tenantId,a.companyId,a.companyMembershipId,a.actor.id,a.tenantMembershipId,'a'.repeat(64),w.id]));
});
it("actual creation HTTP retains safe shape, requires immutable operation identity and current authority",async()=>{
 const a=await provisioner(),login=await loginUser({email:a.email,password}),app=Fastify();await app.register(routes,{prefix:"/api/warehouses"});try{
 const v=input(),headers={authorization:"Bearer "+login.token};expect((await app.inject({method:"POST",url:"/api/warehouses/",payload:v})).statusCode).toBe(401);
 const response=await app.inject({method:"POST",url:"/api/warehouses/",headers,payload:v});expect(response.statusCode).toBe(201);expect(Object.keys(response.json()).sort()).toEqual(["createdAt","id","latitude","location","longitude","name","region","type"].sort());
 const state=await graph();expect((await app.inject({method:"POST",url:"/api/warehouses/",headers,payload:v})).json()).toEqual(response.json());expect(await graph()).toBe(state);
 expect((await app.inject({method:"POST",url:"/api/warehouses/",headers,payload:{...v,name:"Conflict"}})).statusCode).toBe(409);expect(await graph()).toBe(state);
 await authorizeWarehouseProvisioner(mockDb,warehouseOwner.request(a.companyMembershipId,"operator-revoke"));expect((await app.inject({method:"POST",url:"/api/warehouses/",headers,payload:input()})).statusCode).toBe(401);
 }finally{await app.close();}
});
it("creation -> separate owner ceiling -> invitation acceptance -> exact scoped custody discovery/read",async()=>{
 const a=await provisioner(),w=await createWarehouse(a.actor,input()),other=await createWarehouse(a.actor,input()),b=await provisioner();
 await rejected(()=>createCompanyInvitation(mockDb,a.actor,{operationId:randomUUID(),email:randomUUID()+"@example.invalid",profileRevision:"operational-warehouse.v1",warehouseIds:[w.id],reason:"Must not implicitly extend ceiling"}));
 await operationalCeiling(a.companyMembershipId,[w.id]);const invitation=await createCompanyInvitation(mockDb,a.actor,{operationId:randomUUID(),email:randomUUID()+"@example.invalid",profileRevision:"operational-warehouse.v1",warehouseIds:[w.id],reason:"Synthetic scoped warehouse staff"});
 const email=(await mockDb.companyInvitation.findUniqueOrThrow({where:{id:invitation.invitationId}})).email;
 const enrollment=await acceptCompanyInvitation(mockDb,{token:invitation.token,operationId:randomUUID(),name:"Synthetic warehouse staff",password});const login=await loginUser({email,password}),staff={...login.user,id:login.user.userId};
 expect(await mockDb.membershipScope.findMany({where:{membershipId:enrollment.companyMembershipId},select:{scopeType:true,scopeRefId:true}})).toEqual([{scopeType:"warehouse",scopeRefId:w.id}]);
 expect(await getWarehouseById(staff,w.id)).toMatchObject({id:w.id});expect(await getWarehouseById(staff,other.id)).toBeNull();await rejected(()=>createWarehouse(staff,input()));
 // Only synthetic pre-existing operational work, not a shortcut for the order creation workflow.
 const order=await mockDb.order.create({data:{orderNumber:"SYN-WH-"+randomUUID(),tenantId:a.tenantId,ownerOrgId:a.companyId,currentWarehouseId:w.id,status:"at_warehouse",customerId:a.actor.id,pickupAddress:"Synthetic pickup",dropoffAddress:"Synthetic destination"}});
 const tracking=await mockDb.tracking.create({data:{orderId:order.id,status:"at_warehouse",actorId:staff.id,warehouseId:w.id}});
 await mockDb.orderCustodyAction.create({data:{id:randomUUID(),tenantId:a.tenantId,companyId:a.companyId,orderId:order.id,operationId:randomUUID(),sequence:1,action:"intake",phase:"warehouse",actorUserId:staff.id,companyMembershipId:staff.companyMembershipId!,tenantMembershipId:staff.tenantMembershipId!,intentHash:'a'.repeat(64),intent:{synthetic:true},warehouseId:w.id,trackingId:tracking.id,beforeState:{},result:{synthetic:true}}});
 const before=await graph(),work=await listCustodyWork(staff,{kind:"warehouse",limit:1});expect(work.items.map(r=>r.orderId)).toContain(order.id);expect((await readWarehouseCustody(staff,order.id)).custody?.warehouseId).toBe(w.id);expect(await graph()).toBe(before);
 await rejected(()=>readWarehouseCustody(b.actor,order.id));
});
