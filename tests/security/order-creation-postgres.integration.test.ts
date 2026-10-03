jest.mock("../../src/modules/live-map-core/infrastructure/liveMapStore",()=>({publishLiveMapEvent:jest.fn(),readDriverLocation:jest.fn(),readDriverIdsInViewport:jest.fn(),readDriverLocations:jest.fn(),readDriverLocationsInViewport:jest.fn(),readDriverPresences:jest.fn(),touchDriverPresenceHeartbeat:jest.fn(),upsertDriverLocation:jest.fn(),upsertDriverPresence:jest.fn()}));
import {getLiveMapSnapshot} from "../../src/modules/live-map-core/application/liveMapService";
jest.mock("../../src/modules/live-map-core/infrastructure/selectedTelemetryStore",()=>({readSelectedPresence:jest.fn(async()=>null),readSelectedTelemetry:jest.fn(async()=>null),writeSelectedPresence:jest.fn(),writeSelectedTelemetry:jest.fn()}));
import {getDriverPresence} from "../../src/modules/live-map-core/application/selectedDriverTelemetry";
import {readSelectedPresence,readSelectedTelemetry} from "../../src/modules/live-map-core/infrastructure/selectedTelemetryStore";
import {listDriversView,updateDriverProfileById} from "../../src/modules/driver-core/application/driverProfileService";
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
import {importOrdersFromCsv,getOrderImportTemplateCsv,previewOrderImport} from "../../src/modules/orders-core/import/order-import";
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
  for(const key of ["drivers.telemetry","drivers.manage","customers.read"]){const p=await mockPrisma.permission.create({data:{key,resource:"synthetic-driver",action:key.split(".")[1]}});for(const roleId of roles)await mockPrisma.rolePermission.create({data:{roleId,permissionId:p.id}});}
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


