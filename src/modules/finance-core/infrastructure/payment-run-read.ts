import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { TreasuryPage } from "../application/finance-treasury.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const summary = { id: true, legalEntityId: true, runNumber: true, paymentDate: true, currency: true,
  totalAmount: true, fxRate: true, fxRateAsOf: true, status: true, submittedAt: true, approvedAt: true,
  rejectedAt: true, executedAt: true, createdAt: true, updatedAt: true,
  bankAccount: { select: { id: true, code: true, name: true, currency: true, accountIdentifierMasked: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.FinancePaymentRunSelect;
const detail = { ...summary, lines: { orderBy: { sequence: "asc" as const }, take: 1001, select: {
  id: true, sequence: true, payableItemId: true, carrierProviderId: true, carrierCode: true, amount: true, status: true,
  payableItem: { select: { id: true, billNumber: true, currency: true, carrierProviderId: true, carrierCode: true } },
  allocation: { select: { id: true, payableItemId: true, amount: true, currency: true, occurredAt: true } },
} } } satisfies Prisma.FinancePaymentRunSelect;
function missing(): never { throw financeNotFound("Payment run not found", "FINANCE_PAYMENT_RUN_NOT_FOUND"); }
async function ownership(actor: AppUser) {
  const context = await requireLegalEntityContext(actor, "finance.treasury.read");
  const owner = { tenantId: context.tenantId, companyId: context.companyId, isActive: true,
    tenant: { is: { status: "active" as const } }, company: { is: { tenantId: context.tenantId, isActive: true } } };
  const entity = await prisma.financeLegalEntity.findFirst({ where: owner, select: { id: true } });
  if (!entity) return null;
  return { legalEntityId: entity.id, legalEntity: { is: owner }, bankAccount: { is: { legalEntityId: entity.id } },
    lines: { every: { legalEntityId: entity.id, payableItem: { is: { legalEntityId: entity.id } }, OR: [{ allocation: { is: null } },
      { allocation: { is: { legalEntityId: entity.id, payableItem: { is: { legalEntityId: entity.id } } } } }] } },
  } satisfies Prisma.FinancePaymentRunWhereInput;
}
export async function listOwnedPaymentRuns(actor: AppUser, page: TreasuryPage) {
  const owned = await ownership(actor);
  if (!page || Object.keys(page).some(k => !["cursor", "limit", "status"].includes(k)) || !Number.isInteger(page.limit)
    || page.limit < 1 || page.limit > 100 || (page.cursor !== undefined && (typeof page.cursor !== "string" || !uuid.test(page.cursor)))
    || (page.status !== undefined && !["draft", "submitted", "approved", "rejected", "executed"].includes(page.status)))
    throw financeBadRequest("Invalid payment run page", "FINANCE_INVALID_PAGE");
  if (!owned) { if (page.cursor) missing(); return { items: [], pageInfo: { hasMore: false, nextCursor: null } }; }
  const where: Prisma.FinancePaymentRunWhereInput = { ...owned, ...(page.status ? { status: page.status as Prisma.EnumFinancePaymentRunStatusFilter["equals"] } : {}) };
  let keyset: Prisma.FinancePaymentRunWhereInput = {};
  if (page.cursor) {
    const cursor = await prisma.financePaymentRun.findFirst({ where: { AND: [where, { id: page.cursor }] }, select: { id: true, paymentDate: true } });
    if (!cursor) missing();
    keyset = { OR: [{ paymentDate: { lt: cursor.paymentDate } }, { paymentDate: cursor.paymentDate, id: { lt: cursor.id } }] };
  }
  const rows = await prisma.financePaymentRun.findMany({ where: { AND: [where, keyset] }, select: summary,
    orderBy: [{ paymentDate: "desc" }, { id: "desc" }], take: page.limit + 1 });
  const hasMore = rows.length > page.limit, items = rows.slice(0, page.limit);
  return { items, pageInfo: { hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } };
}
export async function getOwnedPaymentRun(actor: AppUser, id: string) {
  const owned = await ownership(actor);
  if (typeof id !== "string" || !uuid.test(id)) throw financeBadRequest("Invalid payment run ID", "FINANCE_INVALID_ID");
  if (!owned) missing();
  const row = await prisma.financePaymentRun.findFirst({ where: { AND: [owned, { id }] }, select: detail });
  if (!row) missing();
  if (row.lines.length > 1000) throw financeConflict("Payment run exceeds supported detail size", "FINANCE_PAYMENT_RUN_DETAIL_LIMIT");
  if (row.bankAccount.currency !== row.currency || row.lines.some(line => line.payableItem.currency !== row.currency
    || line.carrierProviderId !== line.payableItem.carrierProviderId || line.carrierCode !== line.payableItem.carrierCode
    || (line.allocation && (line.allocation.payableItemId !== line.payableItemId || line.allocation.currency !== row.currency))))
    throw financeConflict("Payment run references are inconsistent", "FINANCE_PAYMENT_RUN_REFERENCE_CONFLICT");
  return row;
}
