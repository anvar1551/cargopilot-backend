jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => (mockPrisma as any)[name] }) }));
import { Pool } from "pg";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { collectOrderCash, handoffOrderCash, settleOrderCash } from "../../src/modules/orders-core/cash/custody.service";
import { lockOnlineCashReconciliation } from "../../src/modules/orders-core/cash/cash-authority";
import { listCashQueueForActor, getCashQueueSummaryForActor } from "../../src/modules/orders-core/cash/collection.service";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL;
const runId = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !runId || !/^[a-f0-9]{12}$/.test(runId)) throw new Error("Disposable cash instance identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${runId}`) throw new Error("Refusing non-disposable cash PostgreSQL target");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000, options: "-c statement_timeout=5000" });
let mockPrisma: PrismaClient, orderId: string;
const maker: any = { id: ids.users.maker, tenantId: ids.tenants.transAsia, tenantMembershipId: ids.tenantMemberships.makerTransAsia,
  companyId: ids.organizations.transAsiaUz, companyMembershipId: ids.companyMemberships.makerTransAsiaUz, membershipId: ids.companyMemberships.makerTransAsiaUz };
const checker: any = { ...maker, id: ids.users.checker, tenantMembershipId: ids.tenantMemberships.checkerTransAsia,
  companyMembershipId: ids.companyMemberships.checkerTransAsiaUz, membershipId: ids.companyMemberships.checkerTransAsiaUz };
const collect = (operationId = "collect-operation") => ({ actor: maker, orderId, kind: "cod" as const, operationId });
const currentId = (result: any) => result.cashCollections[0].events[0].id;
const handoff = (expectedEventId: string, operationId = "handoff-operation") => ({ ...collect(operationId), expectedEventId, toHolderType: "warehouse" as const, toWarehouseId: ids.warehouses.transAsiaUz });
const settle = (expectedEventId: string, operationId = "settle-operation") => ({ ...collect(operationId), actor: checker, expectedEventId });
beforeAll(async () => {
  const identity = await pool.query('SELECT "runId" FROM "_CPDisposableRun"');
  if (identity.rows.length !== 1 || identity.rows[0].runId !== runId) throw new Error("Disposable storage ownership mismatch");
  const client = await pool.connect();
  try { await client.query("BEGIN"); await persistTenantDemoFixture(client, createTenantDemoFixture()); await client.query("COMMIT"); }
  finally { client.release(); }
  mockPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 8, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000" }) });
  await mockPrisma.user.update({ where: { id: maker.id }, data: { driverType: "local" } });
  await mockPrisma.user.update({ where: { id: checker.id }, data: { warehouseId: ids.warehouses.transAsiaUz } });
  const role = await mockPrisma.role.create({ data: { companyId: maker.companyId, code: "synthetic_cash", name: "Synthetic cash role" } });
  for (const key of ["shipment.update", "shipment.view", "finance.settleCash"]) {
    const permission = await mockPrisma.permission.create({ data: { key, resource: "synthetic_cash", action: key } });
    await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  for (const actor of [maker, checker]) {
    await mockPrisma.membershipRole.create({ data: { membershipId: actor.membershipId, roleId: role.id } });
    for (const [scopeType, scopeRefId] of [["company", maker.companyId], ["warehouse", ids.warehouses.transAsiaUz], ["warehouse", ids.warehouses.transAsiaDe], ["warehouse", ids.warehouses.unrelated]] as const) {
      await mockPrisma.membershipScope.create({ data: { membershipId: actor.membershipId, scopeType, scopeRefId } });
    }
  }
});
beforeEach(async () => {
  orderId = randomUUID();
  await mockPrisma.order.create({ data: { id: orderId, orderNumber: `SYNTHETIC-${orderId}`, customerId: ids.users.multiTenant,
    tenantId: maker.tenantId, ownerOrgId: maker.companyId, currentWarehouseId: ids.warehouses.transAsiaUz,
    assignedDriverId: maker.id, pickupAddress: "Synthetic pickup", dropoffAddress: "Synthetic dropoff",
    status: "in_transit", codAmount: 100.25, codPaidStatus: "NOT_PAID", currency: "USD",
    pricingComponents: { create: { componentType: "other", amount: "100.25", currency: "USD", fxRateSnapshot: "2", baseCurrency: "UZS" } } } });
});
afterAll(async () => { await mockPrisma?.$disconnect(); await pool.end(); });
async function snapshot() {
  return { order: await mockPrisma.order.findUnique({ where: { id: orderId } }),
    collections: await mockPrisma.cashCollection.findMany({ where: { orderId }, include: { events: true } }),
    operations: await mockPrisma.cashCustodyOperation.findMany({ where: { orderId } }),
    outboxes: await mockPrisma.analyticsDomainEventOutbox.findMany({ where: { entityId: orderId } }) };
}
async function unchanged(work: () => Promise<unknown>) {
  const before = await snapshot(); await expect(work()).rejects.toBeDefined(); expect(await snapshot()).toEqual(before);
}
function uniqueKey(label: string) { return `${label}:${orderId}`; }
it("valid collection, handoff and separate-checker settlement conserve exact custody and durable events", async () => {
  const input = collect(uniqueKey("collect"));
  const a = await collectOrderCash(input), b = await handoffOrderCash(handoff(currentId(a), uniqueKey("handoff")));
  const c = await settleOrderCash(settle(currentId(b), uniqueKey("settle")));
  const beforeRetry = await snapshot();
  expect(await collectOrderCash(input)).toEqual(a);
  expect(await snapshot()).toEqual(beforeRetry);
  expect(c.cashCollections[0]).toMatchObject({ status: "settled", currentHolderType: "finance", currentHolderUserId: null, currentHolderWarehouseId: null, collectedAmount: "100.25" });
  expect(beforeRetry.collections[0]).toMatchObject({ expectedAmount: 100.25, collectedAmount: 100.25, status: "settled" });
  expect(beforeRetry.collections[0].events.map(e => e.eventType)).toEqual(expect.arrayContaining(["collected", "handoff", "settled"]));
  expect(beforeRetry.operations).toHaveLength(3); expect(beforeRetry.outboxes).toHaveLength(6);
  expect(beforeRetry.operations.every(op => op.amount.toString() === "100.25" && op.currency === "USD" && op.companyId === maker.companyId)).toBe(true);
});
it("concurrent matching collections return one result and commit only one monetary operation", async () => {
  const input = collect(uniqueKey("duplicate"));
  const results = await Promise.all([collectOrderCash(input), collectOrderCash(input)]);
  expect(results[0]).toEqual(results[1]);
  const state = await snapshot(); expect(state.operations).toHaveLength(1); expect(state.collections[0].events).toHaveLength(1); expect(state.outboxes).toHaveLength(2);
  expect(state.collections[0]).toMatchObject({ collectedAmount: 100.25, status: "held", currentHolderUserId: maker.id });
});
it("competing collections with different identities cannot double collect", async () => {
  const results = await Promise.allSettled([collectOrderCash(collect(uniqueKey("first"))), collectOrderCash(collect(uniqueKey("second")))]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const state = await snapshot(); expect(state.operations).toHaveLength(1); expect(state.outboxes).toHaveLength(2); expect(state.collections[0].collectedAmount).toBe(100.25);
});
it("concurrent matching handoffs and settlements retain one event per transition", async () => {
  const a = await collectOrderCash(collect(uniqueKey("collect")));
  const request = handoff(currentId(a), uniqueKey("handoff"));
  const bs = await Promise.all([handoffOrderCash(request), handoffOrderCash(request)]); expect(bs[0]).toEqual(bs[1]);
  const end = settle(currentId(bs[0]), uniqueKey("settle"));
  const cs = await Promise.all([settleOrderCash(end), settleOrderCash(end)]); expect(cs[0]).toEqual(cs[1]);
  const state = await snapshot(); expect(state.operations).toHaveLength(3); expect(state.outboxes).toHaveLength(6); expect(state.collections[0]).toMatchObject({ status: "settled", currentHolderType: "finance", collectedAmount: 100.25 });
});
it("incompatible handoff and settlement serialize; stale expected custody cannot also succeed", async () => {
  const a = await collectOrderCash(collect(uniqueKey("collect")));
  const results = await Promise.allSettled([handoffOrderCash(handoff(currentId(a), uniqueKey("handoff"))), settleOrderCash(settle(currentId(a), uniqueKey("settle")))]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const state = await snapshot(); expect(state.operations).toHaveLength(2); expect(state.outboxes).toHaveLength(4);
  expect(state.collections[0].collectedAmount).toBe(100.25);
  expect(["held", "settled"]).toContain(state.collections[0].status);
  if (state.collections[0].status === "held") expect(state.collections[0].currentHolderWarehouseId).toBe(ids.warehouses.transAsiaUz);
  else expect(state.collections[0]).toMatchObject({ currentHolderType: "finance", currentHolderUserId: null, currentHolderWarehouseId: null });
});
it("foreign ownership, manipulated money, mismatched context and maker-checker violations leave records unchanged", async () => {
  await unchanged(() => collectOrderCash({ ...collect(uniqueKey("amount")), amount: 1 }));
  await unchanged(() => collectOrderCash({ ...collect(uniqueKey("context")), actor: { ...maker, tenantId: ids.tenants.unrelated } }));
  for (const foreignId of [ids.orders.unrelated, ids.orders.transAsiaDe]) {
    const original = await mockPrisma.order.findUnique({ where: { id: foreignId } });
    await unchanged(() => collectOrderCash({ ...collect(uniqueKey("foreign")), orderId: foreignId }));
    expect(await mockPrisma.order.findUnique({ where: { id: foreignId } })).toEqual(original);
  }
  const a = await collectOrderCash(collect(uniqueKey("collect")));
  await unchanged(() => collectOrderCash({ ...collect(uniqueKey("collect")), note: "conflict" }));
  await unchanged(() => settleOrderCash({ ...settle(currentId(a), uniqueKey("self")), actor: maker }));
  await unchanged(() => handoffOrderCash({ ...handoff(currentId(a), uniqueKey("foreign-warehouse")), toWarehouseId: ids.warehouses.unrelated }));
  await unchanged(() => handoffOrderCash({ ...handoff(currentId(a), uniqueKey("wrong-custodian")), actor: checker }));
  await unchanged(() => handoffOrderCash({ ...handoff(currentId(a), uniqueKey("wrong-driver")), toHolderType: "driver", toWarehouseId: null, toDriverId: ids.users.multiTenant }));
});
it("permission removal, suspended membership and changed assignment fail closed without effects", async () => {
  await mockPrisma.companyMembership.update({ where: { id: maker.membershipId }, data: { status: "suspended" } });
  try { await unchanged(() => collectOrderCash(collect(uniqueKey("suspended")))); }
  finally { await mockPrisma.companyMembership.update({ where: { id: maker.membershipId }, data: { status: "active" } }); }
  await mockPrisma.order.update({ where: { id: orderId }, data: { assignedDriverId: checker.id } });
  await unchanged(() => collectOrderCash(collect(uniqueKey("wrong-assignment"))));
  const roles = await mockPrisma.membershipRole.findMany({ where: { membershipId: maker.membershipId } });
  await mockPrisma.membershipRole.deleteMany({ where: { membershipId: maker.membershipId } });
  try { await unchanged(() => collectOrderCash(collect(uniqueKey("permission")))); }
  finally { await mockPrisma.membershipRole.createMany({ data: roles.map(r => ({ membershipId: r.membershipId, roleId: r.roleId })) }); }
});
it("receipt constraints reject foreign company and wrong collection/event references on insert and update", async () => {
  await collectOrderCash(collect(uniqueKey("collect")));
  const op = await mockPrisma.cashCustodyOperation.findFirstOrThrow({ where: { orderId } });
  await expect(mockPrisma.cashCustodyOperation.update({ where: { id: op.id }, data: { companyId: ids.organizations.transAsiaDe } })).rejects.toBeDefined();
  await expect(mockPrisma.cashCustodyOperation.update({ where: { id: op.id }, data: { actorId: checker.id } })).rejects.toBeDefined();
  await expect(mockPrisma.cashCustodyOperation.create({ data: { ...op, resultJson: op.resultJson as Prisma.InputJsonValue, id: randomUUID(), operationKey: uniqueKey("foreign-insert"), eventId: randomUUID(), orderId: ids.orders.unrelated } })).rejects.toBeDefined();
  expect(await mockPrisma.cashCustodyOperation.findUnique({ where: { id: op.id } })).toEqual(op);
});
it("legacy held custody and online reconciliation conflicts remain contained", async () => {
  const legacy = await mockPrisma.cashCollection.create({ data: { orderId, kind: "service_charge", expectedAmount: 10, collectedAmount: 10,
    currency: "USD", status: "held", currentHolderType: "driver", currentHolderUserId: maker.id,
    events: { create: { eventType: "collected", amount: 10, actorId: maker.id } } } });
  const latest = await mockPrisma.cashCollectionEvent.findFirstOrThrow({ where: { cashCollectionId: legacy.id } });
  await unchanged(() => handoffOrderCash({ ...handoff(latest.id, uniqueKey("legacy")), kind: "service_charge" }));
  await unchanged(() => mockPrisma.$transaction(async tx => { await lockOnlineCashReconciliation(tx, orderId); await tx.cashCollection.update({ where: { id: legacy.id }, data: { status: "settled" } }); }));
});
it("durable-event failure rolls back collection, paid state and operation receipt", async () => {
  await pool.query(`CREATE FUNCTION cp_reject_cash_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."entityId" = '${orderId}' THEN RAISE EXCEPTION 'Synthetic cash outbox rejection'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER cp_reject_cash_outbox BEFORE INSERT ON "AnalyticsDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION cp_reject_cash_outbox();`);
  try { await unchanged(() => collectOrderCash(collect(uniqueKey("rollback")))); }
  finally { await pool.query('DROP TRIGGER cp_reject_cash_outbox ON "AnalyticsDomainEventOutbox"; DROP FUNCTION cp_reject_cash_outbox();'); }
});
it("cash queue and summary enforce tenant/company context", async () => {
  await collectOrderCash(collect(uniqueKey("collect")));
  const foreignUser = await mockPrisma.user.create({ data: { name: "Synthetic unbound driver", email: `${orderId}@example.invalid`, password: "synthetic-not-a-login", driverType: "local" } });
  const foreignCustody = await mockPrisma.cashCollection.create({ data: { orderId, kind: "service_charge", expectedAmount: 999,
    collectedAmount: 999, currency: "USD", status: "held", currentHolderType: "driver", currentHolderUserId: foreignUser.id } });
  const rows = await listCashQueueForActor({ actor: maker });
  expect(rows.items.some(row => row.orderId === orderId)).toBe(true);
  expect(rows.items.every(row => ![ids.orders.unrelated, ids.orders.transAsiaDe].includes(row.orderId as any))).toBe(true);
  expect(rows.items.some(row => row.id === foreignCustody.id)).toBe(false);
  const summary = await getCashQueueSummaryForActor({ actor: maker }); expect(summary.heldAmount).toBeGreaterThanOrEqual(100.25);
  expect(summary.heldAmount).toBeLessThan(999);
  await expect(listCashQueueForActor({ actor: { ...maker, tenantId: null } })).rejects.toBeDefined();
});
it("schema correspondence: receipt columns, unique targets and compound foreign keys exist in PostgreSQL", async () => {
  const columns = await pool.query(`SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = 'CashCustodyOperation'`);
  expect(columns.rows.find(c => c.column_name === "amount")).toMatchObject({ data_type: "numeric", is_nullable: "NO", numeric_precision: 20, numeric_scale: 4 });
  for (const field of ["tenantId", "companyId", "orderId", "collectionId", "eventId", "actorId", "companyMembershipId", "operationKey", "action", "fingerprint", "currency", "resultJson"]) expect(columns.rows.find(c => c.column_name === field)?.is_nullable).toBe("NO");
  const constraints = await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"CashCustodyOperation"'::regclass`);
  expect(constraints.rows.find(c => c.conname === "CashCustodyOperation_order_owner_fkey").definition).toContain('FOREIGN KEY ("tenantId", "orderId", "companyId") REFERENCES "Order"("tenantId", id, "ownerOrgId")');
  for (const name of ["CashCustodyOperation_order_owner_fkey", "CashCustodyOperation_collection_fkey", "CashCustodyOperation_event_fkey", "CashCustodyOperation_actor_context_fkey"]) {
    expect(constraints.rows.find(c => c.conname === name).definition).toMatch(/ON UPDATE RESTRICT ON DELETE RESTRICT/);
  }
  const indexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'CashCustodyOperation'`);
  expect(indexes.rows.map(r => r.indexname)).toEqual(expect.arrayContaining(["CashCustodyOperation_eventId_key", "CashCustodyOperation_tenantId_companyId_operationKey_key", "CashCustodyOperation_event_identity_key", "CashCustodyOperation_tenantId_companyId_orderId_createdAt_idx"]));
});
it("known wrong custody child references are rejected without changing receipts", async () => {
  await collectOrderCash(collect(uniqueKey("collect")));
  const op = await mockPrisma.cashCustodyOperation.findFirstOrThrow({ where: { orderId } });
  const other = await mockPrisma.cashCollection.create({ data: { orderId: ids.orders.transAsiaDe, kind: "cod", expectedAmount: 20, currency: "EUR",
    events: { create: { eventType: "expected", amount: 20 } } } });
  const event = await mockPrisma.cashCollectionEvent.findFirstOrThrow({ where: { cashCollectionId: other.id } });
  await expect(mockPrisma.cashCustodyOperation.update({ where: { id: op.id }, data: { collectionId: other.id } })).rejects.toBeDefined();
  await expect(mockPrisma.cashCustodyOperation.update({ where: { id: op.id }, data: { eventId: event.id } })).rejects.toBeDefined();
  expect(await mockPrisma.cashCustodyOperation.findUnique({ where: { id: op.id } })).toEqual(op);
});
it("service-charge cash remains authorized while monetary and invalid-state inputs fail closed", async () => {
  await mockPrisma.order.update({ where: { id: orderId }, data: { serviceCharge: 10.5, serviceChargePaidStatus: "NOT_PAID", deliveryChargePaidBy: "SENDER", paymentType: "CASH" } });
  const input = { ...collect(uniqueKey("service-charge")), kind: "service_charge" as const };
  await unchanged(() => settleOrderCash({ ...input, actor: checker, operationId: uniqueKey("premature"), expectedEventId: randomUUID() }));
  const a = await collectOrderCash(input);
  expect(a.cashCollections[0].collectedAmount).toBe("10.5");
  expect((await snapshot()).order?.serviceChargePaidStatus).toBe("PAID");
  await unchanged(() => collectOrderCash({ ...input, operationId: uniqueKey("second-charge") }));
  await mockPrisma.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
  await unchanged(() => handoffOrderCash({ ...handoff(currentId(a), uniqueKey("cancelled")), kind: "service_charge" }));
});
