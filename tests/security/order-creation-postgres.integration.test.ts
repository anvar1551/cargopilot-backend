jest.mock("../../src/modules/live-map-core/infrastructure/liveMapStore",()=>({publishLiveMapEvent:jest.fn(),readDriverLocation:jest.fn(),readDriverIdsInViewport:jest.fn(),readDriverLocations:jest.fn(),readDriverLocationsInViewport:jest.fn(),readDriverPresences:jest.fn(),touchDriverPresenceHeartbeat:jest.fn(),upsertDriverLocation:jest.fn(),upsertDriverPresence:jest.fn()}));
import {getLiveMapSnapshot} from "../../src/modules/live-map-core/application/liveMapService";
jest.mock("../../src/config/prismaClient",()=>({__esModule:true,default:new Proxy({}, {get:(_t,name)=>{const value=(mockPrisma as any)[name];return typeof value==="function"?value.bind(mockPrisma):value;}})}));
jest.mock("../../src/modules/orders-core/cash",()=>({buildInitialOrderCashCollections:jest.requireActual("../../src/modules/orders-core/cash/collection.shared").buildInitialOrderCashCollections}));
jest.mock("../../src/modules/orders-core/sla",()=>({resolveOrderSlaSnapshot:jest.fn(async()=>({}))}));
jest.mock("../../src/modules/pricing-core",()=>({quoteTariffForOrder:jest.fn(async()=>({quoteAvailable:false,reason:"no_rule"}))}));
jest.mock("../../src/modules/orders-legs",()=>({seedInitialServiceChargePricing:jest.fn(async()=>undefined),autoBookCarrierForOrder:jest.fn(async()=>[])}));
jest.mock("../../src/modules/orders-core/label",()=>({enqueueOrderLabelJob:jest.fn(async()=>undefined),generateAndAttachParcelLabelsForOrder:jest.fn(async()=>undefined),isOrderLabelAutoFallbackEnabled:()=>false,resolveOrderLabelMode:()=>"queue",scheduleOrderLabelAutoFallback:jest.fn(),runOrderLabelAutoFallback:jest.fn()}));
jest.mock("../../src/modules/support-core/application/autoTriage",()=>({createSystemSupportTicket:jest.fn(async()=>undefined),createLabelFailureSupportTicket:jest.fn(async()=>undefined)}));
import {Pool} from "pg";
import {PrismaClient} from "@prisma/client";
import {PrismaPg} from "@prisma/adapter-pg";
import {randomUUID} from "crypto";
import {createTenantDemoFixture,TENANT_DEMO_IDS as ids} from "../../src/modules/tenancy/demo-fixtures";
import {persistTenantDemoFixture} from "../tenancy/postgres-fixture.persistence";
import {createOrderForActor} from "../../src/modules/orders-core/write/create-order";
import {importOrdersFromCsv,getOrderImportTemplateCsv} from "../../src/modules/orders-core/import/order-import";
import {enqueueOrderLabelJob} from "../../src/modules/orders-core/label";
import {seedInitialServiceChargePricing,autoBookCarrierForOrder} from "../../src/modules/orders-legs";
import {quoteTariffForOrder} from "../../src/modules/pricing-core";
import {buildCreationRequest} from "../../src/modules/orders-core/domain/creation-request";
import {mapCreateOrderDtoToRepoPayload} from "../../src/modules/orders-core/domain/orderCreate.mapper";
import {getOrderCreationRetry,createOrder} from "../../src/modules/orders-core/repo/order-write.repo";
const url=process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL,run=process.env.CARGOPILOT_WORKER_RUN_ID;
if(!url||!run||!/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable run required");
const target=new URL(url);
if(target.hostname!=="127.0.0.1"||target.username!=="cp_worker_it"||target.pathname!==`/cp_worker_${run}`)throw Error("Refusing existing database");
const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000"});
let mockPrisma:PrismaClient;
const fixture=createTenantDemoFixture();
const memberships=fixture.companyMemberships.filter(m=>m.userId===ids.users.multiTenant);
const actor=(m=memberships[0]):any=>({...m,id:m.userId,membershipId:m.id,companyMembershipId:m.id});
const body=(operationId=randomUUID()):any=>({operationId,sender:{name:"Synthetic sender"},receiver:{name:"Synthetic receiver"},addresses:{pickupAddress:"Synthetic pickup",dropoffAddress:"Synthetic dropoff",senderAddress:{city:"Bremen"},receiverAddress:{city:"Hamburg"}},shipment:{serviceType:"DOOR_TO_DOOR",codEnabled:true,codAmount:100,currency:"UZS",weightKg:1},payment:{paymentType:"CASH"}});
const roles:string[]=[];
async function state(){
  return {intents:await mockPrisma.orderCreationIntent.count(),receipts:await mockPrisma.orderCreationReceipt.count(),orders:await mockPrisma.order.count(),parcels:await mockPrisma.parcel.count(),cash:await mockPrisma.cashCollection.count(),cashEvents:await mockPrisma.cashCollectionEvent.count(),tracking:await mockPrisma.tracking.count(),outbox:await mockPrisma.analyticsDomainEventOutbox.count(),finance:await mockPrisma.financeJournalEntry.count(),counter:(await mockPrisma.counter.findUnique({where:{key:"orderNumber"}}))?.value??null};
}
beforeAll(async()=>{
  const marker=(await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if(marker.length!==1||marker[0].runId!==run)throw Error("Disposable ownership mismatch");
  const client=await pool.connect();try{await client.query("BEGIN");await persistTenantDemoFixture(client,fixture);await client.query("COMMIT");}finally{await client.query("ROLLBACK");client.release();}
  mockPrisma=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4,connectionTimeoutMillis:3000,options:"-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000"})});
  const permission=await mockPrisma.permission.create({data:{key:"shipment.create",resource:"synthetic-order",action:"create"}});
  const viewPermission=await mockPrisma.permission.create({data:{key:"shipment.view",resource:"synthetic-order",action:"view"}});
  for(const m of memberships){const role=await mockPrisma.role.create({data:{code:randomUUID(),name:"Synthetic creator",companyId:m.companyId}});roles.push(role.id);await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:viewPermission.id}});await mockPrisma.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});await mockPrisma.membershipRole.create({data:{membershipId:m.id,roleId:role.id}});await mockPrisma.membershipScope.create({data:{membershipId:m.id,scopeType:"company",scopeRefId:m.companyId}});}
  process.env.ORDER_LABEL_BLOCKING="true";
});
afterAll(async()=>{delete process.env.ORDER_LABEL_BLOCKING;await mockPrisma?.$disconnect();await pool.end();});
beforeEach(()=>{jest.clearAllMocks();(enqueueOrderLabelJob as jest.Mock).mockReset().mockResolvedValue(undefined);(quoteTariffForOrder as jest.Mock).mockReset().mockResolvedValue({quoteAvailable:false,reason:"no_rule"});});
it("four concurrent identical requests commit one order, receipt, cash obligation and event",async()=>{
  const before=await state(),input=body();const results=await Promise.all(Array.from({length:4},()=>createOrderForActor({user:actor(),body:input})));
  expect(new Set(results.map(r=>r.payload.order.id)).size).toBe(1);
  const after=await state();expect(after).toMatchObject({intents:before.intents+1,receipts:before.receipts+1,orders:before.orders+1,parcels:before.parcels+1,cash:before.cash+1,cashEvents:before.cashEvents+1,tracking:before.tracking+1,outbox:before.outbox+1,finance:before.finance,counter:(before.counter??0)+1});
  const cash=await mockPrisma.cashCollection.findFirstOrThrow({where:{orderId:results[0].payload.order.id}});expect(cash.expectedAmount).toBe(100);expect(cash.collectedAmount).toBeNull();expect(cash.status).toBe("expected");expect(cash.currentHolderType).toBe("none");
  expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);expect(seedInitialServiceChargePricing).toHaveBeenCalledTimes(1);expect(autoBookCarrierForOrder).toHaveBeenCalledTimes(1);
});
it("concurrent conflicting reuse admits one intent and rejects the other",async()=>{
  const before=await state(),input=body();const results=await Promise.allSettled([createOrderForActor({user:actor(),body:input}),createOrderForActor({user:actor(),body:{...input,pickupAddress:undefined,addresses:{...input.addresses,pickupAddress:"Changed synthetic pickup"}}})]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason).toMatchObject({statusCode:409});
  const after=await state();expect(after.orders).toBe(before.orders+1);expect(after.receipts).toBe(before.receipts+1);expect(after.outbox).toBe(before.outbox+1);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);
});
it("receipt insertion failure rolls back order, cash, numbering and analytics outbox",async()=>{
  const input=body(),before=await state();
  await pool.query(`CREATE FUNCTION cp_test_creation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM "OrderCreationIntent" WHERE id=NEW."intentId" AND "operationId"='${input.operationId}') THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF;RETURN NEW;END $$; CREATE TRIGGER cp_test_creation_failure BEFORE INSERT ON "OrderCreationReceipt" FOR EACH ROW EXECUTE FUNCTION cp_test_creation_failure();`);
  try{await expect(createOrderForActor({user:actor(),body:input})).rejects.toThrow("synthetic receipt failure");expect(await state()).toEqual(before);expect(enqueueOrderLabelJob).not.toHaveBeenCalled();expect(seedInitialServiceChargePricing).not.toHaveBeenCalled();expect(autoBookCarrierForOrder).not.toHaveBeenCalled();}
  finally{await pool.query('DROP TRIGGER cp_test_creation_failure ON "OrderCreationReceipt"; DROP FUNCTION cp_test_creation_failure();');}
});
it("partial import survives rebuilt request and never repeats the uncertain completed row effects",async()=>{
  const sample=getOrderImportTemplateCsv().trim();const args={actor:actor(),operationId:randomUUID(),csvText:sample+"\n"+sample.split("\n")[1]};const before=await state();
  (enqueueOrderLabelJob as jest.Mock).mockRejectedValueOnce(new Error("Synthetic uncertain queue outcome"));
  await expect(importOrdersFromCsv(args)).rejects.toThrow("Synthetic uncertain queue outcome");expect((await state()).orders).toBe(before.orders+1);
  const restored=JSON.parse(JSON.stringify(args));const result=await importOrdersFromCsv(restored);expect(result).toMatchObject({count:2,replayedRows:1,downstreamRecoveryRequired:true});
  expect((await state()).orders).toBe(before.orders+2);expect((await state()).receipts).toBe(before.receipts+2);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(2);expect(seedInitialServiceChargePricing).toHaveBeenCalledTimes(2);
  const confirmed=await state();const pricingCalls=(quoteTariffForOrder as jest.Mock).mock.calls.length;await expect(importOrdersFromCsv(restored)).resolves.toMatchObject({count:2,replayedRows:2});expect(await state()).toEqual(confirmed);expect(quoteTariffForOrder).toHaveBeenCalledTimes(pricingCalls);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(2);
});
it("concurrent import confirmations create each ordinal once",async()=>{
  const sample=getOrderImportTemplateCsv().trim();const args={actor:actor(),operationId:randomUUID(),csvText:sample+"\n"+sample.split("\n")[1]};const before=await state();
  const results=await Promise.all([importOrdersFromCsv(args),importOrdersFromCsv(args)]);expect(results.map(r=>r.orders.map(o=>o.id))).toEqual([results[0].orders.map(o=>o.id),results[0].orders.map(o=>o.id)]);
  const after=await state();expect(after.orders).toBe(before.orders+2);expect(after.receipts).toBe(before.receipts+2);expect(after.outbox).toBe(before.outbox+2);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(2);expect(seedInitialServiceChargePricing).toHaveBeenCalledTimes(2);
});
it("changed later row conflicts with the accepted batch after partial success",async()=>{
  const sample=getOrderImportTemplateCsv().trim(),row=sample.split("\n")[1];const args={actor:actor(),operationId:randomUUID(),csvText:sample+"\n"+row};(enqueueOrderLabelJob as jest.Mock).mockRejectedValueOnce(new Error("Synthetic interrupted import"));await expect(importOrdersFromCsv(args)).rejects.toThrow();const before=await state();
  await expect(importOrdersFromCsv({...args,csvText:sample+"\n"+row.replace("Alex Morgan","Changed receiver")})).rejects.toMatchObject({statusCode:409});expect(await state()).toEqual(before);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);
});
it("fresh revoked membership and removed scope deny existing receipts without effects",async()=>{
  const input=body();await createOrderForActor({user:actor(),body:input});const before=await state();
  await mockPrisma.companyMembership.update({where:{id:memberships[0].id},data:{status:"suspended"}});
  try{await expect(createOrderForActor({user:actor(),body:input})).rejects.toMatchObject({statusCode:403});expect(await state()).toEqual(before);}finally{await mockPrisma.companyMembership.update({where:{id:memberships[0].id},data:{status:"active"}});}
  const scope=await mockPrisma.membershipScope.findFirstOrThrow({where:{membershipId:memberships[0].id}});await mockPrisma.membershipScope.delete({where:{id:scope.id}});
  try{await expect(createOrderForActor({user:actor(),body:input})).rejects.toMatchObject({statusCode:403});expect(await state()).toEqual(before);}finally{await mockPrisma.membershipScope.create({data:scope});}
  expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);
});
it("same-tenant foreign selected company and direct foreign request context cannot return receipts",async()=>{
  const input=body();await createOrderForActor({user:actor(),body:input});const before=await state();const other=memberships.find(m=>m.tenantId===memberships[0].tenantId&&m.companyId!==memberships[0].companyId)!;
  await expect(createOrderForActor({user:actor(other),body:input})).rejects.toMatchObject({statusCode:409});
  const request=buildCreationRequest(actor(),input.operationId,"order",[await mapCreateOrderDtoToRepoPayload(input)]);
  await expect(getOrderCreationRetry(actor(memberships.find(m=>m.tenantId!==memberships[0].tenantId)!),request)).rejects.toMatchObject({statusCode:409});expect(await state()).toEqual(before);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);
});
it("compound database ownership rejects wrong membership/user and foreign order receipts",async()=>{
  const m=memberships[0],before=await state();const data={tenantId:m.tenantId,companyId:m.companyId,userId:m.userId,tenantMembershipId:m.tenantMembershipId,companyMembershipId:m.id,operationId:randomUUID(),kind:"import",fingerprint:"a".repeat(64),rowCount:1};
  await expect(mockPrisma.orderCreationIntent.create({data:{...data,userId:ids.users.maker}})).rejects.toThrow();expect(await state()).toEqual(before);
  const header=await mockPrisma.orderCreationIntent.create({data});const accepted=await state();
  for(const order of fixture.orders.filter(o=>o.ownerOrgId!==m.companyId))await expect(mockPrisma.orderCreationReceipt.create({data:{intentId:header.id,ordinal:0,tenantId:m.tenantId,companyId:m.companyId,orderId:order.id}})).rejects.toThrow();
  expect(await state()).toEqual(accepted);
});
it("immutable identity/receipts and normal confirmation constraints cannot be bypassed by updates or incomplete commit",async()=>{
  const input=body();const created=await createOrderForActor({user:actor(),body:input});const header=await mockPrisma.orderCreationIntent.findUniqueOrThrow({where:{tenantId_operationId:{tenantId:actor().tenantId,operationId:input.operationId}}});const before=await state();
  await expect(mockPrisma.orderCreationIntent.update({where:{id:header.id},data:{fingerprint:"b".repeat(64)}})).rejects.toThrow();await expect(mockPrisma.orderCreationReceipt.delete({where:{intentId_ordinal:{intentId:header.id,ordinal:0}}})).rejects.toThrow();
  await expect(mockPrisma.orderCreationReceipt.update({where:{intentId_ordinal:{intentId:header.id,ordinal:0}},data:{orderId:fixture.orders[0].id}})).rejects.toThrow();
  await expect(mockPrisma.orderCreationIntent.create({data:{tenantId:actor().tenantId,companyId:actor().companyId,userId:actor().id,tenantMembershipId:actor().tenantMembershipId,companyMembershipId:actor().companyMembershipId,operationId:randomUUID(),kind:"order",fingerprint:"a".repeat(64),rowCount:1}})).rejects.toThrow("Normal creation must confirm atomically");
  await expect(mockPrisma.orderCreationReceipt.create({data:{intentId:header.id,ordinal:1,tenantId:actor().tenantId,companyId:actor().companyId,orderId:created.payload.order.id}})).rejects.toThrow();expect(await state()).toEqual(before);
});


