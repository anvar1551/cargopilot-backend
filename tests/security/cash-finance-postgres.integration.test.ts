jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_target, name) => (mockPrisma as any)[name] }) }));
import { Pool } from "pg";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "crypto";
import { createTenantDemoFixture, TENANT_DEMO_IDS as ids } from "../../src/modules/tenancy/demo-fixtures";
import { persistTenantDemoFixture } from "../tenancy/postgres-fixture.persistence";
import { collectOrderCash, handoffOrderCash, settleOrderCash } from "../../src/modules/orders-core/cash/custody.service";
import { ingestAcceptedCashOutbox } from "../../src/modules/finance-core/infrastructure/cash-finance-authority";
import { ingestDurableFinanceEnvelope } from "../../src/modules/finance-core/infrastructure/finance-queue-ingestion";
import { prismaFinanceRepository } from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";

const url = process.env.CARGOPILOT_WORKER_TEST_DATABASE_URL;
const runId = process.env.CARGOPILOT_WORKER_RUN_ID;
if (!url || !runId || !/^[a-f0-9]{12}$/.test(runId)) throw new Error("Disposable cash instance identity required");
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "cp_worker_it" || target.pathname !== `/cp_worker_${runId}`) throw new Error("Refusing non-disposable cash PostgreSQL target");
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000, options: "-c statement_timeout=5000" });
let mockPrisma: PrismaClient, orderId: string;
let legalEntityId: string, ruleId: string, accountIds: string[];
let accepted: any, eventId: string, sourceEventId: string, outboxId: string;
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
  const entity = await mockPrisma.financeLegalEntity.findUniqueOrThrow({ where: { companyId: maker.companyId } });
  legalEntityId = entity.id;
  await mockPrisma.financeFiscalPeriod.create({ data: { legalEntityId, fiscalYear: 2026, periodNumber: 1, name: "SYNTHETIC ONLY", startDate: new Date("2020-01-01"), endDate: new Date("2030-12-31") } });
  accountIds = [];
  for (const code of ["SYNTHETIC_TEST_DEBIT", "SYNTHETIC_TEST_CREDIT"]) {
    const row = await mockPrisma.financeAccount.create({ data: { legalEntityId, code, name: code, type: "asset" } }); accountIds.push(row.id);
  }
  // Test-only balanced mechanics, NOT a proposed CargoPilot cash accounting rule.
  const rule = await mockPrisma.financePostingRule.create({ data: { legalEntityId, code: "SYNTHETIC_MECHANICS_ONLY", name: "NOT BUSINESS POLICY", sourceType: "cash_custody", eventType: "cash.collected",
    lines: { create: [{ lineNumber: 1, side: "debit", accountId: accountIds[0], amountExpression: "cod_amount" }, { lineNumber: 2, side: "credit", accountId: accountIds[1], amountExpression: "cod_amount" }] } } }); ruleId = rule.id;
});
beforeEach(async () => {
  orderId = randomUUID();
  await mockPrisma.order.create({ data: { id: orderId, orderNumber: `SYNTHETIC-${orderId}`, customerId: ids.users.multiTenant,
    tenantId: maker.tenantId, ownerOrgId: maker.companyId, currentWarehouseId: ids.warehouses.transAsiaUz,
    assignedDriverId: maker.id, pickupAddress: "Synthetic pickup", dropoffAddress: "Synthetic dropoff",
    status: "in_transit", codAmount: 100.25, codPaidStatus: "NOT_PAID", currency: "USD",
    pricingComponents: { create: { componentType: "other", amount: "100.25", currency: "USD", fxRateSnapshot: "2", baseCurrency: "UZS" } } } });
  await mockPrisma.financePostingRule.updateMany({ where: { legalEntityId, sourceType: "cash_custody" }, data: { status: "inactive" } });
  await mockPrisma.financePostingRule.update({ where: { id: ruleId }, data: { status: "active" } });
  await mockPrisma.financeFiscalPeriod.updateMany({ where: { legalEntityId }, data: { status: "open" } });
  await mockPrisma.tenant.update({ where: { id: maker.tenantId }, data: { status: "active" } });
  accepted = await collectOrderCash(collect(uniqueKey("collect")));
  eventId = currentId(accepted); sourceEventId = `cash:${eventId}`; outboxId = `finance:${sourceEventId}`;
});
afterAll(async () => { await mockPrisma?.$disconnect(); await pool.end(); });
function uniqueKey(label: string) { return `${label}:${orderId}`; }
async function ledgerSnapshot() {
  const documents = await mockPrisma.financeDocument.findMany({ where: { sourceEventId } });
  const journals = await mockPrisma.financeJournalEntry.findMany({ where: { documentId: { in: documents.map(d => d.id) } }, include: { lines: true } });
  const source = await mockPrisma.financeSourceEvent.findFirst({ where: { sourceEventId } });
  const outboxes = source ? await mockPrisma.financeDomainEventOutbox.findMany({ where: { aggregateId: source.id } }) : [];
  return { documents, journals, outboxes };
}
async function source() { return (await ingestAcceptedCashOutbox(outboxId)).event; }
it("forged queue values cannot approve accounting; accepted source remains exact and new posting denies",async()=>{const result:any=await ingestDurableFinanceEnvelope({id:outboxId,type:"finance_source_event",payload:{approved:true,amounts:{cod_amount:"999999"}}}as any);expect(result.event.payloadJson.amounts.cod_amount).toBe("100.2500");const before=await ledgerSnapshot();const posted:any=await prismaFinanceRepository.processSourceEvent(result.event.id);expect(posted.exception).toBe(true);expect((await mockPrisma.financeSourceEvent.findUniqueOrThrow({where:{id:result.event.id}})).lastErrorCode).toBe("FINANCE_POSTING_RULE_APPROVAL_REQUIRED");expect(await ledgerSnapshot()).toEqual(before);});
it("concurrent duplicate ingestion creates one source without resetting state", async () => {
  const results = await Promise.all([source(), source(), source()]); expect(new Set(results.map(r => r.id)).size).toBe(1);
  expect(await mockPrisma.financeSourceEvent.count({ where: { sourceEventId } })).toBe(1);
});
it("concurrent unapproved posting produces no journal/document/outbox",async()=>{const row=await source(),before=await ledgerSnapshot();const results:any[]=await Promise.all([1,2,3].map(()=>prismaFinanceRepository.processSourceEvent(row.id)));expect(results.every(r=>r.exception)).toBe(true);expect(await ledgerSnapshot()).toEqual(before);expect((await mockPrisma.financeSourceEvent.findUniqueOrThrow({where:{id:row.id}})).status).toBe("exception");});
it.each(["company", "legalEntity", "sourceId", "payload"])("conflicting durable %s rejects before journal effects", async kind => {
  const row = await source(); const before = await ledgerSnapshot();
  const foreign = await mockPrisma.financeLegalEntity.findUniqueOrThrow({ where: { companyId: ids.organizations.transAsiaDe } });
  await mockPrisma.financeSourceEvent.update({ where: { id: row.id }, data: kind === "company" ? { companyId: ids.organizations.unrelated } :
    kind === "legalEntity" ? { legalEntityId: foreign.id } : kind === "sourceId" ? { sourceId: randomUUID() } : { payloadJson: { ...(row.payloadJson as any), amounts: { cod_amount: "9999" } } } });
  const result: any = await prismaFinanceRepository.processSourceEvent(row.id); expect(result.exception).toBe(true); expect(await ledgerSnapshot()).toEqual(before);
});
it("disabled tenant prevents posting of previously accepted work", async () => {
  const row = await source(); const before = await ledgerSnapshot(); await mockPrisma.tenant.update({ where: { id: maker.tenantId }, data: { status: "suspended" } });
  const result: any = await prismaFinanceRepository.processSourceEvent(row.id); expect(result.exception).toBe(true); expect(await ledgerSnapshot()).toEqual(before);
});
it("missing acceptance outbox rejects even an existing source record", async () => {
  const row = await source(); const before = await ledgerSnapshot(); await mockPrisma.analyticsDomainEventOutbox.delete({ where: { eventId: outboxId } });
  const result: any = await prismaFinanceRepository.processSourceEvent(row.id); expect(result.exception).toBe(true); expect(await ledgerSnapshot()).toEqual(before);
});
it.each(["tenant", "money", "receipt"])("inconsistent acceptance %s prevents ingestion and posting", async kind => {
  const before = await ledgerSnapshot();
  if (kind === "receipt") {
    await mockPrisma.cashCustodyOperation.delete({ where: { eventId } });
  } else if (kind === "money") {
    await mockPrisma.cashCollectionEvent.update({ where: { id: eventId }, data: { amount: 999 } });
  } else {
    const outbox = await mockPrisma.analyticsDomainEventOutbox.findUniqueOrThrow({ where: { eventId: outboxId } });
    await mockPrisma.analyticsDomainEventOutbox.update({ where: { eventId: outboxId },
      data: { payload: { ...(outbox.payload as any), tenantId: ids.tenants.unrelated } } });
  }
  await expect(ingestAcceptedCashOutbox(outboxId)).rejects.toMatchObject({ code: "FINANCE_CASH_AUTHORITY_REJECTED" });
  expect(await mockPrisma.financeSourceEvent.count({ where: { sourceEventId } })).toBe(0);
  expect(await ledgerSnapshot()).toEqual(before);
});
it("missing source cannot produce financial effects", async () => {
  const before = await ledgerSnapshot(); await expect(prismaFinanceRepository.processSourceEvent(randomUUID())).rejects.toBeDefined(); expect(await ledgerSnapshot()).toEqual(before);
});
it("missing rule and closed period remain exceptions with no invented posting", async () => {
  const row = await source(); const before = await ledgerSnapshot(); await mockPrisma.financePostingRule.update({ where: { id: ruleId }, data: { status: "inactive" } });
  let result: any = await prismaFinanceRepository.processSourceEvent(row.id); expect(result.exception).toBe(true); expect(await ledgerSnapshot()).toEqual(before);
  await mockPrisma.financePostingRule.update({ where: { id: ruleId }, data: { status: "active" } });
  await mockPrisma.financeFiscalPeriod.updateMany({ where: { legalEntityId }, data: { status: "closed" } });
  result = await prismaFinanceRepository.processSourceEvent(row.id); expect(result.exception).toBe(true); expect(await ledgerSnapshot()).toEqual(before);
});
it("unapproved posting allocates no numbers, audit or outbox business effects",async()=>{const row=await source(),before=await ledgerSnapshot(),numbers=await mockPrisma.financeNumberSequence.findMany(),audit=await mockPrisma.financeAuditEvent.count();expect(await prismaFinanceRepository.processSourceEvent(row.id)).toMatchObject({exception:true});expect(await ledgerSnapshot()).toEqual(before);expect(await mockPrisma.financeNumberSequence.findMany()).toEqual(numbers);expect(await mockPrisma.financeAuditEvent.count()).toBe(audit);});
it("same-tenant foreign account in a cash rule is rejected", async () => {
  const row = await source(); const foreign = await mockPrisma.financeLegalEntity.findUniqueOrThrow({ where: { companyId: ids.organizations.transAsiaDe } });
  const account = await mockPrisma.financeAccount.create({ data: { legalEntityId: foreign.id, code: randomUUID(), name: "SYNTHETIC FOREIGN", type: "asset" } });
  const line = await mockPrisma.financePostingRuleLine.findFirstOrThrow({ where: { postingRuleId: ruleId, lineNumber: 1 } });
  await mockPrisma.financePostingRuleLine.update({ where: { id: line.id }, data: { accountId: account.id } });
  try { const before = await ledgerSnapshot(); const result: any = await prismaFinanceRepository.processSourceEvent(row.id); expect(result.exception).toBe(true); expect(await ledgerSnapshot()).toEqual(before); }
  finally { await mockPrisma.financePostingRuleLine.update({ where: { id: line.id }, data: { accountId: accountIds[0] } }); }
});

