jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_t, key) => { const value = (mockPrisma as any)[key]; return typeof value === "function" ? value.bind(mockPrisma) : value; } }) }));
jest.mock("../../src/config/redis", () => ({ getRedisClient: async () => null, getRedisPrefix: () => "synthetic", withRedisTimeout: (_n: any, work: any) => work() }));
jest.mock("../../src/modules/analytics-core/realtime/analyticsEvents", () => ({ buildCargoPilotDomainEvent: (input: any) => ({ ...input, id: require("crypto").randomUUID(), occurredAt: new Date().toISOString(), schemaVersion: 1 }) }));
import { Pool } from "pg";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { assignDriversBulk, updateOrdersStatusBulk, updateDriverOrderStatus } from "../../src/modules/orders-core/operations/order-status";
import { persistDispatchNotification, committedDispatchNotifications } from "../../src/modules/orders-core/domain/dispatch-notification";
const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL, runId = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !runId || !/^[a-f0-9]{12}$/.test(runId)) throw Error("Disposable batch identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${runId}`) throw Error("Refusing existing database");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000, options: "-c statement_timeout=5000" });
let mockPrisma: PrismaClient;
const driver: any = { id: ids.users.maker, membershipId: ids.companyMemberships.makerTransAsiaUz, companyMembershipId: ids.companyMemberships.makerTransAsiaUz, companyId: ids.organizations.transAsiaUz, tenantId: ids.tenants.transAsia, tenantMembershipId: ids.tenantMemberships.makerTransAsia };
const finance: any = { id: ids.users.multiTenant, membershipId: ids.companyMemberships.multiTransAsiaUz, companyMembershipId: ids.companyMemberships.multiTransAsiaUz, companyId: ids.organizations.transAsiaUz, tenantId: ids.tenants.transAsia, tenantMembershipId: ids.tenantMemberships.multiTransAsia };
const otherFinance = { ...finance, companyId: ids.organizations.transAsiaDe, membershipId: ids.companyMemberships.multiTransAsiaDe, companyMembershipId: ids.companyMemberships.multiTransAsiaDe };
const first = ids.orders.transAsiaUz, second = randomUUID();
const intent = () => ({ operationId: randomUUID(), companyId: finance.companyId, actorUserId: finance.id, code: randomUUID(), name: "SYNTHETIC ONLY", type: "asset" as const, allowPosting: false, isControlAccount: false });
const snapshot = async () => ({ orders: await mockPrisma.order.findMany({ orderBy: { id: "asc" } }), tracking: await mockPrisma.tracking.findMany({ orderBy: { id: "asc" } }), notifications: await mockPrisma.userNotification.findMany({ orderBy: { id: "asc" } }), analytics: await mockPrisma.analyticsDomainEventOutbox.findMany({ orderBy: { id: "asc" } }), accounts: await mockPrisma.financeAccount.findMany({ orderBy: { id: "asc" } }), audit: await mockPrisma.financeAuditEvent.findMany({ orderBy: { id: "asc" } }), finance: await mockPrisma.financeDomainEventOutbox.findMany({ orderBy: { id: "asc" } }) });
const expectations = async (list = [first, second]) => (await mockPrisma.order.findMany({ where: { id: { in: list } }, select: { id: true, updatedAt: true, status: true, assignedDriverId: true, currentWarehouseId: true } })).map(({ id, updatedAt, ...rest }) => ({ orderId: id, updatedAt: updatedAt.toISOString(), ...rest }));
beforeAll(async () => {
  const marker = await pool.query('SELECT "runId" FROM "_CPDisposableRun"'); if (marker.rows.length !== 1 || marker.rows[0].runId !== runId) throw Error("Storage identity mismatch");
  const client = await pool.connect(); try { await client.query("BEGIN"); await persistTenantDemoFixture(client, createTenantDemoFixture()); await client.query("COMMIT"); } finally { client.release(); }
  mockPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 6, connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000" }) });
  for (const [who, keys] of [[driver, ["shipment.assignCourier", "shipment.changeStatus", "drivers.telemetry"]], [finance, ["finance.accounts.manage"]], [otherFinance, ["finance.accounts.manage"]]] as const) {
    const role = await mockPrisma.role.create({ data: { companyId: who.companyId, code: randomUUID(), name: "Synthetic batch role" } });
    for (const key of keys) { const permission = await mockPrisma.permission.upsert({ where: { key }, create: { key, resource: "synthetic", action: "test" }, update: {} }); await mockPrisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } }); }
    await mockPrisma.membershipRole.create({ data: { membershipId: who.membershipId, roleId: role.id } });
    if (!await mockPrisma.membershipScope.findFirst({ where: { membershipId: who.membershipId, scopeType: "company", scopeRefId: who.companyId } })) await mockPrisma.membershipScope.create({ data: { membershipId: who.membershipId, scopeType: "company", scopeRefId: who.companyId } });
  }
  await mockPrisma.user.update({ where: { id: driver.id }, data: { driverType: "local" } });
  const order = await mockPrisma.order.findUniqueOrThrow({ where: { id: first } }); await mockPrisma.order.create({ data: { ...order, id: second, orderNumber: `synthetic-batch-${runId}` } as any });
}, 60000);
afterAll(async () => { await mockPrisma?.$disconnect(); await pool.end(); });
beforeEach(async () => { await mockPrisma.order.updateMany({ where: { id: { in: [first, second] } }, data: { status: "assigned", assignedDriverId: driver.id, codAmount: 0, serviceCharge: 0, deliveryChargePaidBy: "SENDER", currentWarehouseId: null } }); });

