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
it("forged queue values are ignored; posting is exact, balanced and owner-bound", async () => {
  const result: any = await ingestDurableFinanceEnvelope({ id: outboxId, type: "finance_source_event", payload: { tenantId: ids.tenants.unrelated, companyId: ids.organizations.unrelated, amounts: { cod_amount: "999999" }, currency: "CNY" } } as any);
  const posted: any = await prismaFinanceRepository.processSourceEvent(result.event.id);
  expect(posted.exception).not.toBe(true);
  const state = await ledgerSnapshot(); expect(state.documents).toHaveLength(1); expect(state.journals).toHaveLength(1); expect(state.outboxes).toHaveLength(1);
  expect(state.documents[0]).toMatchObject({ legalEntityId, currency: "USD", status: "posted" });
  expect(state.documents[0].totalAmount.toFixed(4)).toBe("100.2500");
  expect(state.journals[0].totalDebitBase.toFixed(4)).toBe("200.5000"); expect(state.journals[0].totalCreditBase.toFixed(4)).toBe("200.5000");
  expect(state.journals[0].lines).toHaveLength(2);
  expect(state.journals[0].lines.every(l => l.orderId === orderId && accountIds.includes(l.accountId))).toBe(true);
  const frozen = await ledgerSnapshot(); const retry: any = await prismaFinanceRepository.processSourceEvent(result.event.id);
  expect(retry.idempotent).toBe(true); expect(await ledgerSnapshot()).toEqual(frozen);
});
it("concurrent duplicate ingestion creates one source without resetting state", async () => {
  const results = await Promise.all([source(), source(), source()]); expect(new Set(results.map(r => r.id)).size).toBe(1);
  expect(await mockPrisma.financeSourceEvent.count({ where: { sourceEventId } })).toBe(1);
});
it("concurrent posting produces one journal/document/outbox", async () => {
  const row = await source(); const results: any[] = await Promise.all([prismaFinanceRepository.processSourceEvent(row.id), prismaFinanceRepository.processSourceEvent(row.id), prismaFinanceRepository.processSourceEvent(row.id)]);
  expect(results.filter(r => r.idempotent === false)).toHaveLength(1);
  const state = await ledgerSnapshot(); expect(state.documents).toHaveLength(1); expect(state.journals).toHaveLength(1); expect(state.outboxes).toHaveLength(1);
  expect(state.journals[0].totalDebitBase.eq(state.journals[0].totalCreditBase)).toBe(true);
  expect((await mockPrisma.financeSourceEvent.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("posted");
});
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
it("outbox failure rolls back journal, document, source transition, audit and numbers", async () => {
  const row = await source(); const before = await ledgerSnapshot();
  const numbers = await mockPrisma.financeNumberSequence.findMany({ where: { legalEntityId }, orderBy: { key: "asc" } });
  const auditCount = await mockPrisma.financeAuditEvent.count({ where: { legalEntityId } });
  await pool.query(`CREATE FUNCTION public.cp_test_finance_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END $$;
    CREATE TRIGGER cp_test_finance_fail BEFORE INSERT ON "FinanceDomainEventOutbox" FOR EACH ROW EXECUTE FUNCTION public.cp_test_finance_fail();`);
  try { await expect(prismaFinanceRepository.processSourceEvent(row.id)).rejects.toThrow("synthetic outbox failure"); }
  finally { await pool.query('DROP TRIGGER cp_test_finance_fail ON "FinanceDomainEventOutbox"; DROP FUNCTION public.cp_test_finance_fail();'); }
  expect(await ledgerSnapshot()).toEqual(before); expect(await mockPrisma.financeNumberSequence.findMany({ where: { legalEntityId }, orderBy: { key: "asc" } })).toEqual(numbers);
  expect(await mockPrisma.financeAuditEvent.count({ where: { legalEntityId } })).toBe(auditCount);
  expect((await mockPrisma.financeSourceEvent.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("pending");
});
it("same-tenant foreign account in a cash rule is rejected", async () => {
  const row = await source(); const foreign = await mockPrisma.financeLegalEntity.findUniqueOrThrow({ where: { companyId: ids.organizations.transAsiaDe } });
  const account = await mockPrisma.financeAccount.create({ data: { legalEntityId: foreign.id, code: randomUUID(), name: "SYNTHETIC FOREIGN", type: "asset" } });
  const line = await mockPrisma.financePostingRuleLine.findFirstOrThrow({ where: { postingRuleId: ruleId, lineNumber: 1 } });
  await mockPrisma.financePostingRuleLine.update({ where: { id: line.id }, data: { accountId: account.id } });
  try { const before = await ledgerSnapshot(); const result: any = await prismaFinanceRepository.processSourceEvent(row.id); expect(result.exception).toBe(true); expect(await ledgerSnapshot()).toEqual(before); }
  finally { await mockPrisma.financePostingRuleLine.update({ where: { id: line.id }, data: { accountId: accountIds[0] } }); }
});
