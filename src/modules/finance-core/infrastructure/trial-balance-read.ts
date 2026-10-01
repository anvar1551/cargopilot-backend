import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";

// PostgreSQL debitBase/creditBase are numeric(20,4); SUM may exceed that precision.
// Never use Decimal's default significant-digit arithmetic to add these aggregates.
function scaled(value: Prisma.Decimal) {
  if (!value.isFinite() || value.decimalPlaces() > 4)
    throw financeConflict("Invalid stored monetary scale", "FINANCE_REPORT_INTEGRITY_REJECTED");
  return BigInt(value.toFixed(4).replace(".", ""));
}
function exact(value: bigint) {
  const absolute = value < 0n ? -value : value;
  return new Prisma.Decimal((value < 0n ? "-" : "") + (absolute / 10000n).toString() + "." + (absolute % 10000n).toString().padStart(4, "0"));
}

export async function readOwnedTrialBalance(actor: AppUser, from: Date, to: Date) {
  const context = await requireLegalEntityContext(actor, "finance.reports.read");
  if (!(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to)
    throw financeBadRequest("Invalid trial balance date range", "FINANCE_INVALID_DATE_RANGE");
  const owner = { tenantId: context.tenantId, companyId: context.companyId, isActive: true,
    tenant: { is: { status: "active" as const } }, company: { is: { tenantId: context.tenantId, isActive: true } } };
  // One database snapshot prevents a concurrently changed graph from turning into partial totals.
  return prisma.$transaction(async tx => {
    const entity = await tx.financeLegalEntity.findFirst({ where: owner, select: { id: true, baseCurrency: true } });
    if (!entity) throw financeNotFound("Finance legal entity is not configured for this context", "FINANCE_ENTITY_NOT_CONFIGURED");
    const journal = { legalEntityId: entity.id, legalEntity: { is: owner }, status: { in: ["posted", "reversed"] as ("posted" | "reversed")[] }, postingDate: { gte: from, lte: to } };
    const invalid = await tx.financeJournalEntry.findFirst({ where: { ...journal, OR: [
      { document: { is: { legalEntityId: { not: entity.id } } } },
      { status: "posted", document: { is: { status: { not: "posted" } } } },
      { status: "reversed", document: { is: { status: { not: "reversed" } } } },
      { reversalOf: { is: { legalEntityId: { not: entity.id } } } },
      { lines: { some: { OR: [{ legalEntityId: null }, { legalEntityId: { not: entity.id } },
        { account: { is: { legalEntityId: { not: entity.id } } } },
        { account: { is: { parent: { is: { legalEntityId: { not: entity.id } } } } } }] } } },
    ] }, select: { id: true } });
    if (invalid) throw financeConflict("Trial balance contains uncertified journal references", "FINANCE_REPORT_INTEGRITY_REJECTED");
    const balances = await tx.financeJournalLine.groupBy({ by: ["accountId"],
      where: { legalEntityId: entity.id, account: { is: { legalEntityId: entity.id } }, journalEntry: { is: journal } },
      _sum: { debitBase: true, creditBase: true }, orderBy: { accountId: "asc" }, take: 10001 });
    if (balances.length > 10000) throw financeConflict("Trial balance exceeds supported account count", "FINANCE_REPORT_LIMIT");
    const accounts = await tx.financeAccount.findMany({ where: { legalEntityId: entity.id, legalEntity: { is: owner }, id: { in: balances.map(row => row.accountId) } },
      select: { id: true, code: true, name: true, type: true }, take: 10001 });
    if (accounts.length !== balances.length) throw financeConflict("Trial balance account ownership is inconsistent", "FINANCE_REPORT_INTEGRITY_REJECTED");
    const byId = new Map(accounts.map(account => [account.id, account]));
    let totalDebit = 0n, totalCredit = 0n;
    const rows = balances.map(row => {
      const debit = row._sum.debitBase ?? new Prisma.Decimal(0), credit = row._sum.creditBase ?? new Prisma.Decimal(0);
      const debitScaled = scaled(debit), creditScaled = scaled(credit);
      totalDebit += debitScaled; totalCredit += creditScaled;
      return { account: byId.get(row.accountId), debit, credit, balance: exact(debitScaled - creditScaled) };
    });
    return { baseCurrency: entity.baseCurrency, from, to, totalDebit: exact(totalDebit), totalCredit: exact(totalCredit), balanced: totalDebit === totalCredit, rows };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