it("equivalent date encodings and normalized UUID case return the same authorized order",async()=>{
  const input=body();input.schedule={plannedPickupAt:"2026-10-03T12:00:00Z"};const result=await createOrderForActor({user:actor(),body:input});const before=await state();
  await expect(createOrderForActor({user:actor(),body:{...input,operationId:input.operationId.toUpperCase(),schedule:{plannedPickupAt:"2026-10-03T12:00:00.000Z"}}})).resolves.toMatchObject({payload:{creationReplay:true,order:{id:result.payload.order.id}}});
  expect(await state()).toEqual(before);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);
});


it("alternate repository payload cannot change a normalized accepted row before writes",async()=>{
  const input=body(),mapped=await mapCreateOrderDtoToRepoPayload(input),request=buildCreationRequest(actor(),input.operationId,"order",[mapped]);const before=await state();
  await expect(createOrder(actor().id,{...mapped,dropoffAddress:"Changed after intent"},actor(),request)).rejects.toMatchObject({statusCode:409});expect(await state()).toEqual(before);expect(enqueueOrderLabelJob).not.toHaveBeenCalled();
});
it("failed second import transaction preserves the first receipt and resumes only the missing ordinal",async()=>{
  const sample=getOrderImportTemplateCsv().trim(),args={actor:actor(),operationId:randomUUID(),csvText:sample+"\n"+sample.split("\n")[1]},before=await state();
  await pool.query(`CREATE FUNCTION cp_test_import_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ordinal=1 AND EXISTS(SELECT 1 FROM "OrderCreationIntent" WHERE id=NEW."intentId" AND "operationId"='${args.operationId}') THEN RAISE EXCEPTION 'synthetic second row failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_test_import_failure BEFORE INSERT ON "OrderCreationReceipt" FOR EACH ROW EXECUTE FUNCTION cp_test_import_failure();`);
  try{await expect(importOrdersFromCsv(args)).rejects.toThrow("synthetic second row failure");const after=await state();expect(after.orders).toBe(before.orders+1);expect(after.receipts).toBe(before.receipts+1);expect(after.outbox).toBe(before.outbox+1);expect(after.counter).toBe((before.counter??0)+1);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);}
  finally{await pool.query('DROP TRIGGER cp_test_import_failure ON "OrderCreationReceipt"; DROP FUNCTION cp_test_import_failure();');}
  const result=await importOrdersFromCsv(args);expect(result).toMatchObject({count:2,replayedRows:1});const after=await state();expect(after.orders).toBe(before.orders+2);expect(after.receipts).toBe(before.receipts+2);expect(after.outbox).toBe(before.outbox+2);expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(2);expect(seedInitialServiceChargePricing).toHaveBeenCalledTimes(2);
});


