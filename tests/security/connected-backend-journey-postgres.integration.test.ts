// Only infrastructure boundaries are substituted. Business services and authorization use PostgreSQL.
jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, {
  get: (_t, key) => { const v = (mockPrisma as any)[key]; return typeof v === "function" ? v.bind(mockPrisma) : v; },
}) }));
jest.mock("../../src/config/s3", () => ({ s3: { send: (command: any) => mockStorage(command) } }));
jest.mock("../../src/utils/s3Presign", () => ({ presignGetObject: jest.fn(() => { throw Error("Signing outside this journey"); }) }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: jest.fn(() => { throw Error("Redis outside this journey"); }), getRedisPrefix: () => "synthetic-journey" }));
import { Pool } from "pg";
import { PrismaClient, OrderStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import http = require("http");
import https = require("https");
import { createTenantDemoFixture } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { createCustomerEntity } from "../../src/modules/customers-core/application/customerEntityRepo";
import { createAddress } from "../../src/modules/addresses-core/application/addressRepo";
import { createTariffPlan } from "../../src/modules/pricing-core/repo/pricing.repo";
import { createTariffPlanSchema } from "../../src/modules/pricing-core/shared/validation";
import { proposeTariffVersion, decideTariffVersion } from "../../src/modules/pricing-core/repo/tariff-versions";
import { proposeBillingPolicy, decideBillingPolicy } from "../../src/modules/pricing-core/repo/billing-policy";
import { syntheticBillingPolicy } from "./billing-policy.fixture";
import { createOrderForActor } from "../../src/modules/orders-core/write/create-order";
import { bindOrderBillTo, acceptOrderPrice } from "../../src/modules/pricing-core/repo/order-price";
import { assignDriversBulk, updateDriverOrderStatus, updateOrdersStatusBulk } from "../../src/modules/orders-core/operations/order-status";
import { submitProofForActor, requireProofSubmissionContext } from "../../src/modules/orders-core/proofs/proof";
import { issueOrderInvoiceForActor } from "../../src/modules/invoice-core/application/invoiceRepo";
import { executeWarehouseCustody, readWarehouseCustody } from "../../src/modules/orders-core/operations/warehouse-custody";
import { listCustodyWork } from "../../src/modules/orders-core/read/custody-work";
import { createWarehouse } from "../../src/modules/warehouse-core/application/warehouseRepo";
import { upsertOrderLeg } from "../../src/modules/orders-legs/legs";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, run = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !run || !/^[a-f0-9]{12}$/.test(run)) throw Error("Disposable run required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== "/cp_worker_" + run) throw Error("Refusing existing database");
const options = "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000";
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, options });
let mockPrisma: PrismaClient;
const fixture = createTenantDemoFixture(), memberships = fixture.companyMemberships;
const actor = (i: number): any => ({ ...memberships[i], id: memberships[i].userId,
  membershipId: memberships[i].id, companyMembershipId: memberships[i].id });
