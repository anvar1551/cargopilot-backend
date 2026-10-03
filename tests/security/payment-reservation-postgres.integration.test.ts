import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { createAuthorizedPayment } from "../../src/modules/payments-core/application/payment-creation";

const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url || !run || !/^[a-f0-9]{12}$/.test(run))throw Error("Disposable identity required");
const target=new URL(url);
if(target.hostname!=="127.0.0.1" || target.username!=="cp_worker_it" || target.pathname!==`/cp_worker_${run}`)throw Error("Refusing existing database");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"});
const db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000"})});
const fixture=createTenantDemoFixture(), selected=fixture.companyMemberships.find(m=>m.id===ids.companyMemberships.makerTransAsiaUz)!;
const user:any={id:selected.userId,membershipId:selected.id,companyMembershipId:selected.id,tenantMembershipId:selected.tenantMembershipId,tenantId:selected.tenantId,companyId:selected.companyId};
let config:any;
const oldEnabled=process.env.PAYMENTS_ENABLED,oldEnvironment=process.env.PAYMENTS_ENVIRONMENT;
beforeAll(async()=>{
  const marker=(await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if(marker.length!==1 || marker[0].runId!==run)throw Error("Disposable ownership mismatch");
  const client=await pool.connect();try{await client.query("BEGIN");if(!await db.tenant.findUnique({where:{id:fixture.tenants[0].id}}))await persistTenantDemoFixture(client,fixture);await client.query("COMMIT");}finally{await client.query("ROLLBACK");client.release();}
  const permission=await db.permission.create({data:{key:"payments.intents.create",resource:"synthetic",action:"create"}});
  const role=await db.role.create({data:{companyId:selected.companyId,code:randomUUID(),name:"Synthetic checkout",rolePermissions:{create:{permissionId:permission.id}}}});
  await db.membershipRole.create({data:{membershipId:selected.id,roleId:role.id}});
  await db.membershipScope.create({data:{membershipId:selected.id,scopeType:"company",scopeRefId:selected.companyId}});
  await db.companyPaymentSetting.create({data:{companyId:selected.companyId,defaultProvider:"STRIPE",allowProviderOverride:false}});
  config=await db.paymentProviderConfig.upsert({where:{companyId_provider_environment:{companyId:selected.companyId,provider:"STRIPE",environment:"TEST"}},update:{},create:{companyId:selected.companyId,provider:"STRIPE",environment:"TEST",secretEncrypted:"synthetic",secretMasked:"synthetic",callbackPath:"/synthetic"}});
  process.env.PAYMENTS_ENABLED="true";process.env.PAYMENTS_ENVIRONMENT="TEST";
});
afterAll(async()=>{await db.$disconnect();await pool.end();if(oldEnabled===undefined)delete process.env.PAYMENTS_ENABLED;else process.env.PAYMENTS_ENABLED=oldEnabled;if(oldEnvironment===undefined)delete process.env.PAYMENTS_ENVIRONMENT;else process.env.PAYMENTS_ENVIRONMENT=oldEnvironment;});
async function document(){
  const order=await db.order.create({data:{tenantId:selected.tenantId,ownerOrgId:selected.companyId,orderNumber:randomUUID(),customerId:selected.userId,pickupAddress:"Synthetic",dropoffAddress:"Synthetic",paymentType:"CARD",paymentState:"UNPAID",serviceCharge:0}});
  // Synthetic accepted historical-invoice example only: issuance policy remains contained.
  await db.invoice.create({data:{tenantId:selected.tenantId,companyId:selected.companyId,orderId:order.id,customerId:selected.userId,invoiceNumber:randomUUID(),amount:"1200.25",currency:"USD",status:"issued",issuedAt:new Date("2026-01-01"),issuedByUserId:selected.userId}});
  return order;
}
function dependencies(database:any=db){const createPayment=jest.fn(async()=>({providerPaymentId:"synthetic-"+randomUUID(),checkoutUrl:"https://checkout.example.test/synthetic"}));return{createPayment,deps:{db:database,resolveConfig:async()=>({...config,secretPlain:"sk_test_synthetic_not_real"}),adapter:()=>({createPayment})}as any};}
async function snapshot(){return{intents:await db.paymentIntent.findMany({orderBy:{id:"asc"}}),attempts:await db.paymentAttempt.findMany({orderBy:{id:"asc"}}),ledger:await db.paymentLedgerEntry.findMany({orderBy:{id:"asc"}}),orders:await db.order.findMany({orderBy:{id:"asc"}}),audit:await db.financeAuditEvent.count(),outbox:await db.financeDomainEventOutbox.count(),domain:await db.analyticsDomainEventOutbox.count()};}
it("real concurrent matching reservations create one intent/attempt and one mocked provider operation",async()=>{
  const order=await document(),key=randomUUID(),{deps,createPayment}=dependencies();
  const results=await Promise.all([createAuthorizedPayment({user,input:{orderId:order.id,idempotencyKey:key}},deps),createAuthorizedPayment({user,input:{orderId:order.id,idempotencyKey:key}},deps)]);
  expect(new Set(results.map(r=>r.paymentIntentId)).size).toBe(1);expect(results.filter(r=>r.reused)).toHaveLength(1);expect(createPayment).toHaveBeenCalledTimes(1);
  const intent=await db.paymentIntent.findUniqueOrThrow({where:{id:results[0].paymentIntentId}});expect(intent.amountMinor).toBe(120025n);expect(intent.currency).toBe("USD");
  expect(await db.paymentIntent.count({where:{orderId:order.id}})).toBe(1);expect(await db.paymentAttempt.count({where:{paymentIntentId:intent.id}})).toBe(1);expect(await db.paymentLedgerEntry.count({where:{paymentIntentId:intent.id}})).toBe(0);
});
it("competing different keys for one order produce one result and reject the competitor",async()=>{
  const order=await document(),{deps,createPayment}=dependencies();const results=await Promise.allSettled([randomUUID(),randomUUID()].map(idempotencyKey=>createAuthorizedPayment({user,input:{orderId:order.id,idempotencyKey}},deps)));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((results.find(r=>r.status==="rejected")as PromiseRejectedResult).reason.statusCode).toBe(409);expect(createPayment).toHaveBeenCalledTimes(1);expect(await db.paymentIntent.count({where:{orderId:order.id}})).toBe(1);
});
it("foreign company/null context and current revocation reject without business state/effects",async()=>{
  const order=await document(),{deps,createPayment}=dependencies();let before=await snapshot();
  for(const request of [{user,input:{orderId:ids.orders.transAsiaDe,idempotencyKey:randomUUID()}},{user,input:{orderId:ids.orders.unrelated,idempotencyKey:randomUUID()}},{user:{...user,tenantId:null},input:{orderId:order.id,idempotencyKey:randomUUID()}}])await expect(createAuthorizedPayment(request as any,deps)).rejects.toBeDefined();
  expect(await snapshot()).toEqual(before);expect(createPayment).not.toHaveBeenCalled();
  await db.companyMembership.update({where:{id:selected.id},data:{status:"suspended"}});before=await snapshot();
  try{await expect(createAuthorizedPayment({user,input:{orderId:order.id,idempotencyKey:randomUUID()}},deps)).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);expect(createPayment).not.toHaveBeenCalled();}finally{await db.companyMembership.update({where:{id:selected.id},data:{status:"active"}});}
});
it("injected failure after actual reservation work rolls back before provider dispatch",async()=>{
  const order=await document(),before=await snapshot();const failing=new Proxy(db,{get(target,property){if(property==="$transaction")return(work:any,options:any)=>target.$transaction(async tx=>{await work(tx);throw Error("synthetic-transaction-failure");},options);const value=(target as any)[property];return typeof value==="function"?value.bind(target):value;}});
  const {deps,createPayment}=dependencies(failing);await expect(createAuthorizedPayment({user,input:{orderId:order.id,idempotencyKey:randomUUID()}},deps)).rejects.toThrow("synthetic-transaction-failure");expect(await snapshot()).toEqual(before);expect(createPayment).not.toHaveBeenCalled();
});