it.each(["assignment", "bulk-status", "single-status"])("native %s commits eligible notification, Tracking and analytics exactly once", async kind => {
  if (kind === "assignment") await mockPrisma.order.updateMany({ where: { id: { in: [first, second] } }, data: { status: "pending", assignedDriverId: null } });
  const before = await snapshot();
  const result = kind === "assignment" ? await assignDriversBulk({ actor: driver, orderIds: [first, second], expectedStates: await expectations(), driverId: driver.id }) : kind === "bulk-status" ? await updateOrdersStatusBulk({ actor: driver, orderIds: [first, second], expectedStates: await expectations(), status: "pickup_in_progress" }) : await updateDriverOrderStatus({ actor: driver, orderId: first, status: "pickup_in_progress" });
  const after = await snapshot(), count = kind === "single-status" ? 1 : 2;
  expect(after.notifications.length - before.notifications.length).toBe(count); expect(after.tracking.length - before.tracking.length).toBe(count); expect(after.analytics.length - before.analytics.length).toBe(count);
  expect(committedDispatchNotifications(result!)).toHaveLength(count);
  for (const row of after.notifications.slice().filter(n => !before.notifications.some(old => old.id === n.id))) { expect(row.companyMembershipId).toBe(driver.membershipId); expect(row.tenantId).toBe(driver.tenantId); expect(row.companyId).toBe(driver.companyId); expect(after.tracking.find(t => t.id === row.dispatchTrackingId)?.orderId).toBe(row.orderId); }
  if (kind === "assignment") { const confirmed = await snapshot(); await assignDriversBulk({ actor: driver, orderIds: [first, second], expectedStates: await expectations(), driverId: driver.id }); expect(await snapshot()).toEqual(confirmed); }
});
it("native concurrent matching dispatch accepts one batch without duplicate notification effects", async () => {
  const expectedStates = await expectations(), before = await snapshot();
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => updateOrdersStatusBulk({ actor: driver, orderIds: [first, second], expectedStates, status: "pickup_in_progress" })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); const after = await snapshot(); expect(after.notifications.length - before.notifications.length).toBe(2); expect(after.tracking.length - before.tracking.length).toBe(2); expect(after.analytics.length - before.analytics.length).toBe(2);
});
it("native second notification failure rolls back the complete covered batch", async () => {
  const before = await snapshot(); await pool.query(`CREATE FUNCTION cp_batch_notification_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."orderId"='${second}' THEN RAISE EXCEPTION 'synthetic notification failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cp_batch_notification_fail BEFORE INSERT ON "UserNotification" FOR EACH ROW EXECUTE FUNCTION cp_batch_notification_fail();`);
  try { await expect(updateOrdersStatusBulk({ actor: driver, orderIds: [first, second], expectedStates: await expectations(), status: "pickup_in_progress" })).rejects.toThrow("notification failure"); expect(await snapshot()).toEqual(before); } finally { await pool.query('DROP TRIGGER cp_batch_notification_fail ON "UserNotification"; DROP FUNCTION cp_batch_notification_fail();'); }
});
it.each([ids.orders.transAsiaDe, ids.orders.unrelated])("native foreign dispatch parent %s has no business effects", async orderId => { const before = await snapshot(); await expect(updateDriverOrderStatus({ actor: driver, orderId, status: "pickup_in_progress" })).rejects.toThrow(); expect(await snapshot()).toEqual(before); });
it("native revoked context cannot mutate or create a notification", async () => {
  // Keep actor authorization separate: driver may act through assigned company; owner-company membership is suspended.
  const own = await mockPrisma.companyMembership.findUniqueOrThrow({ where: { id: driver.membershipId } });
  await mockPrisma.companyMembership.update({ where: { id: own.id }, data: { status: "suspended" } });
  try { const before = await snapshot(); await expect(updateDriverOrderStatus({ actor: driver, orderId: first, status: "pickup_in_progress" })).rejects.toThrow(); expect(await snapshot()).toEqual(before); } finally { await mockPrisma.companyMembership.update({ where: { id: own.id }, data: { status: "active" } }); }
});
it("native source retry, immutable retargeting, child FK and recipient uniqueness", async () => {
  const result = await updateDriverOrderStatus({ actor: driver, orderId: first, status: "pickup_in_progress" }); const id = committedDispatchNotifications(result!)[0]; const row = await mockPrisma.userNotification.findUniqueOrThrow({ where: { id } }); const before = await snapshot();
  await mockPrisma.$transaction(async tx => { await tx.order.findUniqueOrThrow({ where: { id: first } }); expect(await persistDispatchNotification(tx, row.dispatchTrackingId!, "status")).toBe(id); }); expect(await snapshot()).toEqual(before);
  for (const data of [{ title: "retarget" }, { dispatchTrackingId: null }, { orderId: second }]) { await expect(mockPrisma.userNotification.update({ where: { id }, data })).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  const { id: _id, ...data } = row;
  for (const patch of [{}, { orderId: second, companyMembershipId: ids.companyMemberships.multiTransAsiaUz, userId: finance.id }, { tenantId: ids.tenants.unrelated }]) { await expect(mockPrisma.userNotification.create({ data: { ...data, ...patch, data: Prisma.JsonNull } })).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
  await mockPrisma.userNotification.update({ where: { id }, data: { readAt: new Date() } });
  // Existing retention deletion is intentionally retained; no promise of an indefinite delivery ledger.
  await mockPrisma.userNotification.delete({ where: { id } });
});

it("native schema/SQL catalog, source FK, completeness and no legacy adoption agree",async()=>{
 const catalog=(await pool.query('SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ANY($1)',[["UserNotification_dispatch_source_fkey","UserNotification_dispatch_complete_check"]])).rows;
 expect(catalog).toHaveLength(2);expect(catalog.filter(row=>row.conname.startsWith("UserNotification_")).every(row=>!row.convalidated)).toBe(true);
 expect(catalog.find(row=>row.conname==="UserNotification_dispatch_source_fkey").definition).toContain('REFERENCES "Tracking"(id, "orderId")');
 const source=await mockPrisma.tracking.create({data:{orderId:first,status:"assigned"}});
 const legacy=await mockPrisma.userNotification.create({data:{userId:driver.id,tenantId:driver.tenantId,companyId:driver.companyId,companyMembershipId:driver.membershipId,type:"order",orderId:first,title:"Synthetic",body:"Synthetic"}});
 const before=await snapshot();await expect(mockPrisma.userNotification.update({where:{id:legacy.id},data:{dispatchTrackingId:source.id}})).rejects.toThrow();expect(await snapshot()).toEqual(before);
 const insert=(orderId:any,tenantId:any)=>pool.query('INSERT INTO "UserNotification" ("userId","tenantId","companyId","companyMembershipId",type,title,body,"orderId","dispatchTrackingId") VALUES ($1,$2,$3,$4,$7,$8,$9,$5,$6)',[driver.id,tenantId,driver.companyId,driver.membershipId,orderId,source.id,"order","Synthetic","Synthetic"]);
 await expect(insert(second,driver.tenantId)).rejects.toMatchObject({code:"23503",constraint:"UserNotification_dispatch_source_fkey"});expect(await snapshot()).toEqual(before);
 await expect(insert(null,driver.tenantId)).rejects.toMatchObject({code:"23514",constraint:"UserNotification_dispatch_complete_check"});expect(await snapshot()).toEqual(before);
});
it("native suspended ownership and removed recipient permission suppress accepted source without notifications",async()=>{
 const source=await mockPrisma.tracking.create({data:{orderId:first,status:"assigned"}}),before=await snapshot();
 const permission=await mockPrisma.permission.findUniqueOrThrow({where:{key:"drivers.telemetry"}}),link=await mockPrisma.rolePermission.findFirstOrThrow({where:{permissionId:permission.id,role:{membershipRoles:{some:{membershipId:driver.membershipId}}}}});
 await mockPrisma.rolePermission.delete({where:{id:link.id}});
 try{expect(await mockPrisma.$transaction(tx=>persistDispatchNotification(tx,source.id,"status"))).toBeNull();expect(await snapshot()).toEqual(before);}finally{await mockPrisma.rolePermission.create({data:link});}
 await mockPrisma.tenant.update({where:{id:driver.tenantId},data:{status:"suspended"}});
 try{expect(await mockPrisma.$transaction(tx=>persistDispatchNotification(tx,source.id,"status"))).toBeNull();expect(await snapshot()).toEqual(before);}finally{await mockPrisma.tenant.update({where:{id:driver.tenantId},data:{status:"active"}});}
 const original=await mockPrisma.order.findUniqueOrThrow({where:{id:first}}),foreignOwner=await mockPrisma.order.create({data:{...original,id:randomUUID(),orderNumber:"Synthetic non-owner recipient "+randomUUID(),ownerOrgId:ids.organizations.transAsiaDe,assignedOrgId:driver.companyId} as any});
 const foreignSource=await mockPrisma.tracking.create({data:{orderId:foreignOwner.id,status:"assigned"}}),foreignBefore=await snapshot();
 expect(await mockPrisma.$transaction(tx=>persistDispatchNotification(tx,foreignSource.id,"status"))).toBeNull();expect(await snapshot()).toEqual(foreignBefore);
});