const maker = actor(3), checker = actor(4), operator = actor(0);
let driver: any, transport: any;
let savedBody:any, ownedWarehouseIds:string[];
const objects = new Map<string, Buffer>();
const mockStorage = jest.fn(async (command: any) => {
  const { Key, Body, IfNoneMatch, ContentType } = command.input;
  expect(IfNoneMatch).toBe("*"); expect(ContentType).toBe("image/png");
  if (objects.has(Key)) throw Error("Immutable mock object exists");
  objects.set(Key, Buffer.from(Body)); return {};
});
let fetchSpy: jest.SpyInstance, httpSpy: jest.SpyInstance, httpsSpy: jest.SpyInstance;
async function grant(user: any, keys: string[]) {
  const role = await mockPrisma.role.create({ data: { companyId: user.companyId, code: randomUUID(), name: "Synthetic journey capability" } });
  for (const key of keys) {
    const permission = await mockPrisma.permission.upsert({ where: { key }, create: { key, resource: "synthetic", action: key }, update: {} });
    await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  await mockPrisma.membershipRole.create({ data: { membershipId: user.companyMembershipId, roleId: role.id } });
  await mockPrisma.membershipScope.create({ data: { membershipId: user.companyMembershipId, scopeType: "company", scopeRefId: user.companyId } });
}
const intent = (orderId: string) => ({ orderId, operationId: randomUUID(), reason: "Synthetic connected journey" });
async function businessState() {
  const result: Record<string, unknown> = {};
  for (const table of ["Order", "Parcel", "OrderCreationIntent", "OrderCreationReceipt", "Tracking", "UserNotification",
    "OrderLabelJob", "PricingComponent", "OrderBillTo", "OrderPriceSnapshot", "OrderPriceApproval", "ProofSubmission",
    "OrderAttachment", "OrderCustodyAction", "OrderCustodyParcel", "OrderLeg", "Invoice", "InvoiceIssuanceReceipt", "BillingInvoiceOutbox", "FinanceAuditEvent", "AnalyticsDomainEventOutbox"])
    result[table] = (await pool.query('SELECT to_jsonb(t) AS row FROM "' + table + '" t ORDER BY to_jsonb(t)::text')).rows;
  return result;
}
async function expected(orderId: string) {
  const o = await mockPrisma.order.findUniqueOrThrow({ where: { id: orderId } });
  return [{ orderId, updatedAt: o.updatedAt.toISOString(), status: o.status,
    assignedDriverId: o.assignedDriverId, currentWarehouseId: o.currentWarehouseId }];
}
beforeAll(async () => {
  const marker = (await pool.query('SELECT "runId" FROM "_CPDisposableRun"')).rows;
  if (marker.length !== 1 || marker[0].runId !== run) throw Error("Ownership mismatch");
  // Prerequisites only. No master records, orders or invoices are inserted by the adapter.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await persistTenantDemoFixture(client, { ...fixture, warehouses: [], customers: [], addresses: [], orders: [], invoices: [] });
    await client.query("COMMIT");
  } finally { await client.query("ROLLBACK"); client.release(); }
  mockPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 6, connectionTimeoutMillis: 3000, options }) });
  const driverId = randomUUID(), tmId = randomUUID(), cmId = randomUUID();
  await mockPrisma.user.create({ data: { id: driverId, email: "synthetic-journey-driver@example.invalid", name: "Synthetic driver",
    password: "synthetic-invalid-login-value", driverType: "local" } });
  await mockPrisma.tenantMembership.create({ data: { id: tmId, userId: driverId, tenantId: maker.tenantId } });
  await mockPrisma.companyMembership.create({ data: { id: cmId, userId: driverId, tenantId: maker.tenantId,
    tenantMembershipId: tmId, companyId: maker.companyId } });
  driver = { id: driverId, tenantId: maker.tenantId, tenantMembershipId: tmId, companyId: maker.companyId, membershipId: cmId, companyMembershipId: cmId };
  const transportId=randomUUID(),transportTm=randomUUID(),transportCm=randomUUID();
  await mockPrisma.user.create({data:{id:transportId,email:"synthetic-linehaul@example.invalid",name:"Synthetic linehaul",password:"synthetic-invalid-login-value",driverType:"linehaul"}});
  await mockPrisma.tenantMembership.create({data:{id:transportTm,userId:transportId,tenantId:maker.tenantId}});
  await mockPrisma.companyMembership.create({data:{id:transportCm,userId:transportId,tenantMembershipId:transportTm,tenantId:maker.tenantId,companyId:maker.companyId}});
  transport={id:transportId,tenantMembershipId:transportTm,companyMembershipId:transportCm,membershipId:transportCm,tenantId:maker.tenantId,companyId:maker.companyId};
  await grant(maker, ["pricing.write", "pricing.read", "pricing.tariffs.propose", "billing.policies.propose", "billing.payers.bind",
    "pricing.orders.accept", "finance.invoices.issue", "customers.read"]);
  await grant(checker, ["pricing.tariffs.approve", "billing.policies.approve"]);
  await grant(operator, ["warehouse.create", "shipment.update", "customers.read", "customers.write", "pricing.read", "shipment.create", "shipment.view", "shipment.bookCarrier", "shipment.assignCourier", "shipment.changeStatus",
    "shipment.custody.intake","shipment.custody.dispatch","shipment.custody.receive","shipment.custody.last-mile-offer"]);
  await grant(driver, ["drivers.telemetry", "shipment.view", "shipment.update", "shipment.changeStatus","shipment.custody.pickup-offer","shipment.custody.last-mile-accept","shipment.custody.deliver"]);
  await grant(transport,["drivers.telemetry","shipment.view","shipment.custody.transport-accept"]);
  for(const i of [1,2])await grant(actor(i),["shipment.view","shipment.custody.intake","shipment.custody.dispatch","warehouse.create"]);
  process.env.ORDER_LABEL_BLOCKING = "true";
  process.env.ORDER_LABEL_AUTO_FALLBACK = "false";
  process.env.ORDER_LABEL_MODE = "queue";
  process.env.AWS_S3_BUCKET = "synthetic-journey-no-network";
  fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(Error("Network forbidden"));
  httpSpy = jest.spyOn(http, "request").mockImplementation(() => { throw Error("HTTP forbidden"); });
  httpsSpy = jest.spyOn(https, "request").mockImplementation(() => { throw Error("HTTPS forbidden"); });
});
afterAll(async () => {
  fetchSpy?.mockRestore(); httpSpy?.mockRestore(); httpsSpy?.mockRestore();
  for (const key of ["ORDER_LABEL_BLOCKING", "ORDER_LABEL_AUTO_FALLBACK", "ORDER_LABEL_MODE", "AWS_S3_BUCKET"]) delete process.env[key];
  await mockPrisma?.$disconnect(); await pool.end();
});
it("real normal creation -> pickup -> three warehouses -> accepted last mile -> delivery proof -> delivered invoice; retries, conflicts and rollback", async () => {
  expect(new Set([maker.id, checker.id, operator.id, driver.id]).size).toBe(4);
  expect(await mockPrisma.order.count()).toBe(0);
  expect(await mockPrisma.customerEntity.count()).toBe(0);
  const customer = await createCustomerEntity(operator, { type: "COMPANY", name: "Synthetic shipment customer" });
  const payer = await createCustomerEntity(operator, { type: "COMPANY", name: "Synthetic instructed payer" });
  const sender = await createAddress(operator, { customerEntityId: customer.id, city: "Synthetic A", country: "ZZ", addressLine1: "Synthetic pickup" });
  const receiver = await createAddress(operator, { customerEntityId: customer.id, city: "Synthetic B", country: "ZZ", addressLine1: "Synthetic destination" });
  for (const row of [customer, payer, sender, receiver]) expect(row.tenantId).toBe(maker.tenantId);
  const plan = await createTariffPlan(maker, createTariffPlanSchema.parse({ name: "Synthetic journey", serviceType: "DOOR_TO_DOOR", currency: "UZS",
    isDefault: true, rates: [{ zone: 1, weightFromKg: "0.01", weightToKg: "100", price: "100" }] }));
  const current = await mockPrisma.tariffPlan.findUniqueOrThrow({ where: { id: plan.id } });
  const version = await proposeTariffVersion({ user: maker, planId: plan.id, expectedGeneration: current.contentGeneration,
    operationId: randomUUID(), reason: "Synthetic published tariff" });
  await decideTariffVersion({ user: checker, planId: plan.id, versionId: version.id, contentSha256: version.contentSha256,
    operationId: randomUUID(), decision: "approved", reason: "Independent synthetic tariff review" });
  const policy = await proposeBillingPolicy(maker, { operationId: randomUUID(), reason: "Synthetic configuration only",
    content: syntheticBillingPolicy({ billing: { mode: "manual", eligibleOrderStates: ["pending", "delivered"], dueDays: 7, numberPrefix: "SYNTHETIC" } }) });
  await decideBillingPolicy(checker, { versionId: policy.id, contentHash: policy.contentHash, operationId: randomUUID(), decision: "approved",
    reason: "Independent synthetic policy; delivered invoice eligibility is a test configuration, not company policy" });
  const body = { operationId: randomUUID(), customerEntityId: customer.id, sender: { name: "Synthetic sender" }, receiver: { name: "Synthetic recipient" },
    addresses: { pickupAddress: "Synthetic pickup", dropoffAddress: "Synthetic destination", senderAddressId: sender.id, receiverAddressId: receiver.id },
    shipment: { serviceType: "DOOR_TO_DOOR", currency: "UZS", weightKg: 2 }, payment: { paymentType: "OTHER", deliveryChargePaidBy: "COMPANY" } };
  savedBody=body;
  const created = await createOrderForActor({ user: operator, body }), orderId = created.payload.order.id;
  expect(created.payload.warning).toBeNull();
  expect(created.payload.order).toMatchObject({ tenantId: maker.tenantId, ownerOrgId: maker.companyId,
    customerEntityId: customer.id, senderAddressId: sender.id, receiverAddressId: receiver.id, status: "pending" });
  await bindOrderBillTo(maker, { ...intent(orderId), payerCustomerEntityId: payer.id, evidence: "Synthetic explicit payer instruction" });
  const acceptanceIntent = intent(orderId), price = await acceptOrderPrice(maker, acceptanceIntent);
  expect(price).toMatchObject({ state: "accepted", currency: "UZS", total: "110.0100" });
  await assignDriversBulk({ actor: operator, orderIds: [orderId], expectedStates: await expected(orderId), driverId: driver.id, type: "pickup" });
  await updateDriverOrderStatus({ actor: driver, orderId, status: OrderStatus.pickup_in_progress });
  await updateDriverOrderStatus({ actor: driver, orderId, status: OrderStatus.picked_up });
  // Do not fabricate an onward warehouse transition or a completed delivery.
  const atPickup = await businessState();
  await expect(updateDriverOrderStatus({ actor: driver, orderId, status: OrderStatus.out_for_delivery })).rejects.toThrow("Durable warehouse custody endpoint required");
  await expect(updateOrdersStatusBulk({ actor: operator, orderIds: [orderId], expectedStates: await expected(orderId), status: OrderStatus.at_warehouse })).rejects.toThrow("manual transition policy is unavailable");
  expect(await businessState()).toEqual(atPickup);
  const { PNG } = require("pngjs"), buffer = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
  const proofIntent = { actor: driver, orderId, body: { submissionId: randomUUID(), stage: "pickup", signedBy: "Synthetic sender",
    clientCapturedAt: "2026-01-01T00:00:00.000Z", signaturePaths: ["1,2;3,4"] },
    file: { buffer, size: buffer.length, mimetype: "image/png", originalname: "synthetic.png" } };
  const proof = await submitProofForActor(proofIntent);
  expect(proof.success).toBe(true); expect(proof.proof.savedAt).not.toBe(proof.proof.clientCapturedAt);
  expect(mockStorage).toHaveBeenCalledTimes(2);
  for (const bytes of objects.values()) expect(PNG.sync.read(bytes).width).toBeGreaterThan(0);
  const warehouses=[];
  for(let i=0;i<3;i++){
    const w=await createWarehouse(operator,{name:`Synthetic warehouse ${i}`,type:"warehouse",location:"Synthetic"});warehouses.push(w);
    await mockPrisma.membershipScope.create({data:{membershipId:operator.companyMembershipId,scopeType:"warehouse",scopeRefId:w.id}});
  }
  const parcelIds=created.payload.order.parcels.map((p:any)=>p.id);
  ownedWarehouseIds=warehouses.map(w=>w.id);
  async function custodyIntent(action:string,extra:any={}){
    const o=await mockPrisma.order.findUniqueOrThrow({where:{id:orderId}});
    const event=await mockPrisma.orderCustodyAction.findFirst({where:{orderId},orderBy:{sequence:"desc"}});
    return {operationId:randomUUID(),action,expectedEventId:event?.id??null,expectedUpdatedAt:o.updatedAt.toISOString(),parcelIds,...extra};
  }
  async function denied(who:any,input:any){const before=await businessState(),storage=mockStorage.mock.calls.length;await expect(executeWarehouseCustody(who,orderId,input)).rejects.toThrow();expect(await businessState()).toEqual(before);expect(mockStorage).toHaveBeenCalledTimes(storage);}
  async function accepted(who:any,input:any){const results=await Promise.all([executeWarehouseCustody(who,orderId,input),executeWarehouseCustody(who,orderId.toUpperCase(),JSON.parse(JSON.stringify(input)))]);expect(results[0]).toEqual(results[1]);const before=await businessState();expect(await executeWarehouseCustody(who,orderId,input)).toEqual(results[0]);expect(await businessState()).toEqual(before);return results[0];}
  const pickupSource=await mockPrisma.tracking.findFirstOrThrow({where:{orderId,status:"picked_up"},orderBy:{timestamp:"desc"}});
  const offer=await custodyIntent("pickup-offer",{pickupTrackingId:pickupSource.id,destinationWarehouseId:warehouses[0].id});
  const foreignWarehouse=await createWarehouse(actor(2),{name:"Synthetic foreign warehouse",type:"warehouse",location:"Synthetic"});
  await denied(driver,{...offer,destinationWarehouseId:foreignWarehouse.id});
  await denied(driver,{...offer,pickupTrackingId:randomUUID()});
  await accepted(driver,offer);
  await denied(driver,{...offer,destinationWarehouseId:warehouses[1].id});
  const intake=await custodyIntent("intake",{warehouseId:warehouses[0].id});
  await denied(actor(1),intake);await denied(actor(2),intake);await denied({},intake);
  await denied(checker,intake);
  const receivingScope=await mockPrisma.membershipScope.findFirstOrThrow({where:{membershipId:operator.companyMembershipId,scopeType:"warehouse",scopeRefId:warehouses[0].id}});
  await mockPrisma.membershipScope.delete({where:{id:receivingScope.id}});
  try{await denied(operator,intake);}finally{await mockPrisma.membershipScope.create({data:receivingScope});}
  await denied(operator,{...intake,parcelIds:[randomUUID()]});await denied(operator,{...intake,warehouseId:warehouses[1].id});
  await denied(operator,{...intake,expectedUpdatedAt:new Date(0).toISOString()});
  const intakeIntents=[intake,{...intake,operationId:randomUUID()}];
  const competition=await Promise.allSettled(intakeIntents.map(v=>executeWarehouseCustody(operator,orderId,v)));
  expect(competition.filter(v=>v.status==="fulfilled")).toHaveLength(1);
  expect(competition.filter(v=>v.status==="rejected")).toHaveLength(1);
  const winner=competition.findIndex(v=>v.status==="fulfilled"),intakeState=await businessState();
  expect(await executeWarehouseCustody(operator,orderId,intakeIntents[winner])).toEqual((competition[winner] as PromiseFulfilledResult<unknown>).value);
  expect(await businessState()).toEqual(intakeState);
  await denied(operator,{...intakeIntents[winner],warehouseId:warehouses[1].id});
  // No adoption of assignment as acceptance: intake explicitly ends the pickup assignment.
  expect(await mockPrisma.order.findUniqueOrThrow({where:{id:orderId}})).toMatchObject({status:"at_warehouse",currentWarehouseId:warehouses[0].id,assignedDriverId:null});
  for(let i=0;i<2;i++){
    const leg=await upsertOrderLeg(orderId,{sequence:i+1,fromWarehouseId:warehouses[i].id,toWarehouseId:warehouses[i+1].id},operator);
    const dispatch=await custodyIntent("dispatch",{warehouseId:warehouses[i].id,destinationWarehouseId:warehouses[i+1].id,legId:leg.id,driverMembershipId:transport.companyMembershipId});
    await denied(operator,{...dispatch,driverMembershipId:driver.companyMembershipId});
    await denied(operator,{...dispatch,legId:randomUUID()});
    if(i===0){
      const before=await businessState();
      await pool.query("CREATE FUNCTION cp_custody_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic custody rollback'; END $$; CREATE TRIGGER cp_custody_test_failure BEFORE INSERT ON \"AnalyticsDomainEventOutbox\" FOR EACH ROW EXECUTE FUNCTION cp_custody_test_failure()");
      try{await expect(executeWarehouseCustody(operator,orderId,dispatch)).rejects.toThrow();expect(await businessState()).toEqual(before);}
      finally{await pool.query('DROP TRIGGER cp_custody_test_failure ON "AnalyticsDomainEventOutbox"; DROP FUNCTION cp_custody_test_failure()');}
    }
    await accepted(operator,dispatch);
    const prior=await businessState();await expect(upsertOrderLeg(orderId,{legId:leg.id,status:"arrived"},operator)).rejects.toThrow("planning only");expect(await businessState()).toEqual(prior);
    await denied(operator,await custodyIntent("receive",{warehouseId:warehouses[i+1].id}));
    const accept=await custodyIntent("transport-accept");await denied(driver,accept);await accepted(transport,accept);
    expect(await mockPrisma.order.findUniqueOrThrow({where:{id:orderId}})).toMatchObject({status:"in_transit",currentWarehouseId:null});
    await denied(operator,await custodyIntent("receive",{warehouseId:warehouses[i].id}));
    await accepted(operator,await custodyIntent("receive",{warehouseId:warehouses[i+1].id}));
    expect(await mockPrisma.order.findUniqueOrThrow({where:{id:orderId}})).toMatchObject({status:"at_warehouse",currentWarehouseId:warehouses[i+1].id});
  }
  await accepted(operator,await custodyIntent("last-mile-offer",{warehouseId:warehouses[2].id,driverMembershipId:driver.companyMembershipId}));
  const lastAccept=await custodyIntent("last-mile-accept");await denied(transport,lastAccept);await accepted(driver,lastAccept);
  await denied(driver,await custodyIntent("deliver",{proofSubmissionId:proofIntent.body.submissionId}));
  const deliveryProofIntent={...proofIntent,body:{...proofIntent.body,stage:"delivery",submissionId:randomUUID(),signedBy:"Synthetic recipient"}};
  const deliveryProof=await submitProofForActor(deliveryProofIntent);
  await accepted(driver,await custodyIntent("deliver",{proofSubmissionId:deliveryProofIntent.body.submissionId}));
  expect(await mockPrisma.order.findUniqueOrThrow({where:{id:orderId}})).toMatchObject({status:"delivered",currentWarehouseId:null,assignedDriverId:driver.id});
  const issuance = { user: maker, ...intent(orderId), priceApprovalId: price.id }, invoice = await issueOrderInvoiceForActor(issuance);
  expect(invoice).toMatchObject({ status: "issued", amount: "110.0100", currency: "UZS", billing: { payerCustomerEntityId: payer.id, priceApprovalId: price.id } });
  const confirmed = await businessState();
  expect((await createOrderForActor({ user: operator, body })).payload).toMatchObject({ creationReplay: true, order: { id: orderId } });
  expect(await acceptOrderPrice(maker, acceptanceIntent)).toEqual(price);
  expect(await submitProofForActor(proofIntent)).toEqual(proof);
  expect(await submitProofForActor(deliveryProofIntent)).toEqual(deliveryProof);
  expect(await issueOrderInvoiceForActor(issuance)).toEqual(invoice);
  expect(await businessState()).toEqual(confirmed);
  expect(await mockPrisma.order.count()).toBe(1);
  expect(await mockPrisma.invoice.count()).toBe(1);
  expect(await mockPrisma.orderCreationReceipt.count()).toBe(1);
  expect(await mockPrisma.orderPriceSnapshot.count()).toBe(1);
  expect(await mockPrisma.orderAttachment.count()).toBe(4);
  expect(await mockPrisma.orderLabelJob.count()).toBe(1);
  expect(await mockPrisma.orderCustodyAction.count()).toBe(11);
  expect(await mockPrisma.orderCustodyParcel.count()).toBe(11*parcelIds.length);
  expect(await mockPrisma.billingInvoiceOutbox.count({ where: { state: "held_no_accounting_authority" } })).toBe(1);
  expect(await mockPrisma.financeJournalEntry.count()).toBe(0);
  expect(await mockPrisma.paymentIntent.count()).toBe(0);
  const notifications = await mockPrisma.userNotification.findMany();
  expect(notifications.length).toBeGreaterThan(0);
  for (const n of notifications) expect(n).toMatchObject({ userId: driver.id, tenantId: maker.tenantId, companyId: maker.companyId, companyMembershipId: driver.companyMembershipId });
  expect(mockStorage).toHaveBeenCalledTimes(4);
  expect(fetchSpy).not.toHaveBeenCalled(); expect(httpSpy).not.toHaveBeenCalled(); expect(httpsSpy).not.toHaveBeenCalled();
});