it.each(["tenant","invoice","entity","amount","hash","issued","delete"])("accepted reservation %s mutation rejects without any business changes",async kind=>{
 const order=await document(),{deps}=dependencies(),result=await createAuthorizedPayment({user,input:{orderId:order.id,idempotencyKey:randomUUID()}},deps),before=await snapshot();
 const data:any=kind==="tenant"?{reservationTenantId:ids.tenants.unrelated}:kind==="invoice"?{reservationInvoiceId:randomUUID()}:kind==="entity"?{reservationLegalEntityId:fixture.financeLegalEntities[1].id}:kind==="amount"?{amountMinor:1n}:kind==="hash"?{reservationAuthorityHash:"b".repeat(64)}:{reservationIssuedAt:new Date(0)};
 await expect(kind==="delete"?db.paymentIntent.delete({where:{id:result.paymentIntentId}}):db.paymentIntent.update({where:{id:result.paymentIntentId},data})).rejects.toThrow();expect(await snapshot()).toEqual(before);
});
it.each(["partial","tenant","invoice","entity","currency"])("new reservation %s bridge rejects atomically",async kind=>{
 const order=await document(),invoice=await db.invoice.findUniqueOrThrow({where:{orderId:order.id}}),entity=fixture.financeLegalEntities.find(e=>e.companyId===selected.companyId)!;
 const data:any={companyId:selected.companyId,orderId:order.id,provider:"STRIPE",providerConfigId:config.id,environment:"TEST",amountMinor:120025n,currency:"USD",idempotencyKey:randomUUID(),reservationTenantId:selected.tenantId,reservationInvoiceId:invoice.id,reservationLegalEntityId:entity.id,reservationAcceptedAt:new Date(),reservationIssuedAt:invoice.issuedAt,reservationRequestHash:"a".repeat(64),reservationAuthorityHash:"b".repeat(64)};
 if(kind==="partial")data.reservationInvoiceId=null;if(kind==="tenant")data.reservationTenantId=ids.tenants.unrelated;if(kind==="invoice")data.reservationInvoiceId=ids.invoices.transAsiaDe;if(kind==="entity")data.reservationLegalEntityId=fixture.financeLegalEntities[1].id;if(kind==="currency")data.currency="UZS";
 const before=await snapshot();await expect(db.paymentIntent.create({data})).rejects.toThrow();expect(await snapshot()).toEqual(before);
});
it("legacy reservations cannot be adopted or retried and changed intent conflicts without another provider call",async()=>{
 const order=await document(),{deps,createPayment}=dependencies(),key=randomUUID(),legacy=await db.paymentIntent.create({data:{companyId:selected.companyId,orderId:order.id,provider:"STRIPE",providerConfigId:config.id,environment:"TEST",amountMinor:120025n,currency:"USD",idempotencyKey:key}}),before=await snapshot();
 await expect(createAuthorizedPayment({user,input:{orderId:order.id,idempotencyKey:key}},deps)).rejects.toMatchObject({code:"PAYMENT_RECONCILIATION_REQUIRED"});await expect(db.paymentIntent.update({where:{id:legacy.id},data:{reservationAcceptedAt:new Date()}})).rejects.toThrow();expect(await snapshot()).toEqual(before);expect(createPayment).not.toHaveBeenCalled();
 const second=await document(),next=randomUUID();await createAuthorizedPayment({user,input:{orderId:second.id,idempotencyKey:next}},deps);const confirmed=await snapshot();await expect(createAuthorizedPayment({user,input:{orderId:second.id,idempotencyKey:next,metadata:{different:true}}},deps)).rejects.toMatchObject({statusCode:409});expect(await snapshot()).toEqual(confirmed);expect(createPayment).toHaveBeenCalledTimes(1);
});