it("validated historical cash posting receipt is immutable and does not authorize new execution",async()=>{const row=await source();const doc=await mockPrisma.financeDocument.create({data:{legalEntityId,documentNumber:randomUUID(),type:"cash_movement",status:"posted",documentDate:new Date(),postingDate:new Date(),currency:"USD",totalAmount:"100.25",baseAmount:"200.5",fxRate:"2",sourceEventId,sourceType:"cash_custody",sourceId:row.sourceId,idempotencyKey:randomUUID(),createdByUserId:maker.id}});const journal=await mockPrisma.financeJournalEntry.create({data:{legalEntityId,documentId:doc.id,journalNumber:randomUUID(),status:"posted",postingDate:new Date(),totalDebitBase:"200.5",totalCreditBase:"200.5",lines:{create:[{legalEntityId,lineNumber:1,accountId:accountIds[0],currency:"USD",fxRate:"2",debitAmount:"100.25",debitBase:"200.5"},{legalEntityId,lineNumber:2,accountId:accountIds[1],currency:"USD",fxRate:"2",creditAmount:"100.25",creditBase:"200.5"}]}}});await mockPrisma.financeSourceEvent.update({where:{id:row.id},data:{status:"posted",financeDocumentId:doc.id,financeJournalEntryId:journal.id}});const before=await ledgerSnapshot();for(const result of await Promise.all([1,2].map(()=>prismaFinanceRepository.processSourceEvent(row.id))))expect(result).toMatchObject({idempotent:true});expect(await ledgerSnapshot()).toEqual(before);});