it("competing dispatch and last-mile handover serialize one intent without mixed custody or duplicate effects",async()=>{
  const made=await createOrderForActor({user:operator,body:{...savedBody,operationId:randomUUID()}}),orderId=made.payload.order.id;
  const parcelIds=made.payload.order.parcels.map((p:any)=>p.id);
  const next=async(action:string,extra:any={})=>{const o=await mockPrisma.order.findUniqueOrThrow({where:{id:orderId}}),e=await mockPrisma.orderCustodyAction.findFirst({where:{orderId},orderBy:{sequence:"desc"}});return {action,operationId:randomUUID(),expectedUpdatedAt:o.updatedAt.toISOString(),expectedEventId:e?.id??null,parcelIds,...extra};};
  await assignDriversBulk({actor:operator,orderIds:[orderId],expectedStates:await expected(orderId),driverId:driver.id,type:"pickup"});
  await updateDriverOrderStatus({actor:driver,orderId,status:"pickup_in_progress"});await updateDriverOrderStatus({actor:driver,orderId,status:"picked_up"});
  const tracking=await mockPrisma.tracking.findFirstOrThrow({where:{orderId,status:"picked_up"}});
  await executeWarehouseCustody(driver,orderId,await next("pickup-offer",{destinationWarehouseId:ownedWarehouseIds[0],pickupTrackingId:tracking.id}));
  await executeWarehouseCustody(operator,orderId,await next("intake",{warehouseId:ownedWarehouseIds[0]}));
  const leg=await upsertOrderLeg(orderId,{sequence:1,fromWarehouseId:ownedWarehouseIds[0],toWarehouseId:ownedWarehouseIds[1]},operator);
  const inputs=[await next("dispatch",{warehouseId:ownedWarehouseIds[0],destinationWarehouseId:ownedWarehouseIds[1],legId:leg.id,driverMembershipId:transport.companyMembershipId}),
    await next("last-mile-offer",{warehouseId:ownedWarehouseIds[0],driverMembershipId:driver.companyMembershipId})];
  const beforeNotifications=await mockPrisma.userNotification.count({where:{orderId}}),beforeTracking=await mockPrisma.tracking.count({where:{orderId}});
  const results=await Promise.allSettled(inputs.map(input=>executeWarehouseCustody(operator,orderId,input)));
  expect(results.filter(v=>v.status==="fulfilled")).toHaveLength(1);expect(results.filter(v=>v.status==="rejected")).toHaveLength(1);
  expect(await mockPrisma.orderCustodyAction.count({where:{orderId}})).toBe(3);
  expect(await mockPrisma.tracking.count({where:{orderId}})).toBe(beforeTracking+1);
  const o=await mockPrisma.order.findUniqueOrThrow({where:{id:orderId}}),state=await mockPrisma.orderCustodyAction.findFirstOrThrow({where:{orderId},orderBy:{sequence:"desc"}});
  expect(o.status).toBe("at_warehouse");expect(o.currentWarehouseId).toBe(ownedWarehouseIds[0]);
  expect(o.assignedDriverId).toBe(state.phase==="last-mile-offered"?driver.id:null);
  expect(await mockPrisma.userNotification.count({where:{orderId}})).toBe(beforeNotifications+(state.phase==="last-mile-offered"?1:0));
  const winner=results.findIndex(v=>v.status==="fulfilled"),before=await businessState();
  expect(await executeWarehouseCustody(operator,orderId,inputs[winner])).toEqual((results[winner] as PromiseFulfilledResult<unknown>).value);
  await expect(executeWarehouseCustody(operator,orderId,inputs[1-winner])).rejects.toThrow();
  await expect(assignDriversBulk({actor:operator,orderIds:[orderId],expectedStates:await expected(orderId),driverId:driver.id,type:"delivery"})).rejects.toThrow("Custody-bound assignments");
  await expect(upsertOrderLeg(orderId,{legId:leg.id,actualArrivalAt:new Date().toISOString()},operator)).rejects.toThrow("planning only");
  expect(await businessState()).toEqual(before);
  expect(fetchSpy).not.toHaveBeenCalled();expect(httpSpy).not.toHaveBeenCalled();expect(httpsSpy).not.toHaveBeenCalled();
});

