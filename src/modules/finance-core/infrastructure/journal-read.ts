import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { CursorPage } from "../application/finance.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const accountSelect = { id: true, legalEntityId: true, code: true, name: true, type: true, status: true,
  parentId: true, allowPosting: true, isControlAccount: true, currency: true, description: true, createdAt: true, updatedAt: true } satisfies Prisma.FinanceAccountSelect;
const journalSelect = {
  id: true, legalEntityId: true, documentId: true, journalNumber: true, status: true, postingDate: true,
  description: true, totalDebitBase: true, totalCreditBase: true, postedAt: true, reversedAt: true,
  reversalOfId: true, createdAt: true, updatedAt: true,
  document: { select: { id: true, documentNumber: true, status: true, documentDate: true, postingDate: true,
    currency: true, totalAmount: true, baseAmount: true, fxRate: true, description: true, sourceType: true, sourceId: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.FinanceJournalEntrySelect;
const detailSelect = { ...journalSelect, lines: { orderBy: { lineNumber: "asc" as const }, take: 501,
  select: { id: true, lineNumber: true, accountId: true, account: { select: accountSelect }, debitAmount: true,
    creditAmount: true, currency: true, fxRate: true, debitBase: true, creditBase: true, description: true } } } satisfies Prisma.FinanceJournalEntrySelect;

async function ownership(actor: AppUser) {
  const context = await requireLegalEntityContext(actor, "finance.journals.read");
  const legalEntity = { tenantId: context.tenantId, companyId: context.companyId, isActive: true,
    tenant: { is: { status: "active" as const } }, company: { is: { tenantId: context.tenantId, isActive: true } } };
  const entity = await prisma.financeLegalEntity.findFirst({ where: legalEntity, select: { id: true } });
  if (!entity) return null;
  // Each final read repeats active ownership and checks nested document/account/reversal equality.
  return { legalEntityId: entity.id, legalEntity: { is: legalEntity }, document: { is: { legalEntityId: entity.id } },
    lines: { every: { legalEntityId: entity.id, account: { is: { legalEntityId: entity.id,
      OR: [{ parentId: null }, { parent: { is: { legalEntityId: entity.id } } }] } } } },
    OR: [{ reversalOfId: null }, { reversalOf: { is: { legalEntityId: entity.id } } }],
  } satisfies Prisma.FinanceJournalEntryWhereInput;
}
function missing(): never { throw financeNotFound("Finance journal not found", "FINANCE_JOURNAL_NOT_FOUND"); }

export async function listOwnedJournals(actor: AppUser, page: CursorPage) {
  const owned = await ownership(actor);
  if (!page || Object.keys(page).some(key => !["cursor", "limit"].includes(key)) || !Number.isInteger(page.limit)
    || page.limit < 1 || page.limit > 100 || (page.cursor !== undefined && (typeof page.cursor !== "string" || !uuid.test(page.cursor))))
    throw financeBadRequest("Invalid journal page", "FINANCE_INVALID_PAGE");
  if (!owned) { if (page.cursor) missing(); return { items: [], pageInfo: { hasMore: false, nextCursor: null } }; }
  let keyset: Prisma.FinanceJournalEntryWhereInput = {};
  if (page.cursor) {
    const cursor = await prisma.financeJournalEntry.findFirst({ where: { AND: [owned, { id: page.cursor }] }, select: { id: true, createdAt: true } });
    if (!cursor) missing();
    keyset = { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] };
  }
  const rows = await prisma.financeJournalEntry.findMany({ where: { AND: [owned, keyset] },
    select: journalSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: page.limit + 1 });
  const hasMore = rows.length > page.limit, items = rows.slice(0, page.limit);
  return { items, pageInfo: { hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } };
}

export async function getOwnedJournal(actor: AppUser, journalId: string) {
  const owned = await ownership(actor);
  if (typeof journalId !== "string" || !uuid.test(journalId)) throw financeBadRequest("Invalid journal ID", "FINANCE_INVALID_JOURNAL_ID");
  if (!owned) missing();
  const row = await prisma.financeJournalEntry.findFirst({ where: { AND: [owned, { id: journalId }] }, select: detailSelect });
  if (!row) missing();
  // Existing HTTP journal creation permits at most 500 lines. Never return a truncated financial document.
  if (row.lines.length > 500) throw financeConflict("Journal exceeds supported detail size", "FINANCE_JOURNAL_DETAIL_LIMIT");
  return row;
}
