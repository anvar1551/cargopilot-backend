jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => { const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
// Domain envelope only is mocked to guarantee no Redis/logger import; actual transactional outbox writes run.
jest.mock("../../src/modules/analytics-core/realtime/analyticsEvents", () => ({ buildCargoPilotDomainEvent: (input: any) => ({ ...input, id: require("crypto").randomUUID(), occurredAt: new Date().toISOString(), schemaVersion: 1 }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { issueOrderInvoiceForActor } from "../../src/modules/invoice-core/application/invoiceRepo";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,runId=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!runId||!/^[a-f0-9]{12}$/.test(runId))throw Error("Disposable invoice identity required");
const target=new URL(url);
if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${runId}`)throw Error("Refusing existing PostgreSQL target");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"});
let mockPrisma:PrismaClient;
const fixture=createTenantDemoFixture();
const actor:any={id:ids.users.maker,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.makerTransAsia,companyId:ids.organizations.transAsiaUz,companyMembershipId:ids.companyMemberships.makerTransAsiaUz,membershipId:ids.companyMemberships.makerTransAsiaUz};
const orderId=ids.orders.transAsiaUz;
const issue=(order:string=orderId,extras:any={})=>issueOrderInvoiceForActor({user:actor,orderId:order,...extras});
async function snapshot(){return {invoices:await mockPrisma.invoice.findMany({orderBy:{id:"asc"}}),outbox:await mockPrisma.analyticsDomainEventOutbox.findMany({orderBy:{id:"asc"}})};}
beforeAll(async()=>{
 const marker=await pool.query('SELECT "runId" FROM "_CPDisposableRun"');if(marker.rows.length!==1||marker.rows[0].runId!==runId)throw Error("Disposable ownership mismatch");
 const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,fixture);await client.query("COMMIT");}finally{client.release();}
 mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});
 const permission=await mockPrisma.permission.create({data:{key:"finance.invoices.issue",resource:"synthetic-invoice",action:"issue"}});
 const role=await mockPrisma.role.create({data:{companyId:actor.companyId,code:"synthetic-invoice",name:"Synthetic"}});
 await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
 await mockPrisma.membershipRole.create({data:{membershipId:actor.membershipId,roleId:role.id}});
 await mockPrisma.membershipScope.create({data:{membershipId:actor.membershipId,scopeType:"company",scopeRefId:actor.companyId}});
});
beforeEach(async()=>{await mockPrisma.invoice.update({where:{orderId},data:{status:"issued",issuedAt:new Date("2026-01-01T00:00:00Z"),issuedByUserId:actor.id,dueAt:null,amount:"90071992547409.9300",fxRate:"1.1234567890"}});});
afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();});
it("concurrent authorized receipt requests preserve one exact immutable result and no outbox",async()=>{const before=await snapshot();const results=await Promise.all([issue(),issue(),issue()]);expect(new Set(results.map(r=>r.id)).size).toBe(1);for(const r of results)expect(r).toMatchObject({amount:"90071992547409.9300",fxRate:"1.1234567890"});expect(await snapshot()).toEqual(before);});
it.each([ids.orders.transAsiaDe,ids.orders.unrelated])("foreign company or tenant rejects without effects",async foreign=>{const before=await snapshot();await expect(issue(foreign)).rejects.toMatchObject({statusCode:404});expect(await snapshot()).toEqual(before);});
it("pending pricing lacks approved acceptance and cannot emit finance work",async()=>{await mockPrisma.invoice.update({where:{orderId},data:{status:"pending",issuedAt:null,issuedByUserId:null}});const before=await snapshot();const outcomes=await Promise.allSettled([issue(),issue(),issue()]);for(const result of outcomes){expect(result.status).toBe("rejected");if(result.status==="rejected")expect(result.reason.code).toBe("INVOICE_PRICING_ACCEPTANCE_REQUIRED");}expect(await snapshot()).toEqual(before);});
it("legacy unowned invoice is never backfilled",async()=>{await mockPrisma.invoice.update({where:{orderId},data:{tenantId:null}});const before=await snapshot();try{await expect(issue()).rejects.toMatchObject({statusCode:409});expect(await snapshot()).toEqual(before);}finally{await mockPrisma.invoice.update({where:{orderId},data:{tenantId:actor.tenantId}});}});
it("conflicting receipt intent preserves original due date and money",async()=>{const before=await snapshot();await expect(issue(orderId,{dueAt:new Date("2027-01-01")})).rejects.toMatchObject({statusCode:409});expect(await snapshot()).toEqual(before);});
it("suspended selected membership denies before effects",async()=>{await mockPrisma.companyMembership.update({where:{id:actor.membershipId},data:{status:"suspended"}});const before=await snapshot();try{await expect(issue()).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);}finally{await mockPrisma.companyMembership.update({where:{id:actor.membershipId},data:{status:"active"}});}});
it("failed transaction leaves receipt and outbox unchanged and releases the parent lock",async()=>{const before=await snapshot();const original=mockPrisma.$transaction.bind(mockPrisma);const spy=jest.spyOn(mockPrisma,"$transaction").mockImplementationOnce(async(fn:any,opts:any)=>original(async(tx:any)=>{await fn(tx);throw Error("synthetic invoice transaction failure");},opts) as any);try{await expect(issue()).rejects.toThrow("synthetic invoice transaction failure");expect(await snapshot()).toEqual(before);}finally{spy.mockRestore();}expect((await issue()).id).toBe(ids.invoices.transAsiaUz);});
