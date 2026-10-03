jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:new Proxy({}, {get:(_t,k)=>{const value=(mockPrisma as any)[k];return typeof value === "function"?value.bind(mockPrisma):value;}})}));
jest.mock("../../src/config/redis",()=>({getRedisClient:async()=>null,getRedisPrefix:()=>"synthetic",withRedisTimeout:(_label:any,work:any)=>work()}));
import {Pool} from "pg";
import {PrismaClient} from "@prisma/client";
import {PrismaPg} from "@prisma/adapter-pg";
import {randomUUID} from "crypto";
import {createTenantDemoFixture,TENANT_DEMO_IDS as ids} from "../../src/modules/tenancy/demo-fixtures";
import {persistTenantDemoFixture} from "../tenancy/postgres-fixture.persistence";
import {prismaFinanceRepository as repo} from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";
import {LOGISTICS_STANDARD_CHART} from "../../src/modules/finance-core/domain/chart-template";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,runId=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!runId||!/^[a-f0-9]{12}$/.test(runId))throw Error("Disposable account identity required");
const target=new URL(url);if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${runId}`)throw Error("Refusing existing database");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,options:"-c statement_timeout=5000"});let mockPrisma:PrismaClient;
const actor=(companyId:string,membershipId:string):any=>({id:ids.users.multiTenant,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.multiTransAsia,companyId,companyMembershipId:membershipId,membershipId});
const uz=actor(ids.organizations.transAsiaUz,ids.companyMemberships.multiTransAsiaUz),de=actor(ids.organizations.transAsiaDe,ids.companyMemberships.multiTransAsiaDe);
const intent=(who:any)=>({companyId:who.companyId,actorUserId:who.id,code:randomUUID(),name:"SYNTHETIC ONLY",type:"asset" as const,allowPosting:false,isControlAccount:false});
const snapshot=async()=>({accounts:await mockPrisma.financeAccount.findMany({orderBy:{id:"asc"}}),installations:await mockPrisma.financeChartTemplateInstallation.findMany({orderBy:{id:"asc"}}),audit:await mockPrisma.financeAuditEvent.findMany({orderBy:{id:"asc"}}),outbox:await mockPrisma.financeDomainEventOutbox.findMany({orderBy:{id:"asc"}}),journals:await mockPrisma.financeJournalEntry.findMany({orderBy:{id:"asc"}})});
beforeAll(async()=>{
 const proof=await pool.query('SELECT "runId" FROM "_CPDisposableRun"');if(proof.rows.length!==1||proof.rows[0].runId!==runId)throw Error("Disposable storage ownership mismatch");
 const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,createTenantDemoFixture());await client.query("COMMIT");}finally{client.release();}
 mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});
 const permission=await mockPrisma.permission.create({data:{key:"finance.accounts.manage",resource:"synthetic",action:"manage"}});
 for(const who of [uz,de]){const role=await mockPrisma.role.create({data:{companyId:who.companyId,code:"synthetic-account",name:"Synthetic account role"}});await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});await mockPrisma.membershipRole.create({data:{membershipId:who.membershipId,roleId:role.id}});if(!await mockPrisma.membershipScope.findFirst({where:{membershipId:who.membershipId,scopeType:"company",scopeRefId:who.companyId}}))await mockPrisma.membershipScope.create({data:{membershipId:who.membershipId,scopeType:"company",scopeRefId:who.companyId}});}
},60000);
afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();});
it("actual account ownership rejects foreign intent and revoked context without effects",async()=>{
 const account:any=await repo.createAccount(intent(uz),uz);expect(account.legalEntityId).toBe(ids.legalEntities.transAsiaUz);
 const before=await snapshot();for(const companyId of [ids.organizations.transAsiaDe,ids.organizations.unrelated])await expect(repo.createAccount({...intent(uz),companyId},uz)).rejects.toMatchObject({statusCode:403});
 await expect(repo.createAccount(intent(uz),undefined as any)).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);
 await mockPrisma.companyMembership.update({where:{id:uz.membershipId},data:{status:"suspended"}});await expect(repo.createAccount(intent(uz),uz)).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);
});
it("actual standard source installs owned graph and version-scoped retry rejects changed configuration",async()=>{
 const input={companyId:de.companyId,actorUserId:de.id,templateCode:"logistics_standard",templateVersion:1,accounts:[...LOGISTICS_STANDARD_CHART]};
 const created:any=await repo.bootstrapChart(input,de);expect(created.idempotent).toBe(false);expect(created.accounts).toHaveLength(LOGISTICS_STANDARD_CHART.length);expect(created.accounts.every((account:any)=>account.legalEntityId===ids.legalEntities.transAsiaDe)).toBe(true);
 const before=await snapshot(),again:any=await repo.bootstrapChart(input,de);expect(again.idempotent).toBe(true);expect(await snapshot()).toEqual(before);
 await expect(repo.bootstrapChart({...input,accounts:[]},de)).rejects.toMatchObject({code:"FINANCE_CHART_TEMPLATE_SOURCE_REJECTED"});expect(await snapshot()).toEqual(before);
 const row=created.accounts[0];await mockPrisma.financeAccount.update({where:{id:row.id},data:{metadataJson:{templateCode:"logistics_standard",templateVersion:2}}});
 const changed=await snapshot();await expect(repo.bootstrapChart(input,de)).rejects.toMatchObject({code:"FINANCE_CHART_TEMPLATE_INTEGRITY_ERROR"});expect(await snapshot()).toEqual(changed);
});
it("actual outbox failure rolls back new account and audit together",async()=>{
 const before=await snapshot();await pool.query(`CREATE FUNCTION cp_account_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END $$;CREATE TRIGGER cp_account_outbox_fail BEFORE INSERT ON "FinanceDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_account_outbox_fail();`);
 try{await expect(repo.createAccount(intent(de),de)).rejects.toThrow("synthetic outbox failure");expect(await snapshot()).toEqual(before);}finally{await pool.query('DROP TRIGGER cp_account_outbox_fail ON "FinanceDomainEventOutbox";DROP FUNCTION cp_account_outbox_fail();');}
});
