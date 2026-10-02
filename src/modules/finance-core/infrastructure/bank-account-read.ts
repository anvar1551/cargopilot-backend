import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { TreasuryPage } from "../application/finance-treasury.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeNotFound } from "../domain/finance.errors";

const select = { id: true, legalEntityId: true, code: true, name: true, bankName: true,
  accountIdentifierMasked: true, currency: true, isActive: true, createdAt: true, updatedAt: true,
} satisfies Prisma.FinanceBankAccountSelect;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function missing(): never { throw financeNotFound("Bank account not found", "FINANCE_BANK_ACCOUNT_NOT_FOUND"); }
export async function listOwnedBankAccounts(actor: AppUser, page: TreasuryPage) {
  const context = await requireLegalEntityContext(actor, "finance.treasury.read");
  if (!page || Object.keys(page).some(key => !["cursor", "limit", "status"].includes(key)) || !Number.isInteger(page.limit)
    || page.limit < 1 || page.limit > 100 || (page.cursor !== undefined && (typeof page.cursor !== "string" || !uuid.test(page.cursor)))
    || (page.status !== undefined && !["active", "inactive"].includes(page.status)))
    throw financeBadRequest("Invalid bank account page", "FINANCE_INVALID_PAGE");
  const owned: Prisma.FinanceBankAccountWhereInput = { legalEntity: { is: { tenantId: context.tenantId,
    companyId: context.companyId, isActive: true, tenant: { is: { status: "active" } },
    company: { is: { tenantId: context.tenantId, isActive: true } } } },
    ...(page.status !== undefined ? { isActive: page.status === "active" } : {}) };
  let keyset: Prisma.FinanceBankAccountWhereInput = {};
  if (page.cursor) {
    const cursor = await prisma.financeBankAccount.findFirst({ where: { AND: [owned, { id: page.cursor }] }, select: { id: true, code: true } });
    if (!cursor) missing();
    keyset = { OR: [{ code: { gt: cursor.code } }, { code: cursor.code, id: { gt: cursor.id } }] };
  }
  const rows = await prisma.financeBankAccount.findMany({ where: { AND: [owned, keyset] }, select,
    orderBy: [{ code: "asc" }, { id: "asc" }], take: page.limit + 1 });
  const hasMore = rows.length > page.limit, items = rows.slice(0, page.limit);
  return { items, pageInfo: { hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } };
}
