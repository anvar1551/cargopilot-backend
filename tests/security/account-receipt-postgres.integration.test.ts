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
import { prismaFinanceRepository as repo } from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";
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
const snapshot = async () => ({ orders: await mockPrisma.order.findMany({ orderBy: { id: "asc" } }), tracking: await mockPrisma.tracking.findMany({ orderBy: { id: "asc" } }), notifications: await mockPrisma.userNotification.findMany({ orderBy: { id: "asc" } }), analytics: await mockPrisma.analyticsDomainEventOutbox.findMany({ orderBy: { id: "asc" } }), accounts: await mockPrisma.financeAccount.findMany({ orderBy: { id: "asc" } }), receipts: await mockPrisma.financeAccountCreationReceipt.findMany({ orderBy: { operationId: "asc" } }), audit: await mockPrisma.financeAuditEvent.findMany({ orderBy: { id: "asc" } }), finance: await mockPrisma.financeDomainEventOutbox.findMany({ orderBy: { id: "asc" } }) });
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

it("native concurrent normalized account retries produce one account/receipt/audit/outbox and original result", async () => {
  const input = intent(), before = await snapshot(); const results = await Promise.all([repo.createAccount(input, finance), repo.createAccount({ ...input, name: ` ${input.name} ` }, finance), repo.createAccount(input, finance)]);
  expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]); const after = await snapshot();
  for (const key of ["accounts", "receipts", "audit", "finance"] as const) expect(after[key].length - before[key].length).toBe(1);
  const confirmed = await snapshot(); expect(await repo.createAccount(input, finance)).toEqual(results[0]); expect(await snapshot()).toEqual(confirmed);
});
it.each(["content", "company", "tenant", "permission", "scope", "revoked", "missing", "unknown", "id"])("native account %s rejects without business effects", async kind => {
  const input = intent(); await repo.createAccount(input, finance); let who: any = finance, changed: any = { ...input }, restore: (() => Promise<any>) | undefined;
  if (kind === "content") changed.name = "other intent";
  if (kind === "company") { who = otherFinance; changed.companyId = who.companyId; }
  if (kind === "tenant") { who = { ...finance, tenantId: ids.tenants.unrelated }; }
  if (kind === "missing") who = undefined;
  if (kind === "unknown") changed.ownerId = finance.id;
  if (kind === "id") delete changed.operationId;
  if (kind === "revoked") { await mockPrisma.companyMembership.update({ where: { id: finance.membershipId }, data: { status: "suspended" } }); restore = () => mockPrisma.companyMembership.update({ where: { id: finance.membershipId }, data: { status: "active" } }); }
  if (kind === "scope") { const scope = await mockPrisma.membershipScope.findFirstOrThrow({ where: { membershipId: finance.membershipId, scopeType: "company", scopeRefId: finance.companyId } }); await mockPrisma.membershipScope.delete({ where: { id: scope.id } }); restore = () => mockPrisma.membershipScope.create({ data: scope }); }
  if (kind === "permission") { const link = await mockPrisma.membershipRole.findFirstOrThrow({ where: { membershipId: finance.membershipId } }); await mockPrisma.membershipRole.delete({ where: { id: link.id } }); restore = () => mockPrisma.membershipRole.create({ data: link }); }
  const before = await snapshot(); try { await expect(repo.createAccount(changed, who)).rejects.toThrow(); expect(await snapshot()).toEqual(before); } finally { if (restore) await restore(); }
});
it.each(["receipt", "outbox"])("native account %s insertion failure rolls back all financial state", async table => {
  const name = table === "receipt" ? "FinanceAccountCreationReceipt" : "FinanceDomainEventOutbox", before = await snapshot(); await pool.query(`CREATE FUNCTION cp_account_batch_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic account batch failure'; END $$; CREATE TRIGGER cp_account_batch_fail BEFORE INSERT ON "${name}" FOR EACH ROW EXECUTE FUNCTION cp_account_batch_fail();`);
  try { await expect(repo.createAccount(intent(), finance)).rejects.toThrow("account batch failure"); expect(await snapshot()).toEqual(before); } finally { await pool.query(`DROP TRIGGER cp_account_batch_fail ON "${name}"; DROP FUNCTION cp_account_batch_fail();`); }
});
it("native account receipt immutability and duplicate result uniqueness reject", async () => {
  const input = intent(); await repo.createAccount(input, finance); const row = await mockPrisma.financeAccountCreationReceipt.findUniqueOrThrow({ where: { operationId: input.operationId } }), before = await snapshot();
  await expect(mockPrisma.financeAccountCreationReceipt.update({ where: { operationId: row.operationId }, data: { requestHash: "0".repeat(64) } })).rejects.toThrow(); await expect(mockPrisma.financeAccountCreationReceipt.delete({ where: { operationId: row.operationId } })).rejects.toThrow();
  for (const patch of [{ tenantId: ids.tenants.unrelated }, { actorUserId: ids.users.checker }, { legalEntityId: ids.legalEntities.transAsiaDe, companyId: ids.organizations.transAsiaDe, companyMembershipId: otherFinance.membershipId }, { tenantMembershipId: ids.tenantMemberships.checkerTransAsia }]) { await expect(mockPrisma.financeAccountCreationReceipt.create({ data: { ...row, operationId: randomUUID(), ...patch, resultJson: row.resultJson as Prisma.InputJsonValue } })).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
});

it("native receipt compound FKs reject exact foreign bridges rather than duplicate account uniqueness",async()=>{
 const account=await mockPrisma.financeAccount.create({data:{legalEntityId:ids.legalEntities.transAsiaUz,code:randomUUID(),name:"Synthetic FK-only fixture",type:"asset",allowPosting:false}});
 const base:any={tenantId:finance.tenantId,companyId:finance.companyId,legalEntityId:ids.legalEntities.transAsiaUz,actorUserId:finance.id,tenantMembershipId:finance.tenantMembershipId,companyMembershipId:finance.membershipId,accountId:account.id};
 const before=await snapshot();
 const insert=(patch:any)=>{const value={...base,...patch};return pool.query('INSERT INTO "FinanceAccountCreationReceipt" ("operationId","tenantId","companyId","legalEntityId","actorUserId","tenantMembershipId","companyMembershipId","accountId","requestHash","resultJson") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),value.tenantId,value.companyId,value.legalEntityId,value.actorUserId,value.tenantMembershipId,value.companyMembershipId,value.accountId,"0".repeat(64),JSON.stringify({id:value.accountId,legalEntityId:value.legalEntityId})]);};
 for(const patch of [{tenantId:ids.tenants.unrelated},{actorUserId:ids.users.checker},{tenantMembershipId:ids.tenantMemberships.checkerTransAsia}]){await expect(insert(patch)).rejects.toMatchObject({code:"23503"});expect(await snapshot()).toEqual(before);}
 await expect(insert({legalEntityId:ids.legalEntities.transAsiaDe,companyId:otherFinance.companyId,companyMembershipId:otherFinance.membershipId})).rejects.toMatchObject({code:"23503",constraint:"AccountReceipt_account_fkey"});expect(await snapshot()).toEqual(before);
});
it("native concurrent conflicting account reuse commits exactly one intent",async()=>{
 const input=intent(),before=await snapshot();const results=await Promise.allSettled([repo.createAccount(input,finance),repo.createAccount({...input,name:"Different synthetic intent"},finance)]);expect(results.filter(row=>row.status==="fulfilled")).toHaveLength(1);expect(results.filter(row=>row.status==="rejected")).toHaveLength(1);
 const after=await snapshot();for(const key of ["accounts","receipts","audit","finance"] as const)expect(after[key].length-before[key].length).toBe(1);
});

it("native observed operation lock wait revalidates revoked account receipt before return",async()=>{
 const input=intent();await repo.createAccount(input,finance);const before=await snapshot(),held=await pool.connect();let released=false,pending:Promise<unknown>|undefined;
 try{await held.query("BEGIN");await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1,41016))",[input.operationId]);pending=repo.createAccount(input,finance);pending.catch(()=>undefined);
  let observed=false;for(let n=0;n<20;n++){const waiting=await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%account_intent_lock%'");if(waiting.rows[0].count){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}expect(observed).toBe(true);
  await mockPrisma.companyMembership.update({where:{id:finance.membershipId},data:{status:"suspended"}});await held.query("COMMIT");released=true;await expect(pending).rejects.toMatchObject({statusCode:403});expect(await snapshot()).toEqual(before);
 }finally{if(!released)await held.query("ROLLBACK");held.release();if(pending)await Promise.allSettled([pending]);await mockPrisma.companyMembership.update({where:{id:finance.membershipId},data:{status:"active"}});}
});

it("native account receipt catalog matches typed owner/member/result targets",async()=>{
 const rows=(await pool.query('SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=ANY($1)',[["AccountReceipt_owner_fkey","AccountReceipt_company_membership_fkey","AccountReceipt_tenant_membership_fkey","AccountReceipt_account_fkey","AccountReceipt_result_check"]])).rows;
 expect(rows).toHaveLength(5);expect(rows.every(row=>row.convalidated)).toBe(true);expect(rows.find(row=>row.conname==="AccountReceipt_account_fkey").definition).toContain('REFERENCES "FinanceAccount"("legalEntityId", id)');
});

it("native owned parent retry remains valid but historical parent retargeting cannot expose a foreign reference",async()=>{
 const parent=await mockPrisma.financeAccount.create({data:{legalEntityId:ids.legalEntities.transAsiaUz,code:randomUUID(),name:"Synthetic legacy parent",type:"asset",allowPosting:false}}),input={...intent(),parentId:parent.id};
 const result:any=await repo.createAccount(input,finance);expect(await repo.createAccount(input,finance)).toEqual(result);
 // Synthetic configuration fixture: a legacy parent has no immutable creation receipt.
 await mockPrisma.financeAccount.update({where:{id:result.id},data:{parentId:null}});await mockPrisma.financeAccount.update({where:{id:parent.id},data:{legalEntityId:ids.legalEntities.transAsiaDe}});
 const before=await snapshot();await expect(repo.createAccount(input,finance)).rejects.toMatchObject({code:"FINANCE_ACCOUNT_RECEIPT_INCONSISTENT"});expect(await snapshot()).toEqual(before);
});