it("live-map PostgreSQL selected markers isolate companies/tenants and hide legacy tenant-null rows",async()=>{
  await mockPrisma.order.create({data:{orderNumber:"synthetic-legacy-"+randomUUID(),customerId:memberships[0].userId,ownerOrgId:memberships[0].companyId,pickupAddress:"Synthetic legacy",dropoffAddress:"Synthetic legacy",status:"pending"}});
  const before=await state();
  for(const m of memberships){const snapshot=await getLiveMapSnapshot({actor:actor(m)});const expected=fixture.orders.filter(order=>order.tenantId===m.tenantId&&order.ownerOrgId===m.companyId).map(order=>order.id).sort();expect(snapshot.orders.map(order=>order.id).sort()).toEqual(expected);expect(snapshot).toMatchObject({drivers:[],warehouses:[],isPartial:true});expect(snapshot.orders.every(order=>order.assignedDriverId===null&&order.warehouseId===null&&order.region===null)).toBe(true);}
  expect(await state()).toEqual(before);
});
it("live-map PostgreSQL fresh permission removal denies the next read without changing business state",async()=>{
  await getLiveMapSnapshot({actor:actor()});const grant=await mockPrisma.rolePermission.findFirstOrThrow({where:{roleId:roles[0],permission:{key:"shipment.view"}}});const before=await state();await mockPrisma.rolePermission.delete({where:{id:grant.id}});
  try{await expect(getLiveMapSnapshot({actor:actor()})).rejects.toMatchObject({statusCode:403});expect(await state()).toEqual(before);}finally{await mockPrisma.rolePermission.create({data:grant});}
});
