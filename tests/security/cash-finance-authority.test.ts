jest.mock("../../src/config/prismaClient", () => ({ __esModule: true, default: new Proxy({}, { get: (_t, key) => mockDb[key as string] }) }));
import { Prisma } from "@prisma/client";
import { loadAcceptedCashFinance, ingestAcceptedCashOutbox, assertAcceptedCashSource } from "../../src/modules/finance-core/infrastructure/cash-finance-authority";
import { ingestDurableFinanceEnvelope } from "../../src/modules/finance-core/infrastructure/finance-queue-ingestion";
import { prismaFinanceRepository } from "../../src/modules/finance-core/infrastructure/prisma-finance.repository";

const eventId = "11111111-1111-4111-8111-111111111111", sourceId = `cash:${eventId}`;
const time = new Date("2026-10-01T12:00:00.000Z");
let operation: any, outbox: any, entity: any, record: any, storedJournal: any, storedDocument: any;
const mockDb: any = { $queryRaw: jest.fn(), $transaction: jest.fn(),
  cashCustodyOperation: { findUnique: jest.fn() }, analyticsDomainEventOutbox: { findUnique: jest.fn() },
  financeLegalEntity: { findUnique: jest.fn() }, warehouse: { findFirst: jest.fn() },
  financeSourceEvent: { findUnique: jest.fn(), create: jest.fn() },
  financeDocument: { create: jest.fn(), findFirst: jest.fn() }, financeJournalEntry: { create: jest.fn(), findFirst: jest.fn() },
  financeFiscalPeriod: { findFirst: jest.fn() }, financePostingRule: { findMany: jest.fn() },
  financeNumberSequence: { upsert: jest.fn() }, financeAuditEvent: { create: jest.fn() }, financeDomainEventOutbox: { create: jest.fn() },
  companyMembership: { findFirst: jest.fn() } };
