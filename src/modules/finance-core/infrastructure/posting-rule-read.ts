import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { CursorPage } from "../application/finance.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const select = { id: true, legalEntityId: true, code: true, name: true, sourceType: true, eventType: true,
  status: true, version: true, priority: true, validFrom: true, validTo: true, createdAt: true, updatedAt: true,
  lines: { orderBy: { lineNumber: "asc" as const }, take: 51, select: { id: true, postingRuleId: true, lineNumber: true,
    side: true, accountId: true, amountExpression: true, descriptionTemplate: true, createdAt: true, updatedAt: true,
    account: { select: { id: true, code: true, name: true, type: true } } } } } satisfies Prisma.FinancePostingRuleSelect;
async function ownership(actor: AppUser) {
  const context = await requireLegalEntityContext(actor, "finance.postingRules.read");
  const legalEntity = { tenantId: context.tenantId, companyId: context.companyId, isActive: true,
    tenant: { is: { status: "active" as const } }, company: { is: { tenantId: context.tenantId, isActive: true } } };
  const entity = await prisma.financeLegalEntity.findFirst({ where: legalEntity, select: { id: true } });
  if (!entity) return null;
  return { legalEntityId: entity.id, legalEntity: { is: legalEntity },
    lines: { every: { account: { is: { legalEntityId: entity.id, OR: [{ parentId: null }, { parent: { is: { legalEntityId: entity.id } } }] } } } },
  } satisfies Prisma.FinancePostingRuleWhereInput;
}
function missing(): never { throw financeNotFound("Finance posting rule not found", "FINANCE_POSTING_RULE_NOT_FOUND"); }
function bounded<T extends { lines: unknown[] }>(row: T) {
  if (row.lines.length > 50) throw financeConflict("Posting rule exceeds supported detail size", "FINANCE_POSTING_RULE_DETAIL_LIMIT");
  return row;
}
export async function listOwnedPostingRules(actor: AppUser, page: CursorPage) {
  const owned = await ownership(actor);
  if (!page || Object.keys(page).some(key => !["cursor", "limit"].includes(key)) || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100
    || (page.cursor !== undefined && (typeof page.cursor !== "string" || !uuid.test(page.cursor))))
    throw financeBadRequest("Invalid posting rule page", "FINANCE_INVALID_PAGE");
  if (!owned) { if (page.cursor) missing(); return { items: [], pageInfo: { hasMore: false, nextCursor: null } }; }
  let keyset: Prisma.FinancePostingRuleWhereInput = {};
  if (page.cursor) {
    const cursor = await prisma.financePostingRule.findFirst({ where: { AND: [owned, { id: page.cursor }] }, select: { id: true, createdAt: true } });
    if (!cursor) missing();
    keyset = { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] };
  }
  const rows = await prisma.financePostingRule.findMany({ where: { AND: [owned, keyset] }, select, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: page.limit + 1 });
  const hasMore = rows.length > page.limit, items = rows.slice(0, page.limit).map(bounded);
  return { items, pageInfo: { hasMore, nextCursor: hasMore ? items[items.length - 1].id : null } };
}
export async function getOwnedPostingRule(actor: AppUser, ruleId: string) {
  const owned = await ownership(actor);
  if (typeof ruleId !== "string" || !uuid.test(ruleId)) throw financeBadRequest("Invalid posting rule ID", "FINANCE_INVALID_POSTING_RULE_ID");
  if (!owned) missing();
  const row = await prisma.financePostingRule.findFirst({ where: { AND: [owned, { id: ruleId }] }, select });
  if (!row) missing();
  return bounded(row);
}