it("typed reservation catalog binds invoice/currency, order tenant/owner and entity without historical certification",async()=>{
 const rows=(await pool.query(`SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='"PaymentIntent"'::regclass AND conname LIKE 'PaymentReservation_%'`)).rows;
 expect(rows).toHaveLength(4);expect(rows.every(r=>!r.convalidated)).toBe(true);
 const order=rows.find(r=>r.conname==='PaymentReservation_order_fkey');expect(order.definition).toContain('FOREIGN KEY ("reservationTenantId", "orderId", "companyId")');expect(order.definition).toContain('"Order"("tenantId", id, "ownerOrgId")');
});

it("typed order bridge rejects a deliberately simulated uncertified historical order and rolls back the simulation",async()=>{
 const order=await document(),invoice=await db.invoice.findUniqueOrThrow({where:{orderId:order.id}}),entity=fixture.financeLegalEntities.find(e=>e.companyId===selected.companyId)!,before=await snapshot();
 await expect(db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
  // Exclusively owned disposable database: simulate a historical dangling tuple, then restore triggers before the tested insert.
  await tx.$executeRawUnsafe('ALTER TABLE "Order" DISABLE TRIGGER ALL');await tx.order.update({where:{id:order.id},data:{tenantId:null}});await tx.$executeRawUnsafe('ALTER TABLE "Order" ENABLE TRIGGER ALL');
  await tx.paymentIntent.create({data:{companyId:selected.companyId,orderId:order.id,provider:"STRIPE",providerConfigId:config.id,environment:"TEST",amountMinor:120025n,currency:"USD",idempotencyKey:randomUUID(),reservationTenantId:selected.tenantId,reservationInvoiceId:invoice.id,reservationLegalEntityId:entity.id,reservationAcceptedAt:new Date(),reservationIssuedAt:invoice.issuedAt,reservationRequestHash:"a".repeat(64),reservationAuthorityHash:"b".repeat(64)}});
 },{maxWait:2000,timeout:10000})).rejects.toThrow("PaymentReservation_order_fkey");expect(await snapshot()).toEqual(before);
});
