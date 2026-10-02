import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { CursorPage } from "../application/finance.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";

type Status = "pending" | "processing" | "posted" | "exception";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const select = { id: true, companyId: true, legalEntityId: true, sourceEventId: true, sourceType: true,
  eventType: true, sourceId: true, schemaVersion: true, status: true, occurredAt: true, postingDate: true,
  attempts: true, processedAt: true, createdAt: true, updatedAt: true,
  resolvedRuleId: true, financeDocumentId: true, financeJournalEntryId: true,
  resolvedRule: { select: { id: true, code: true, name: true, version: true } },
  financeDocument: { select: { id: true, documentNumber: true, status: true } },
  financeJournalEntry: { select: { id: true, journalNumber: true, status: true, documentId: true } },
} satisfies Prisma.FinanceSourceEventSelect;
function missing(): never { throw financeNotFound("Finance source event not found", "FINANCE_SOURCE_EVENT_NOT_FOUND"); }

export async function listOwnedSourceEvents(actor: AppUser, page: CursorPage, status?: Status) {
  const context = await requireLegalEntityContext(actor, "finance.exceptions.read");
  if (!page || Object.keys(page).some(key => !["cursor", "limit"].includes(key)) || !Number.isInteger(page.limit)
    || page.limit < 1 || page.limit > 100 || (page.cursor !== undefined && (typeof page.cursor !== "string" || !uuid.test(page.cursor)))
    || (status !== undefined && !["pending", "processing", "posted", "exception"].includes(status)))
    throw financeBadRequest("Invalid source event page", "FINANCE_INVALID_PAGE");
  const owner = { tenantId: context.tenantId, companyId: context.companyId, isActive: true,
    tenant: { is: { status: "active" as const } }, company: { is: { tenantId: context.tenantId, isActive: true } } };
  const entity = await prisma.financeLegalEntity.findFirst({ where: owner, select: { id: true } });
  if (!entity) { if (page.cursor) missing(); return { items: [], pageInfo: { hasMore: false, nextCursor: null } }; }
  const owned: Prisma.FinanceSourceEventWhereInput = { companyId: context.companyId, legalEntityId: entity.id,
    legalEntity: { is: owner }, ...(status ? { status } : {}), AND: [
      { OR: [{ resolvedRuleId: null }, { resolvedRule: { is: { legalEntityId: entity.id,
        lines: { every: { legalEntityId: entity.id, account: { is: { legalEntityId: entity.id } } } } } } }] },
      { OR: [{ financeDocumentId: null }, { financeDocument: { is: { legalEntityId: entity.id } } }] },
      { OR: [{ financeJournalEntryId: null }, { financeJournalEntry: { is: { legalEntityId: entity.id,
        document: { is: { legalEntityId: entity.id } } } } }] },
    ] };
  let keyset: Prisma.FinanceSourceEventWhereInput = {};
  if (page.cursor) {
    const cursor = await prisma.financeSourceEvent.findFirst({ where: { AND: [owned, { id: page.cursor }] }, select });
    if (!cursor) missing();
    project(cursor);
    keyset = { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] };
  }
  const rows = await prisma.financeSourceEvent.findMany({ where: { AND: [owned, keyset] }, select,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: page.limit + 1 });
  // Validate even the pagination sentinel; never expose a partial conflicting graph.
  const projected = rows.map(project), hasMore = rows.length > page.limit, items = projected.slice(0, page.limit);
  return { items, pageInfo: { hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } };
}

function project(row: Prisma.FinanceSourceEventGetPayload<{ select: typeof select }>) {
  const journal = row.financeJournalEntry;
  if ((journal && (!row.financeDocumentId || journal.documentId !== row.financeDocumentId))
    || (row.status === "posted" && (!journal || !row.financeDocument)))
    throw financeConflict("Source result references are inconsistent", "FINANCE_SOURCE_RESULT_CONFLICT");
  return { ...row, financeJournalEntry: journal ? { id: journal.id, journalNumber: journal.journalNumber, status: journal.status } : null };
}