it("driver ownership PostgreSQL selected directory excludes global classification and foreign company cursors",async()=>{
  const unrelated=fixture.users.find(user=>user.id!==ids.users.multiTenant)!;
  await mockPrisma.user.update({where:{id:unrelated.id},data:{driverType:"local"}});
  const before=await state();
  for(const m of memberships){const result=await listDriversView(actor(m));expect(result).toHaveLength(1);expect(result[0]).toMatchObject({id:m.userId,companyMembershipId:m.id,driverType:null,warehouseId:null,warehouseIds:[],isPartial:true});expect(result[0]).not.toHaveProperty("tenantMembership");const c={userId:m.userId,tenantId:m.tenantId,tenantMembershipId:m.tenantMembershipId,companyId:m.companyId,companyMembershipId:m.id};await expect(getDriverPresence({actor:actor(m),query:{context:c}})).resolves.toMatchObject({ok:true,presence:{enabled:false}});expect(readSelectedPresence).toHaveBeenLastCalledWith(c);}
  await expect(listDriversView(actor(),{cursor:memberships[1].id})).rejects.toMatchObject({statusCode:404});
  await expect(listDriversView(actor(),{cursor:memberships[2].id})).rejects.toMatchObject({statusCode:404});
  expect(await listDriversView(actor(),{cursor:memberships[0].id,limit:1})).toEqual([]);expect(await state()).toEqual(before);
});
it("driver ownership PostgreSQL foreign-role, suspended context and global profile mutations have zero business effects",async()=>{
  const telemetry=await mockPrisma.permission.findUniqueOrThrow({where:{key:"drivers.telemetry"}});
  const ownGrant=await mockPrisma.rolePermission.findFirstOrThrow({where:{roleId:roles[0],permissionId:telemetry.id}});
  const foreignGrant=await mockPrisma.membershipRole.create({data:{membershipId:memberships[0].id,roleId:roles[1]}});
  await mockPrisma.rolePermission.delete({where:{id:ownGrant.id}});
  const c={userId:actor().id,tenantId:actor().tenantId,tenantMembershipId:actor().tenantMembershipId,companyId:actor().companyId,companyMembershipId:actor().companyMembershipId};
  const before=await state();const userBefore=await mockPrisma.user.findUniqueOrThrow({where:{id:actor().id},select:{driverType:true,warehouseId:true,liveLocationEnabled:true}});
  try{await expect(getDriverPresence({actor:actor(),query:{context:c}})).rejects.toMatchObject({statusCode:403});expect(readSelectedPresence).not.toHaveBeenCalled();expect(readSelectedTelemetry).not.toHaveBeenCalled();expect(await listDriversView(actor())).toEqual([]);await expect(updateDriverProfileById(actor().id,{driverType:"linehaul"},actor())).rejects.toMatchObject({statusCode:409});expect(await mockPrisma.user.findUniqueOrThrow({where:{id:actor().id},select:{driverType:true,warehouseId:true,liveLocationEnabled:true}})).toEqual(userBefore);expect(await state()).toEqual(before);}
  finally{await mockPrisma.rolePermission.create({data:ownGrant});await mockPrisma.membershipRole.delete({where:{id:foreignGrant.id}});}
  await mockPrisma.companyMembership.update({where:{id:memberships[0].id},data:{status:"suspended"}});
  try{await expect(listDriversView(actor())).rejects.toMatchObject({statusCode:403});await expect(getDriverPresence({actor:actor(),query:{context:c}})).rejects.toMatchObject({statusCode:403});expect(readSelectedPresence).not.toHaveBeenCalled();expect(await state()).toEqual(before);}
  finally{await mockPrisma.companyMembership.update({where:{id:memberships[0].id},data:{status:"active"}});}
});
import { getAnalyticsSummaryV2, getAnalyticsTrendV2, getAnalyticsWarningsV2, getAnalyticsFinanceQueueV2 } from "../../src/modules/analytics-core/application/analyticsV2";
import { freshAnalyticsRead } from "../../src/modules/analytics-core/application/analyticsScope";
let analyticsPrepared = false;
async function prepareAnalyticsFixtures() {
  if (analyticsPrepared) return;
  for (const order of fixture.orders) {
    await mockPrisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(), expectedDeliveryAt: new Date(Date.now() - 86400000), serviceCharge: 40, serviceChargePaidStatus: "NOT_PAID", codAmount: 60, codPaidStatus: "NOT_PAID" } });
    await mockPrisma.cashCollection.create({ data: { orderId: order.id, kind: "cod", expectedAmount: 60, currency: "USD", currentHolderLabel: "Unproven synthetic global holder" } });
  }
  for (const invoice of fixture.invoices) await mockPrisma.invoice.update({ where: { id: invoice.id }, data: { createdAt: new Date() } });
  await mockPrisma.order.create({ data: { orderNumber: "analytics-legacy-" + run, customerId: actor().id, ownerOrgId: actor().companyId, pickupAddress: "Synthetic legacy", dropoffAddress: "Synthetic legacy" } });
  analyticsPrepared = true;
}
it("analytics ownership PostgreSQL actual summary/trend/warning/queue predicates isolate selected companies and tenants", async () => {
  await prepareAnalyticsFixtures(); const before = await state();
  for (const m of memberships) {
    const owned = fixture.orders.find(order => order.ownerOrgId === m.companyId)!;
    const summary = await getAnalyticsSummaryV2({ actor: actor(m) }); expect(summary.cacheHit).toBe(false); expect(summary.payload.overview.totalOrders).toBe(1); expect(summary.payload.finance).toMatchObject({ invoiceAccess: "unavailable", invoicedPaidAmount: null });
    const trend = await getAnalyticsTrendV2({ actor: actor(m) }); expect(trend.payload.trend.created.reduce((sum, row) => sum + row.count, 0)).toBe(1);
    const warnings = await getAnalyticsWarningsV2({ actor: actor(m) }); expect(warnings.payload.overdueTotal).toBe(1); expect(warnings.payload.financeExposureTotal).toBe(1); expect(warnings.payload.overdueOrders.map(order => order.id)).toEqual([owned.id]); expect(warnings.payload.financeExposureOrders.map(order => order.id)).toEqual([owned.id]);
    const queue = await getAnalyticsFinanceQueueV2({ actor: actor(m) }); expect(queue.payload.queueMeta.total).toBe(1); expect(queue.payload.queue.map(row => row.orderId)).toEqual([owned.id]); expect(queue.payload.queue[0].holderLabel).toBeNull();
  }
  expect(await state()).toEqual(before); expect(enqueueOrderLabelJob).not.toHaveBeenCalled(); expect(autoBookCarrierForOrder).not.toHaveBeenCalled();
});
it("analytics ownership PostgreSQL explicit warehouse scope cannot become company default or global User binding", async () => {
  await prepareAnalyticsFixtures(); const own = memberships[0], scope = await mockPrisma.membershipScope.findFirstOrThrow({ where: { membershipId: own.id } });
  await mockPrisma.membershipScope.update({ where: { id: scope.id }, data: { scopeType: "warehouse", scopeRefId: ids.warehouses.transAsiaDe } });
  const before = await state();
  try {
    const warnings = await getAnalyticsWarningsV2({ actor: actor() }); expect(warnings.payload.overdueOrders.map(order => order.id)).toEqual([ids.orders.transAsiaDe]);
    expect((await getAnalyticsSummaryV2({ actor: actor() })).payload.overview.totalOrders).toBe(1);
    // Company-specific custody remains outside this actor's selected financial company.
    expect((await getAnalyticsFinanceQueueV2({ actor: actor() })).payload.queueMeta.total).toBe(0);
    await mockPrisma.membershipScope.delete({ where: { id: scope.id } });
    for (const read of [getAnalyticsSummaryV2, getAnalyticsTrendV2, getAnalyticsWarningsV2, getAnalyticsFinanceQueueV2]) await expect(read({ actor: actor() })).rejects.toMatchObject({ statusCode: 403 });
    expect(await state()).toEqual(before);
  } finally { await mockPrisma.membershipScope.upsert({ where: { id: scope.id }, create: scope, update: { scopeType: scope.scopeType, scopeRefId: scope.scopeRefId } }); }
});
it("analytics ownership PostgreSQL invoice permission and legal-company ownership are distinct from order visibility", async () => {
  await prepareAnalyticsFixtures();
  const permission = await mockPrisma.permission.create({ data: { key: "finance.invoices.read", resource: "synthetic-invoice", action: "read" } });
  for (const roleId of roles) await mockPrisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
  const before = await state();
  for (const m of memberships) { const summary = await getAnalyticsSummaryV2({ actor: actor(m) }); expect(summary.payload.finance).toMatchObject({ invoiceAccess: "available", pendingInvoicesCount: 1 }); }
  const scope = await mockPrisma.membershipScope.findFirstOrThrow({ where: { membershipId: memberships[0].id } });
  await mockPrisma.membershipScope.update({ where: { id: scope.id }, data: { scopeType: "warehouse", scopeRefId: ids.warehouses.transAsiaDe } });
  try { const summary = await getAnalyticsSummaryV2({ actor: actor() }); expect(summary.payload.overview.totalOrders).toBe(1); expect(summary.payload.finance.pendingInvoicesCount).toBe(0); } finally { await mockPrisma.membershipScope.update({ where: { id: scope.id }, data: { scopeType: scope.scopeType, scopeRefId: scope.scopeRefId } }); }
  expect(await state()).toEqual(before);
});
it("analytics ownership PostgreSQL fresh revocation and readonly snapshots leave protected records/outbox unchanged", async () => {
  await prepareAnalyticsFixtures(); const before = await state(), rowBefore = await mockPrisma.order.findUniqueOrThrow({ where: { id: ids.orders.transAsiaUz } });
  await expect(freshAnalyticsRead(tx => tx.order.update({ where: { id: rowBefore.id }, data: { pickupAddress: "Forbidden readonly mutation" } }))).rejects.toThrow();
  expect(await mockPrisma.order.findUniqueOrThrow({ where: { id: rowBefore.id } })).toEqual(rowBefore);
  const grant = await mockPrisma.rolePermission.findFirstOrThrow({ where: { roleId: roles[0], permission: { key: "shipment.view" } } });
  await mockPrisma.rolePermission.delete({ where: { id: grant.id } });
  try { for (const read of [getAnalyticsSummaryV2, getAnalyticsTrendV2, getAnalyticsWarningsV2, getAnalyticsFinanceQueueV2]) await expect(read({ actor: actor() })).rejects.toMatchObject({ statusCode: 403 }); }
  finally { await mockPrisma.rolePermission.create({ data: grant }); }
  await mockPrisma.tenant.update({ where: { id: actor().tenantId }, data: { status: "suspended" } });
  try { await expect(getAnalyticsSummaryV2({ actor: actor() })).rejects.toMatchObject({ statusCode: 403 }); } finally { await mockPrisma.tenant.update({ where: { id: actor().tenantId }, data: { status: "active" } }); }
  expect(await state()).toEqual(before); expect(enqueueOrderLabelJob).not.toHaveBeenCalled(); expect(autoBookCarrierForOrder).not.toHaveBeenCalled();
});