beforeEach(() => {
  jest.clearAllMocks(); record = null; storedJournal = null; storedDocument = null;
  entity = { id: "legal-a", companyId: "company-a", tenantId: "tenant-a", isActive: true, baseCurrency: "UZS",
    tenant: { id: "tenant-a", status: "active" }, company: { id: "company-a", tenantId: "tenant-a", isActive: true } };
  operation = { tenantId: "tenant-a", companyId: "company-a", orderId: "order-a", collectionId: "collection-a", eventId,
    actorId: "maker-a", amount: new Prisma.Decimal("100.2500"), currency: "USD", action: "collect",
    order: { id: "order-a", tenantId: "tenant-a", ownerOrgId: "company-a", currency: "USD" },
    collection: { id: "collection-a", orderId: "order-a", kind: "cod", currency: "USD", expectedAmount: 100.25, collectedAmount: 100.25 },
    event: { id: eventId, cashCollectionId: "collection-a", eventType: "collected", amount: 100.25, actorId: "maker-a", fromHolderType: "none", toHolderType: "driver", createdAt: time } };
  outbox = { eventId: `finance:${sourceId}`, type: "finance_source_event", schemaVersion: 1, tenantScope: "company:company-a", entityId: "order-a", occurredAt: time,
    payload: { schemaVersion: 1, sourceEventId: sourceId, tenantId: "tenant-a", companyId: "company-a", sourceType: "cash_custody", eventType: "cash.collected", sourceId: "collection-a",
      actorUserId: "maker-a", occurredAt: time.toISOString(), postingDate: time.toISOString(), documentDate: time.toISOString(), currency: "USD", fxRate: "2", fxRateAsOf: "2026-09-30T00:00:00.000Z", amounts: { cod_amount: "100.2500" },
      dimensions: { orderId: "order-a" }, attributes: { cashKind: "cod", fromHolderType: "none", toHolderType: "driver" }, metadata: { cashCollectionId: "collection-a", cashCollectionEventId: eventId, baseCurrency: "UZS" } } };
  mockDb.$queryRaw.mockResolvedValue([]); mockDb.$transaction.mockImplementation((fn: any) => fn(mockDb));
  mockDb.cashCustodyOperation.findUnique.mockImplementation(async () => operation);
  mockDb.analyticsDomainEventOutbox.findUnique.mockImplementation(async () => outbox);
  mockDb.financeLegalEntity.findUnique.mockImplementation(async () => entity);
  mockDb.warehouse.findFirst.mockResolvedValue({ id: "warehouse-a" });
  mockDb.financeSourceEvent.findUnique.mockImplementation(async () => record);
  mockDb.financeSourceEvent.create.mockImplementation(async ({ data }: any) => (record = { id: "source-row", ...data }));
  mockDb.financeSourceEvent.findUniqueOrThrow = jest.fn(async () => record);
  mockDb.financeSourceEvent.updateMany = jest.fn(async ({ data }: any) => { if (!record) return { count: 0 }; Object.assign(record, data); return { count: 1 }; });
  mockDb.financeSourceEvent.update = jest.fn(async ({ data }: any) => Object.assign(record, data));
  mockDb.financeFiscalPeriod.findFirst.mockResolvedValue({ id: "period-a", name: "synthetic", status: "open" });
  mockDb.financePostingRule.findMany.mockResolvedValue([{ id: "rule-a", code: "SYNTHETIC", version: 1, priority: 100, conditionsJson: null,
    lines: ["debit", "credit"].map((side, i) => ({ lineNumber: i + 1, side, accountId: `account-${i}`, amountExpression: "cod_amount", descriptionTemplate: null,
      account: { legalEntityId: "legal-a", code: `SYNTHETIC-${i}`, status: "active", allowPosting: true, currency: "USD" } })) }]);
  mockDb.financeNumberSequence.upsert.mockResolvedValue({ nextValue: 2n, prefix: "SYNTHETIC-", padding: 8 });
  mockDb.financeDocument.create.mockImplementation(async ({ data }: any) => (storedDocument = { id: "document-a", ...data }));
  mockDb.financeJournalEntry.create.mockImplementation(async ({ data }: any) => (storedJournal = { id: "journal-a", ...data, document: storedDocument, lines: data.lines.create.map((line: any) => ({ ...line, journalEntryId: "journal-a", account: { id: line.accountId, legalEntityId: data.legalEntityId } })) }));
  mockDb.financeDocument.findFirst.mockImplementation(async () => storedDocument ?? { id: "document-a" }); mockDb.financeJournalEntry.findFirst.mockImplementation(async () => storedJournal ?? { id: "journal-a" });
});
function noPosting() { expect(mockDb.financeDocument.create).not.toHaveBeenCalled(); expect(mockDb.financeJournalEntry.create).not.toHaveBeenCalled(); }
it("queue values cannot supply finance authority; accepted receipt is reloaded", async () => {
  const result: any = await ingestDurableFinanceEnvelope({ id: outbox.eventId, type: "finance_source_event", payload: { companyId: "foreign", amounts: { cod_amount: "99999" }, currency: "CNY" } } as any);
  expect(result.event).toMatchObject({ companyId: "company-a", legalEntityId: "legal-a", sourceType: "cash_custody" });
  expect(result.event.payloadJson.amounts.cod_amount).toBe("100.2500"); noPosting();
});
it("matching durable ingestion reuses the record without resetting it", async () => {
  const a: any = await ingestAcceptedCashOutbox(outbox.eventId); record.status = "posted";
  const b: any = await ingestAcceptedCashOutbox(outbox.eventId);
  expect(b.event.id).toBe(a.event.id); expect(b.event.status).toBe("posted"); expect(mockDb.financeSourceEvent.create).toHaveBeenCalledTimes(1);
});
it.each([
  ["missing receipt", () => { operation = null; }], ["missing outbox", () => { outbox = null; }],
  ["null order tenant", () => { operation.order.tenantId = null; }], ["foreign tenant", () => { operation.order.tenantId = "tenant-b"; }],
  ["foreign company", () => { operation.order.ownerOrgId = "company-b"; }], ["foreign legal entity", () => { entity.tenantId = "tenant-b"; }],
  ["suspended tenant", () => { entity.tenant.status = "suspended"; }], ["disabled company", () => { entity.company.isActive = false; }],
  ["wrong child", () => { operation.event.cashCollectionId = "foreign"; }], ["wrong actor", () => { operation.event.actorId = "foreign"; }],
  ["conflicting amount", () => { outbox.payload.amounts.cod_amount = "999"; }], ["conflicting currency", () => { outbox.payload.currency = "CNY"; }],
  ["unsupported FX precision", () => { outbox.payload.fxRate = "2.000001"; }], ["foreign warehouse", () => { operation.event.toHolderType = "warehouse"; operation.event.toHolderId = "foreign"; mockDb.warehouse.findFirst.mockResolvedValue(null); }],
] as Array<[string, () => void]>)("rejects %s before source creation or posting", async (_name, change) => {
  change(); await expect(ingestAcceptedCashOutbox(`finance:${sourceId}`)).rejects.toBeDefined();
  expect(mockDb.financeSourceEvent.create).not.toHaveBeenCalled(); noPosting();
});
it("rejects conflicting durable source ownership/hash", async () => {
  await ingestAcceptedCashOutbox(outbox.eventId); const accepted = await loadAcceptedCashFinance(mockDb, sourceId);
  assertAcceptedCashSource(record, accepted); record.legalEntityId = "foreign";
  expect(() => assertAcceptedCashSource(record, accepted)).toThrow();
});
it("generic source ingestion cannot manufacture cash acceptance", async () => {
  await expect(prismaFinanceRepository.ingestSourceEvent({ event: { sourceType: "cash_custody", sourceEventId: sourceId } as any, payloadHash: "forged" })).rejects.toMatchObject({ code: "FINANCE_CASH_AUTHORITY_REJECTED" });
  expect(mockDb.$transaction).not.toHaveBeenCalled();
});
it("a nonexistent durable queue identifier cannot invoke payload-based ingestion", async () => {
  outbox = null; await expect(ingestDurableFinanceEnvelope({ id: "finance:nonexistent", type: "finance_source_event" })).rejects.toBeDefined();
  expect(mockDb.financeSourceEvent.create).not.toHaveBeenCalled();
});
it("posting executes existing balanced mechanics under durable capability, not human membership", async () => {
  await ingestAcceptedCashOutbox(outbox.eventId); record.status = "pending";
  const result: any = await prismaFinanceRepository.processSourceEvent(record.id);
  expect(result.exception).not.toBe(true); expect(result.journal.totalDebitBase.toFixed(4)).toBe("200.5000");
  expect(result.journal.totalCreditBase.toFixed(4)).toBe("200.5000"); expect(result.document.totalAmount.toFixed(4)).toBe("100.2500");
  expect(mockDb.financeDomainEventOutbox.create).toHaveBeenCalledTimes(1); expect(mockDb.companyMembership.findFirst).not.toHaveBeenCalled();
  expect(mockDb.$queryRaw.mock.calls.some((args: any[]) => String(args[0]).includes("FinanceSourceEvent"))).toBe(true);
  jest.clearAllMocks(); const retry: any = await prismaFinanceRepository.processSourceEvent(record.id);
  expect(retry.idempotent).toBe(true); noPosting(); expect(mockDb.financeDomainEventOutbox.create).not.toHaveBeenCalled();
});
it.each(["legalEntity", "hash", "child", "missing outbox", "suspended"])("posting rejects %s before document/journal/outbox effects", async kind => {
  await ingestAcceptedCashOutbox(outbox.eventId); record.status = "pending";
  if (kind === "legalEntity") record.legalEntityId = "foreign";
  if (kind === "hash") record.payloadHash = "forged";
  if (kind === "child") operation.event.cashCollectionId = "foreign";
  if (kind === "missing outbox") outbox = null;
  if (kind === "suspended") entity.tenant.status = "suspended";
  const result: any = await prismaFinanceRepository.processSourceEvent(record.id);
  expect(result.exception).toBe(true); noPosting(); expect(mockDb.financeDomainEventOutbox.create).not.toHaveBeenCalled();
});
it.each(["missing rule", "closed period", "foreign account", "unbalanced rule"])("posting preserves %s containment", async kind => {
  await ingestAcceptedCashOutbox(outbox.eventId);
  if (kind === "missing rule") mockDb.financePostingRule.findMany.mockResolvedValue([]);
  if (kind === "closed period") mockDb.financeFiscalPeriod.findFirst.mockResolvedValue({ name: "synthetic", status: "closed" });
  if (kind === "foreign account" || kind === "unbalanced rule") {
    const rules = await mockDb.financePostingRule.findMany();
    if (kind === "foreign account") rules[0].lines[0].account.legalEntityId = "foreign";
    else rules[0].lines[1].side = "debit";
  }
  const result: any = await prismaFinanceRepository.processSourceEvent(record.id); expect(result.exception).toBe(true); noPosting();
  expect(mockDb.financeDomainEventOutbox.create).not.toHaveBeenCalled();
});
