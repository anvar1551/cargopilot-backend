jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => { const value = (mockPrisma as any)[name]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
// Domain envelope only is mocked to guarantee no Redis/logger import; actual transactional outbox writes run.
jest.mock("../../src/modules/analytics-core/realtime/analyticsEvents", () => ({ buildCargoPilotDomainEvent: (input: any) => ({ ...input, id: require("crypto").randomUUID(), occurredAt: new Date().toISOString(), schemaVersion: 1 }) }));
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { createSupportTicket, getSupportTicketScoped, listSupportTickets, getSupportSummary, assignSupportTicket, addSupportTicketMessage, updateSupportTicketStatus } from "../../src/modules/support-core/application/supportService";
import { maintainOwnedSupportTickets } from "../../src/modules/support-core/application/supportMaintenance";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,runId=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!runId||!/^[a-f0-9]{12}$/.test(runId))throw Error("Disposable support identity required");
const target=new URL(url);
if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${runId}`)throw Error("Refusing existing PostgreSQL target");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"});
let mockPrisma:PrismaClient;
const fixture=createTenantDemoFixture();
const actor:any={id:ids.users.maker,tenantId:ids.tenants.transAsia,tenantMembershipId:ids.tenantMemberships.makerTransAsia,companyId:ids.organizations.transAsiaUz,companyMembershipId:ids.companyMemberships.makerTransAsiaUz,membershipId:ids.companyMemberships.makerTransAsiaUz};
const permissions=["support.view","support.createTicket","support.update","support.assign","support.resolve","support.escalate","support.configure","shipment.view","customers.read"];
async function counts(){return {tickets:await mockPrisma.supportTicket.count(),messages:await mockPrisma.supportTicketMessage.count(),events:await mockPrisma.supportTicketEvent.count(),notifications:await mockPrisma.userNotification.count(),outbox:await mockPrisma.analyticsDomainEventOutbox.count()};}
async function create(title="Synthetic support"){return createSupportTicket({title},actor);}
beforeAll(async()=>{
 const marker=await pool.query('SELECT "runId" FROM "_CPDisposableRun"');if(marker.rows.length!==1||marker.rows[0].runId!==runId)throw Error("Disposable ownership mismatch");
 const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,fixture);await client.query("COMMIT");}finally{client.release();}
 mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});
 for(const key of permissions)await mockPrisma.permission.create({data:{key,resource:"synthetic-support",action:key}});
 for(const membership of fixture.companyMemberships){
  const role=await mockPrisma.role.create({data:{companyId:membership.companyId,code:`synthetic-${membership.id}`,name:"Synthetic Support"}});
  for(const key of permissions){const permission=await mockPrisma.permission.findUniqueOrThrow({where:{key}});await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});}
  await mockPrisma.membershipRole.create({data:{membershipId:membership.id,roleId:role.id}});
  await mockPrisma.membershipScope.create({data:{membershipId:membership.id,scopeType:"company",scopeRefId:membership.companyId}});
 }
 for(const warehouse of fixture.warehouses.filter(w=>w.tenantId===actor.tenantId))await mockPrisma.membershipScope.create({data:{membershipId:actor.membershipId,scopeType:"warehouse",scopeRefId:warehouse.id}});
});
afterEach(()=>jest.restoreAllMocks());afterAll(async()=>{await mockPrisma?.$disconnect();await pool.end();});
it("valid creation commits ticket, history, owned recipient and outbox atomically",async()=>{
 const before=await counts();const ticket=await createSupportTicket({title:"Synthetic assigned",ownerId:actor.id},actor);
 const stored=await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}});expect(stored).toMatchObject({tenantId:actor.tenantId,ownerOrgId:actor.companyId,ownerId:actor.id,ownerCompanyMembershipId:actor.membershipId});
 const after=await counts();expect(after.tickets-before.tickets).toBe(1);expect(after.events-before.events).toBe(1);expect(after.outbox-before.outbox).toBe(1);expect(after.notifications-before.notifications).toBe(1);
});
it.each(["foreign-tenant","same-tenant-company","legacy"])("list/detail/count/mutation hide %s ownership",async kind=>{
 const company=kind==="same-tenant-company"?ids.organizations.transAsiaDe:kind==="foreign-tenant"?fixture.organizations.find(o=>o.tenantId===ids.tenants.unrelated&&o.type==="company")!.id:actor.companyId;
 const ticket=await mockPrisma.supportTicket.create({data:{ticketNumber:`SYNTHETIC-${randomUUID()}`,title:"Hidden",tenantId:kind==="legacy"?null:kind==="foreign-tenant"?ids.tenants.unrelated:actor.tenantId,ownerOrgId:company}});
 expect((await getSupportTicketScoped({actor,id:ticket.id})).payload).toBeNull();
 expect((await listSupportTickets({actor,owner:"all"})).payload.items.map(t=>t.id)).not.toContain(ticket.id);
 const before=await counts();await expect(addSupportTicketMessage(ticket.id,"Denied",actor)).rejects.toMatchObject({statusCode:404});expect(await counts()).toEqual(before);expect((await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}})).lastMessage).toBeNull();
 const summary=await getSupportSummary({actor});const ownedOpen=await mockPrisma.supportTicket.count({where:{tenantId:actor.tenantId,ownerOrgId:actor.companyId,archivedAt:null,status:{not:"resolved"}}});expect(summary.open).toBe(ownedOpen);
});
it("same user selected in another tenant cannot read the A ticket",async()=>{
 const ticket=await create();const membership=fixture.companyMemberships.find(m=>m.userId===ids.users.multiTenant&&m.tenantId===ids.tenants.unrelated)!;
 const other:any={id:membership.userId,tenantId:membership.tenantId,tenantMembershipId:membership.tenantMembershipId,companyId:membership.companyId,membershipId:membership.id,companyMembershipId:membership.id};
 expect((await getSupportTicketScoped({actor:other,id:ticket.id})).payload).toBeNull();const valid=await createSupportTicket({title:"Synthetic B"},other);expect((await getSupportTicketScoped({actor:other,id:valid.id})).payload?.id).toBe(valid.id);
});
it("linked order resolves authoritative tenant/company/customer/warehouse, valid writes",async()=>{
 const order=fixture.orders.find(o=>o.ownerOrgId===actor.companyId)!;
 const ticket=await createSupportTicket({title:"Linked synthetic",orderId:order.id,orderNumber:order.orderNumber},actor);
 expect(ticket.orderId).toBe(order.id);expect((await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}})).tenantId).toBe(actor.tenantId);
});
it.each(["foreign-tenant","same-tenant-company","conflicting-number"])("rejects linked %s order before business writes",async kind=>{
 const order=kind==="foreign-tenant"?fixture.orders.find(o=>o.tenantId===ids.tenants.unrelated)!:kind==="same-tenant-company"?fixture.orders.find(o=>o.ownerOrgId===ids.organizations.transAsiaDe)!:fixture.orders.find(o=>o.ownerOrgId===actor.companyId)!;
 const before=await counts();await expect(createSupportTicket({title:"Denied",orderId:order.id,orderNumber:kind==="conflicting-number"?"WRONG":order.orderNumber},actor)).rejects.toMatchObject({statusCode:404});expect(await counts()).toEqual(before);
});
it("wrong recipient and revoked context cause no mutation/events",async()=>{
 const ticket=await create();const before=await counts();
 await expect(assignSupportTicket(ticket.id,randomUUID(),actor)).rejects.toMatchObject({statusCode:400});expect(await counts()).toEqual(before);
 await mockPrisma.companyMembership.update({where:{id:actor.membershipId},data:{status:"suspended"}});
 try{await expect(updateSupportTicketStatus(ticket.id,"resolved",actor)).rejects.toMatchObject({statusCode:403});expect(await counts()).toEqual(before);}finally{await mockPrisma.companyMembership.update({where:{id:actor.membershipId},data:{status:"active"}});}
});
it("message transaction failure rolls back content, ticket state, notification and outbox",async()=>{
 const ticket=await createSupportTicket({title:"Rollback",ownerId:actor.id},actor);const before=await counts();const row=await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}});
 jest.spyOn(mockPrisma,"$transaction").mockImplementationOnce(async(fn:any)=>originalTransaction(async(tx:any)=>{await fn(tx);throw Error("Synthetic transaction failure");}) as any);
 await expect(addSupportTicketMessage(ticket.id,"Must roll back",actor)).rejects.toThrow("Synthetic transaction failure");expect(await counts()).toEqual(before);expect(await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}})).toEqual(row);
});
let originalTransaction:any;
beforeAll(()=>{originalTransaction=mockPrisma.$transaction.bind(mockPrisma);});
it("concurrent requests for one order preserve one live ticket through order locking",async()=>{
 const order=fixture.orders.find(o=>o.ownerOrgId===actor.companyId)!;
 const prior=await mockPrisma.supportTicket.findMany({where:{orderId:order.id,tenantId:actor.tenantId}});
 for(const ticket of prior)await mockPrisma.supportTicket.update({where:{id:ticket.id},data:{status:"resolved",resolvedAt:new Date()}});
 const responses=await Promise.all([createSupportTicket({title:"Concurrent A",orderId:order.id},actor),createSupportTicket({title:"Concurrent B",orderId:order.id},actor)]);
 expect(responses[0].id).toBe(responses[1].id);expect(await mockPrisma.supportTicket.count({where:{orderId:order.id,tenantId:actor.tenantId,status:{not:"resolved"}}})).toBe(1);
});
it("compound constraints reject cross-tenant order/customer/warehouse and wrong assignee bridge",async()=>{
 const other=fixture.orders.find(o=>o.tenantId===ids.tenants.unrelated)!;const before=await counts();
 const base:any={tenantId:actor.tenantId,ownerOrgId:actor.companyId,title:"Invalid"};
 for(const data of [{orderId:other.id},{customerEntityId:other.customerEntityId},{warehouseId:other.currentWarehouseId},{ownerId:ids.users.multiTenant,ownerCompanyMembershipId:actor.membershipId},{ownerId:actor.id},{ownerOrgId:null}]){
  await expect(mockPrisma.supportTicket.create({data:{...base,...data,ticketNumber:`SYNTHETIC-${randomUUID()}`}})).rejects.toThrow();
 }
 expect(await counts()).toEqual(before);
});
it("valid same-tenant separate-company ticket cannot link another company's order or queue",async()=>{
 const de=fixture.orders.find(o=>o.ownerOrgId===ids.organizations.transAsiaDe)!;const ticket=await create();const stored=await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}});
 await expect(mockPrisma.supportTicket.update({where:{id:ticket.id},data:{orderId:de.id}})).rejects.toThrow();
 const queue=await mockPrisma.supportQueue.create({data:{companyId:ids.organizations.transAsiaDe,code:randomUUID(),name:"Synthetic DE queue"}});
 await expect(mockPrisma.supportTicket.update({where:{id:ticket.id},data:{queueId:queue.id}})).rejects.toThrow();expect(await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}})).toEqual(stored);
});
it("SLA service executes only authoritative owned workflow; duplicates and legacy rows do not mutate",async()=>{
 const ticket=await createSupportTicket({title:"SLA",ownerId:actor.id},actor);await mockPrisma.supportTicket.update({where:{id:ticket.id},data:{slaDueAt:new Date(Date.now()-1000)}});
 const legacy=await mockPrisma.supportTicket.create({data:{ticketNumber:`SYNTHETIC-${randomUUID()}`,title:"Legacy SLA",ownerOrgId:actor.companyId,slaDueAt:new Date(Date.now()-1000)}});
 const before=await counts();await Promise.all([maintainOwnedSupportTickets("sla"),maintainOwnedSupportTickets("sla")]);
 expect((await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}})).status).toBe("escalated");expect((await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:legacy.id}})).status).toBe("open");
 const after=await counts();expect(after.events-before.events).toBe(1);expect(after.outbox-before.outbox).toBe(1);expect(after.notifications-before.notifications).toBe(1);
});
it("disabled tenant denies user and maintenance business effects",async()=>{
 const before=await counts();await mockPrisma.tenant.update({where:{id:actor.tenantId},data:{status:"suspended"}});
 try{await expect(create()).rejects.toMatchObject({statusCode:403});expect(await maintainOwnedSupportTickets("sla")).toBe(0);expect(await counts()).toEqual(before);}finally{await mockPrisma.tenant.update({where:{id:actor.tenantId},data:{status:"active"}});}
});

it("retention archives only resolved owned records with transactional history and outbox",async()=>{
 const ticket=await create(); const old=new Date(Date.now()-40*86400000);
 await mockPrisma.supportTicket.update({where:{id:ticket.id},data:{status:"resolved",resolvedAt:old}});
 const legacy=await mockPrisma.supportTicket.create({data:{ticketNumber:`SYNTHETIC-${randomUUID()}`,title:"Legacy retention",ownerOrgId:actor.companyId,status:"resolved",resolvedAt:old}});
 const before=await counts(); await maintainOwnedSupportTickets("archive",30);
 expect((await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:ticket.id}})).archivedAt).not.toBeNull();
 expect((await mockPrisma.supportTicket.findUniqueOrThrow({where:{id:legacy.id}})).archivedAt).toBeNull();
 const after=await counts(); expect(after.events-before.events).toBe(1);expect(after.outbox-before.outbox).toBe(1);expect(after.notifications).toBe(before.notifications);
 const denied=await counts(); await expect(addSupportTicketMessage(ticket.id,"Denied archived",actor)).rejects.toMatchObject({statusCode:409});expect(await counts()).toEqual(denied);
});
it("removing company scope denies another owned ticket and prospective unlinked creation",async()=>{
 const ticket=await create(); const scopes=await mockPrisma.membershipScope.findMany({where:{membershipId:actor.membershipId,scopeType:"company"}});
 await mockPrisma.membershipScope.deleteMany({where:{membershipId:actor.membershipId,scopeType:"company"}});
 try { const before=await counts();expect((await getSupportTicketScoped({actor,id:ticket.id})).payload).toBeNull();
 await expect(addSupportTicketMessage(ticket.id,"Denied scope",actor)).rejects.toMatchObject({statusCode:404});
 await expect(create()).rejects.toMatchObject({statusCode:403});expect(await counts()).toEqual(before);
 }finally{for(const scope of scopes)await mockPrisma.membershipScope.create({data:scope});}
});
