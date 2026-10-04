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
import { submitProofForActor } from "../../src/modules/orders-core/proofs/proof";
import { issueOrderInvoiceForActor } from "../../src/modules/invoice-core/application/invoiceRepo";

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
let driver: any;
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
    "OrderAttachment", "Invoice", "InvoiceIssuanceReceipt", "BillingInvoiceOutbox", "FinanceAuditEvent", "AnalyticsDomainEventOutbox"])
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
  await grant(maker, ["pricing.write", "pricing.read", "pricing.tariffs.propose", "billing.policies.propose", "billing.payers.bind",
    "pricing.orders.accept", "finance.invoices.issue", "customers.read"]);
  await grant(checker, ["pricing.tariffs.approve", "billing.policies.approve"]);
  await grant(operator, ["customers.read", "customers.write", "pricing.read", "shipment.create", "shipment.view", "shipment.bookCarrier", "shipment.assignCourier", "shipment.changeStatus"]);
  await grant(driver, ["drivers.telemetry", "shipment.view", "shipment.update", "shipment.changeStatus"]);
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
it("real scoped master creation -> independently approved pricing -> normal order -> pickup/proof -> eligible same-currency invoice and original retries", async () => {
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
    content: syntheticBillingPolicy({ billing: { mode: "manual", eligibleOrderStates: ["pending", "picked_up"], dueDays: 7, numberPrefix: "SYNTHETIC" } }) });
  await decideBillingPolicy(checker, { versionId: policy.id, contentHash: policy.contentHash, operationId: randomUUID(), decision: "approved",
    reason: "Independent synthetic policy; pickup invoice eligibility is a test configuration, not company policy" });
  const body = { operationId: randomUUID(), customerEntityId: customer.id, sender: { name: "Synthetic sender" }, receiver: { name: "Synthetic recipient" },
    addresses: { pickupAddress: "Synthetic pickup", dropoffAddress: "Synthetic destination", senderAddressId: sender.id, receiverAddressId: receiver.id },
    shipment: { serviceType: "DOOR_TO_DOOR", currency: "UZS", weightKg: 2 }, payment: { paymentType: "OTHER", deliveryChargePaidBy: "COMPANY" } };
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
  await expect(updateDriverOrderStatus({ actor: driver, orderId, status: OrderStatus.out_for_delivery })).rejects.toThrow("Driver cannot move order");
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
  const issuance = { user: maker, ...intent(orderId), priceApprovalId: price.id }, invoice = await issueOrderInvoiceForActor(issuance);
  expect(invoice).toMatchObject({ status: "issued", amount: "110.0100", currency: "UZS", billing: { payerCustomerEntityId: payer.id, priceApprovalId: price.id } });
  const confirmed = await businessState();
  expect((await createOrderForActor({ user: operator, body })).payload).toMatchObject({ creationReplay: true, order: { id: orderId } });
  expect(await acceptOrderPrice(maker, acceptanceIntent)).toEqual(price);
  expect(await submitProofForActor(proofIntent)).toEqual(proof);
  expect(await issueOrderInvoiceForActor(issuance)).toEqual(invoice);
  expect(await businessState()).toEqual(confirmed);
  expect(await mockPrisma.order.count()).toBe(1);
  expect(await mockPrisma.invoice.count()).toBe(1);
  expect(await mockPrisma.orderCreationReceipt.count()).toBe(1);
  expect(await mockPrisma.orderPriceSnapshot.count()).toBe(1);
  expect(await mockPrisma.orderAttachment.count()).toBe(2);
  expect(await mockPrisma.orderLabelJob.count()).toBe(1);
  expect(await mockPrisma.billingInvoiceOutbox.count({ where: { state: "held_no_accounting_authority" } })).toBe(1);
  expect(await mockPrisma.financeJournalEntry.count()).toBe(0);
  expect(await mockPrisma.paymentIntent.count()).toBe(0);
  const notifications = await mockPrisma.userNotification.findMany();
  expect(notifications.length).toBeGreaterThan(0);
  for (const n of notifications) expect(n).toMatchObject({ userId: driver.id, tenantId: maker.tenantId, companyId: maker.companyId, companyMembershipId: driver.companyMembershipId });
  expect(mockStorage).toHaveBeenCalledTimes(2);
  expect(fetchSpy).not.toHaveBeenCalled(); expect(httpSpy).not.toHaveBeenCalled(); expect(httpsSpy).not.toHaveBeenCalled();
});
