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
  const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,fixture);await client.query("COMMIT");}finally{await client.query("ROLLBACK");client.release();}
  const permission=await db.permission.create({data:{key:"payments.intents.create",resource:"synthetic",action:"create"}});
  const role=await db.role.create({data:{companyId:selected.companyId,code:randomUUID(),name:"Synthetic checkout",rolePermissions:{create:{permissionId:permission.id}}}});
  await db.membershipRole.create({data:{membershipId:selected.id,roleId:role.id}});
  await db.membershipScope.create({data:{membershipId:selected.id,scopeType:"company",scopeRefId:selected.companyId}});
  await db.companyPaymentSetting.create({data:{companyId:selected.companyId,defaultProvider:"STRIPE",allowProviderOverride:false}});
  config=await db.paymentProviderConfig.create({data:{companyId:selected.companyId,provider:"STRIPE",environment:"TEST",secretEncrypted:"synthetic",secretMasked:"synthetic",callbackPath:"/synthetic"}});
  process.env.PAYMENTS_ENABLED="true";process.env.PAYMENTS_ENVIRONMENT="TEST";
});
afterAll(async()=>{await db.$disconnect();await pool.end();if(oldEnabled===undefined)delete process.env.PAYMENTS_ENABLED;else process.env.PAYMENTS_ENABLED=oldEnabled;if(oldEnvironment===undefined)delete process.env.PAYMENTS_ENVIRONMENT;else process.env.PAYMENTS_ENVIRONMENT=oldEnvironment;});
async function document(){
  const order=await db.order.create({data:{tenantId:selected.tenantId,ownerOrgId:selected.companyId,orderNumber:randomUUID(),customerId:selected.userId,pickupAddress:"Synthetic",dropoffAddress:"Synthetic",paymentType:"CARD",paymentState:"UNPAID"}});
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