it("warehouse-only recipients and exact nominated drivers without company/assignCourier scope execute and preflight their own custody", async () => {
  async function restricted(name: string, warehouseId?: string, type?: "linehaul") {
    const id = randomUUID(), tm = randomUUID(), cm = randomUUID();
    await mockPrisma.user.create({ data: { id, email: `${name}@example.invalid`, name, password: "synthetic-invalid-login-value", driverType: type } });
    await mockPrisma.tenantMembership.create({ data: { id: tm, userId: id, tenantId: maker.tenantId } });
    await mockPrisma.companyMembership.create({ data: { id: cm, userId: id, tenantMembershipId: tm, tenantId: maker.tenantId, companyId: maker.companyId } });
    const who = { id, membershipId: cm, companyMembershipId: cm, tenantMembershipId: tm, tenantId: maker.tenantId, companyId: maker.companyId };
    await grant(who, warehouseId ? ["shipment.view", "shipment.custody.intake", "shipment.custody.dispatch", "shipment.custody.receive", "shipment.custody.last-mile-offer"] : ["shipment.view", "drivers.telemetry", "shipment.custody.transport-accept"]);
    await mockPrisma.membershipScope.deleteMany({ where: { membershipId: cm } });
    if (warehouseId) await mockPrisma.membershipScope.create({ data: { membershipId: cm, scopeType: "warehouse", scopeRefId: warehouseId } });
    return who;
  }
  const origin = await restricted("synthetic-origin-only", ownedWarehouseIds[0]);
  const destination = await restricted("synthetic-destination-only", ownedWarehouseIds[1]);
  const unrelated = await restricted("synthetic-unrelated-linehaul", undefined, "linehaul");
  const made = await createOrderForActor({ user: operator, body: { ...savedBody, operationId: randomUUID() } }), orderId = made.payload.order.id;
  await assignDriversBulk({ actor: operator, orderIds: [orderId], expectedStates: await expected(orderId), driverId: driver.id, type: "pickup" });
  await updateDriverOrderStatus({ actor: driver, orderId, status: "pickup_in_progress" });
  await updateDriverOrderStatus({ actor: driver, orderId, status: "picked_up" });
  const sibling = await createOrderForActor({user:operator,body:{...savedBody,operationId:randomUUID()}}), siblingId=sibling.payload.order.id;
  await assignDriversBulk({actor:operator,orderIds:[siblingId],expectedStates:await expected(siblingId),driverId:driver.id,type:"pickup"});
  await updateDriverOrderStatus({actor:driver,orderId:siblingId,status:"pickup_in_progress"});
  await updateDriverOrderStatus({actor:driver,orderId:siblingId,status:"picked_up"});
  await mockPrisma.membershipScope.deleteMany({ where: { membershipId: { in: [driver.companyMembershipId, transport.companyMembershipId] } } });
  for (const who of [origin, destination, driver, transport]) {
    expect(await mockPrisma.membershipScope.count({ where: { membershipId: who.companyMembershipId, scopeType: "company" } })).toBe(0);
    const roles = await mockPrisma.membershipRole.findMany({ where: { membershipId: who.companyMembershipId }, include: { role: { include: { rolePermissions: { include: { permission: true } } } } } });
    expect(roles.flatMap(r => r.role.rolePermissions.map(p => p.permission.key))).not.toContain("shipment.assignCourier");
  }
  const parcelIds = made.payload.order.parcels.map((p: any) => p.id);
  const next = async (who: any, action: string, extra: any = {}) => {
    const snapshot = await readWarehouseCustody(who, orderId);
    expect(snapshot.parcelIds).toEqual([...parcelIds].sort());
    return { operationId: randomUUID(), action, expectedEventId: snapshot.custody?.id ?? null, expectedUpdatedAt: snapshot.updatedAt, parcelIds: snapshot.parcelIds, ...extra };
  };
  async function denied(who: any, input: any) {
    const before = await businessState(), puts = mockStorage.mock.calls.length;
    await expect(executeWarehouseCustody(who, orderId, input)).rejects.toThrow();
    expect(await businessState()).toEqual(before); expect(mockStorage).toHaveBeenCalledTimes(puts);
  }
  const pickup = await readWarehouseCustody(driver, orderId);
  expect(pickup.pickupTrackingId).toBeTruthy();
  const offer = await next(driver, "pickup-offer", { pickupTrackingId: pickup.pickupTrackingId, destinationWarehouseId: ownedWarehouseIds[0] });
  const offerResult = await executeWarehouseCustody(driver, orderId, offer);
  let intake = await next(origin, "intake", { warehouseId: ownedWarehouseIds[0] });
  await expect(readWarehouseCustody(destination, orderId)).rejects.toThrow();
  await denied(destination, intake); await denied(actor(1), intake); await denied(actor(2), intake);
  const siblingSnapshot=await readWarehouseCustody(driver,siblingId);
  await executeWarehouseCustody(driver,siblingId,{operationId:randomUUID(),action:"pickup-offer",expectedEventId:null,
    expectedUpdatedAt:siblingSnapshot.updatedAt,parcelIds:siblingSnapshot.parcelIds,pickupTrackingId:siblingSnapshot.pickupTrackingId,destinationWarehouseId:ownedWarehouseIds[0]});
  const page=await listCustodyWork(origin,{kind:"warehouse",limit:1});expect(page.items).toHaveLength(1);expect(page.nextCursor).toBeTruthy();
  const pages=[...page.items];let cursor=page.nextCursor;
  while(cursor){const more=await listCustodyWork(origin,{kind:"warehouse",limit:1,cursor});expect(more.items.length).toBeLessThanOrEqual(1);pages.push(...more.items);cursor=more.nextCursor;if(pages.length>10)throw Error("Pagination did not terminate");}
  expect(new Set(pages.map(p=>p.orderId)).size).toBe(pages.length);expect(pages.map(p=>p.orderId)).toEqual(expect.arrayContaining([orderId,siblingId]));
  expect(Object.keys(page.items[0]).sort()).toEqual(["orderId","orderNumber","status","expectedUpdatedAt","expectedEventId","phase","currentWarehouseId","destinationWarehouseId","legId"].sort());
  for(const query of [{kind:"warehouse",limit:0},{kind:"warehouse",limit:51},{kind:"warehouse",limit:2,cursor:page.nextCursor},{kind:"warehouse",limit:1,cursor:"invalid"}]) await expect(listCustodyWork(origin,query)).rejects.toThrow();
  await expect(listCustodyWork(destination,{kind:"warehouse",limit:1,cursor:page.nextCursor})).rejects.toThrow("cursor");
  expect((await listCustodyWork(destination,{kind:"warehouse"})).items.map(p=>p.orderId)).not.toContain(orderId);
  await mockPrisma.membershipScope.create({data:{membershipId:actor(1).companyMembershipId,scopeType:"warehouse",scopeRefId:ownedWarehouseIds[0]}});
  expect((await listCustodyWork(actor(1),{kind:"warehouse"})).items).toEqual([]);
  await expect(listCustodyWork(actor(2),{kind:"warehouse",limit:1,cursor:page.nextCursor})).rejects.toThrow();
  expect((await listCustodyWork(unrelated,{kind:"driver"})).items).toEqual([]);
  // Suspension denies the outgoing actor, but permits exact destination staff to attest physical receipt with reason.
  await mockPrisma.companyMembership.update({where:{id:driver.companyMembershipId},data:{status:"suspended"}});
  let intakeResult:any;
  try {
    await denied(origin,intake);await denied(driver,offer);await expect(listCustodyWork(driver,{kind:"driver"})).rejects.toThrow();
    await denied(origin,{...intake,outgoingDriverReason:"short"});await denied(origin,{...intake,outgoingDriverReason:"Synthetic receipt\ncontrol"});
    const intents=[{...intake,outgoingDriverReason:"Synthetic physical receipt after driver suspension"},{...intake,operationId:randomUUID(),outgoingDriverReason:"Synthetic physical receipt after driver suspension"}];
    const before=await mockPrisma.tracking.count({where:{orderId}});
    const results=await Promise.allSettled(intents.map(i=>executeWarehouseCustody(origin,orderId,i)));
    expect(results.filter(v=>v.status==="fulfilled")).toHaveLength(1);expect(results.filter(v=>v.status==="rejected")).toHaveLength(1);
    const winner=results.findIndex(v=>v.status==="fulfilled");intake=intents[winner];intakeResult=(results[winner] as PromiseFulfilledResult<any>).value;
    expect(await mockPrisma.tracking.count({where:{orderId}})).toBe(before+1);
    expect(await executeWarehouseCustody(origin,orderId,intake)).toEqual(intakeResult);
    const audit=await mockPrisma.orderCustodyAction.findUniqueOrThrow({where:{id:intakeResult.eventId}});
    expect(audit.beforeState).toMatchObject({outgoing:{predecessorEventId:(offerResult as any).eventId,userId:driver.id,companyMembershipId:driver.companyMembershipId,membershipStatus:"suspended",suspended:true,reason:intake.outgoingDriverReason}});
    expect((await mockPrisma.companyMembership.findUniqueOrThrow({where:{id:driver.companyMembershipId}})).status).toBe("suspended");
  }finally{await mockPrisma.companyMembership.update({where:{id:driver.companyMembershipId},data:{status:"active"}});}
  await denied(origin,{...intake,outgoingDriverReason:"Different physical receipt intent"});
  expect((await listCustodyWork(origin,{kind:"warehouse"})).items.map(p=>p.orderId)).toContain(orderId);
  expect((await listCustodyWork(driver,{kind:"driver"})).items.map(p=>p.orderId)).not.toContain(orderId);
  const leg = await upsertOrderLeg(orderId, { sequence: 1, fromWarehouseId: ownedWarehouseIds[0], toWarehouseId: ownedWarehouseIds[1] }, operator);
  const dispatch = await next(origin, "dispatch", { warehouseId: ownedWarehouseIds[0], destinationWarehouseId: ownedWarehouseIds[1], driverMembershipId: transport.companyMembershipId, legId: leg.id });
  await executeWarehouseCustody(origin, orderId, dispatch);
  const acceptance = await next(transport, "transport-accept");
  expect((await listCustodyWork(transport,{kind:"driver"})).items.map(p=>p.orderId)).toContain(orderId);
  expect((await listCustodyWork(destination,{kind:"warehouse"})).items.map(p=>p.orderId)).not.toContain(orderId);
  await denied(destination,{...acceptance,action:"receive",warehouseId:ownedWarehouseIds[1]});
  await expect(readWarehouseCustody(unrelated, orderId)).rejects.toThrow();
  await denied(unrelated, acceptance); await denied(driver, acceptance);
  await denied({ ...transport, companyMembershipId: actor(1).companyMembershipId, membershipId: actor(1).membershipId }, acceptance);
  const accepted = await executeWarehouseCustody(transport, orderId, acceptance);
  expect(await executeWarehouseCustody(transport, orderId, acceptance)).toEqual(accepted);
  expect((await readWarehouseCustody(transport, orderId)).custody?.phase).toBe("transport");
  let receipt = await next(destination, "receive", { warehouseId: ownedWarehouseIds[1] });
  expect((await listCustodyWork(destination,{kind:"warehouse"})).items.map(p=>p.orderId)).toContain(orderId);
  // Invalid current fixtures demonstrate cancellation/conflict containment; no runtime cancellation policy is invented.
  await mockPrisma.orderLeg.update({where:{id:leg.id},data:{status:"cancelled"}});
  try{await denied(destination,receipt);expect((await listCustodyWork(destination,{kind:"warehouse"})).items.map(p=>p.orderId)).not.toContain(orderId);}
  finally{await mockPrisma.orderLeg.update({where:{id:leg.id},data:{status:"departed"}});}
  await mockPrisma.orderLeg.update({where:{id:leg.id},data:{carrierBookingStatus:"cancelled"}});
  try{await denied(destination,receipt);expect((await listCustodyWork(destination,{kind:"warehouse"})).items.map(p=>p.orderId)).not.toContain(orderId);}
  finally{await mockPrisma.orderLeg.update({where:{id:leg.id},data:{carrierBookingStatus:"not_requested"}});}
  await denied(origin, receipt); await denied(destination, { ...receipt, warehouseId: ownedWarehouseIds[0] });
  await mockPrisma.companyMembership.update({ where: { id: destination.companyMembershipId }, data: { status: "suspended" } });
  try { await denied(destination, receipt); await expect(readWarehouseCustody(destination, orderId)).rejects.toThrow(); } finally {
    await mockPrisma.companyMembership.update({ where: { id: destination.companyMembershipId }, data: { status: "active" } });
  }
  await mockPrisma.companyMembership.update({where:{id:transport.companyMembershipId},data:{status:"suspended"}});
  try {
    await denied(destination,receipt);await denied(transport,acceptance);await expect(listCustodyWork(transport,{kind:"driver"})).rejects.toThrow();
    receipt={...receipt,outgoingDriverReason:"Synthetic physical receipt after linehaul suspension"};
    const before=await businessState();
    await pool.query(`CREATE FUNCTION cp_receipt_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic receipt rollback'; END $$; CREATE TRIGGER cp_receipt_test_failure BEFORE INSERT ON "AnalyticsDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_receipt_test_failure()`);
    try{await expect(executeWarehouseCustody(destination,orderId,receipt)).rejects.toThrow();expect(await businessState()).toEqual(before);}
    finally{await pool.query('DROP TRIGGER cp_receipt_test_failure ON "AnalyticsDomainEventOutbox"; DROP FUNCTION cp_receipt_test_failure()');}
    const results=await Promise.all([executeWarehouseCustody(destination,orderId,receipt),executeWarehouseCustody(destination,orderId,receipt)]);expect(results[0]).toEqual(results[1]);
    const audit=await mockPrisma.orderCustodyAction.findUniqueOrThrow({where:{id:(results[0] as any).eventId}});
    expect(audit.beforeState).toMatchObject({outgoing:{predecessorEventId:(accepted as any).eventId,companyMembershipId:transport.companyMembershipId,membershipStatus:"suspended",suspended:true}});
  }finally{await mockPrisma.companyMembership.update({where:{id:transport.companyMembershipId},data:{status:"active"}});}
  expect((await listCustodyWork(transport,{kind:"driver"})).items.map(p=>p.orderId)).not.toContain(orderId);
  await executeWarehouseCustody(destination, orderId, await next(destination, "last-mile-offer", { warehouseId: ownedWarehouseIds[1], driverMembershipId: driver.companyMembershipId }));
  const last = await next(driver, "last-mile-accept");
  expect((await listCustodyWork(driver,{kind:"driver"})).items.map(p=>p.orderId)).toContain(orderId);
  await denied(transport, last); await executeWarehouseCustody(driver, orderId, last);
  expect(await requireProofSubmissionContext(driver, orderId)).toMatchObject({ assignedDriverId: driver.id });
  const { PNG } = require("pngjs"), bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
  const proofIntent = { actor: driver, orderId, body: { submissionId: randomUUID(), stage: "delivery", signedBy: "Synthetic recipient", signaturePaths: ["1,2;3,4"] }, file: { buffer: bytes, originalname: "photo.png", mimetype: "image/png", size: bytes.length } };
  const proof = await submitProofForActor(proofIntent);
  await executeWarehouseCustody(driver, orderId, await next(driver, "deliver", { proofSubmissionId: proof.proof.submissionId }));
  expect((await readWarehouseCustody(driver, orderId)).custody?.phase).toBe("delivered");
  expect((await listCustodyWork(driver,{kind:"driver"})).items.map(p=>p.orderId)).not.toContain(orderId);
  const confirmed = await businessState(), puts = mockStorage.mock.calls.length;
  expect(await executeWarehouseCustody(origin, orderId, intake)).toEqual(intakeResult);
  expect(await executeWarehouseCustody(driver, orderId, offer)).toEqual(offerResult);
  expect(await executeWarehouseCustody(transport, orderId, acceptance)).toEqual(accepted);
  expect(await submitProofForActor(proofIntent)).toEqual(proof);
  expect(await businessState()).toEqual(confirmed); expect(mockStorage).toHaveBeenCalledTimes(puts);
  await expect(readWarehouseCustody(origin, orderId)).rejects.toThrow(); // Receipt does not grant current order visibility.
  await mockPrisma.membershipScope.deleteMany({ where: { membershipId: origin.companyMembershipId } });
  await denied(origin, intake);
  expect(fetchSpy).not.toHaveBeenCalled(); expect(httpSpy).not.toHaveBeenCalled(); expect(httpsSpy).not.toHaveBeenCalled();
});