async function masterState() {
  return { ...await state(), orderRows: await mockPrisma.order.findMany({orderBy:{id:"asc"}}), customerRows: await mockPrisma.customerEntity.findMany({orderBy:{id:"asc"}}), addressRows: await mockPrisma.address.findMany({orderBy:{id:"asc"}}) };
}
const masterBody=()=>({...body(),customerEntityId:ids.customers.transAsia,addresses:{...body().addresses,senderAddressId:ids.addresses.transAsiaSender,receiverAddressId:ids.addresses.transAsiaReceiver}});
it("master references native owned creation and concurrent normalized retry preserve one authorized projection",async()=>{
const input=masterBody(),before=await masterState();const results=await Promise.all([input,{...input,customerEntityId:input.customerEntityId.toUpperCase(),addresses:{...input.addresses,senderAddressId:input.addresses.senderAddressId.toUpperCase()}}].map(body=>createOrderForActor({user:actor(),body})));
expect(new Set(results.map(r=>r.payload.order.id)).size).toBe(1);const order=results[0].payload.order;
expect(order).toMatchObject({tenantId:actor().tenantId,ownerOrgId:actor().companyId,customerEntityId:input.customerEntityId,senderAddressId:input.addresses.senderAddressId,receiverAddressId:input.addresses.receiverAddressId});
expect(order.senderAddressObj).not.toHaveProperty("passportNumber");expect(order.senderAddressObj).not.toHaveProperty("passportSeries");expect(await masterState()).toMatchObject({orders:before.orders+1,receipts:before.receipts+1,outbox:before.outbox+1});expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);
});
it.each(["foreign customer","foreign address","wrong customer","missing customer","legacy customer"])("master references native %s rejects before business and downstream effects",async condition=>{
const input=masterBody();if(condition==="foreign customer")input.customerEntityId=ids.customers.unrelated;
if(condition==="foreign address")input.addresses.senderAddressId=ids.addresses.unrelatedSender;
if(condition==="wrong customer"){const customer=await mockPrisma.customerEntity.create({data:{tenantId:actor().tenantId,name:"Synthetic other"}});const address=await mockPrisma.address.create({data:{tenantId:actor().tenantId,customerEntityId:customer.id,addressLine1:"Synthetic"}});input.addresses.senderAddressId=address.id;}
if(condition==="missing customer")input.customerEntityId=null;
if(condition==="legacy customer"){const customer=await mockPrisma.customerEntity.create({data:{name:"Synthetic legacy",tenantId:null}});input.customerEntityId=customer.id;}
const before=await masterState();await expect(createOrderForActor({user:actor(),body:input})).rejects.toMatchObject({statusCode:403});expect(await masterState()).toEqual(before);expect(enqueueOrderLabelJob).not.toHaveBeenCalled();expect(seedInitialServiceChargePricing).not.toHaveBeenCalled();expect(autoBookCarrierForOrder).not.toHaveBeenCalled();
});
it("master references native changed reference conflicts and receipt still requires current master permission and scope",async()=>{
const input=masterBody();await createOrderForActor({user:actor(),body:input});const before=await masterState();
await expect(createOrderForActor({user:actor(),body:{...input,addresses:{...input.addresses,senderAddressId:input.addresses.receiverAddressId}}})).rejects.toMatchObject({statusCode:409});expect(await masterState()).toEqual(before);
const permission=await mockPrisma.permission.findUniqueOrThrow({where:{key:"customers.read"}}),grant=await mockPrisma.rolePermission.findFirstOrThrow({where:{roleId:roles[0],permissionId:permission.id}});await mockPrisma.rolePermission.delete({where:{id:grant.id}});
try{await expect(createOrderForActor({user:actor(),body:input})).rejects.toMatchObject({statusCode:403});expect(await masterState()).toEqual(before);}finally{await mockPrisma.rolePermission.create({data:grant});}
const role=await mockPrisma.role.findUniqueOrThrow({where:{id:roles[0]}});await mockPrisma.role.update({where:{id:role.id},data:{code:"customer"}});
try{await expect(createOrderForActor({user:actor(),body:input})).rejects.toMatchObject({statusCode:403});expect(await masterState()).toEqual(before);}finally{await mockPrisma.role.update({where:{id:role.id},data:{code:role.code}});}
expect(enqueueOrderLabelJob).toHaveBeenCalledTimes(1);
});
it("master references native CSV preview/confirm shares customer/address resolution and immutable batch identity",async()=>{
const header="receiverName,pickupAddress,dropoffAddress,currency,paymentType,customerEntityId,senderAddressId,receiverAddressId",row=`Synthetic,Pickup synthetic,Dropoff synthetic,UZS,CASH,${ids.customers.transAsia},${ids.addresses.transAsiaSender},${ids.addresses.transAsiaReceiver}`;
const args={actor:actor(),operationId:randomUUID(),csvText:header+"\n"+row};const before=await masterState();const preview=await previewOrderImport(args);expect(preview.validRows).toBe(1);expect(await masterState()).toEqual(before);
const result=await importOrdersFromCsv(args);expect(result.orders[0].customerEntityId).toBe(ids.customers.transAsia);expect(result.orders[0].senderAddressId).toBe(ids.addresses.transAsiaSender);const confirmed=await masterState();expect((await importOrdersFromCsv(args)).replayedRows).toBe(1);expect(await masterState()).toEqual(confirmed);
await expect(importOrdersFromCsv({...args,csvText:args.csvText.replace(ids.addresses.transAsiaSender,ids.addresses.transAsiaReceiver)})).rejects.toMatchObject({statusCode:409});expect(await masterState()).toEqual(confirmed);
await expect(importOrdersFromCsv({...args,operationId:randomUUID(),customerEntityId:ids.customers.unrelated})).rejects.toMatchObject({statusCode:403});expect(await masterState()).toEqual(confirmed);
});
it("master references native actual receipt failure rolls back linked order and emits nothing",async()=>{
const input=masterBody(),before=await masterState();await pool.query(`CREATE FUNCTION cp_master_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic linked receipt failure'; END $$; CREATE TRIGGER cp_master_fail BEFORE INSERT ON "OrderCreationReceipt" FOR EACH ROW EXECUTE FUNCTION cp_master_fail();`);
try{await expect(createOrderForActor({user:actor(),body:input})).rejects.toThrow("linked receipt failure");expect(await masterState()).toEqual(before);expect(enqueueOrderLabelJob).not.toHaveBeenCalled();expect(seedInitialServiceChargePricing).not.toHaveBeenCalled();}finally{await pool.query('DROP TRIGGER cp_master_fail ON "OrderCreationReceipt";DROP FUNCTION cp_master_fail();');}
});
