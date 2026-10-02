import type { Prisma } from "@prisma/client";
import { financeConflict, financeNotFound } from "../domain/finance.errors";
import { journalDimensionOwnership } from "./journal-dimension-ownership";

type Tx = Prisma.TransactionClient;
export async function requireJournalEntity(tx: Tx, companyId: string) {
  const entity = await tx.financeLegalEntity.findUnique({ where: { companyId }, include: { tenant: true, company: true } });
  if (!entity || !entity.tenantId || !entity.isActive || entity.tenant?.status !== "active"
    || !entity.company.isActive || entity.company.tenantId !== entity.tenantId || entity.companyId !== companyId)
    throw financeNotFound("Active owned finance entity required", "FINANCE_ENTITY_NOT_CONFIGURED");
  return entity;
}

/** Defense against uncertified legacy graphs before writes or retry receipts. Never repairs records. */
export async function assertJournalBindings(tx: Tx, journal: any, entityId: string, owner: {tenantId:string;companyId:string}): Promise<void> {
  const reject = () => { throw financeConflict("Journal ownership relationships rejected", "FINANCE_JOURNAL_OWNERSHIP_REJECTED"); };
  if (!journal || journal.legalEntityId !== entityId || !journal.document
    || journal.documentId !== journal.document.id || journal.document.legalEntityId !== entityId
    || !Array.isArray(journal.lines) || journal.lines.some((line: any) => line.legalEntityId !== entityId
      || line.journalEntryId !== journal.id || !line.account || line.accountId !== line.account.id || line.account.legalEntityId !== entityId)) reject();
  if (journal.reversalOfId && !await tx.financeJournalEntry.findFirst({ where: { id: journal.reversalOfId, legalEntityId: entityId }, select: { id: true } })) reject();
  if (journal.document.reversalOfId && !await tx.financeDocument.findFirst({ where: { id: journal.document.reversalOfId, legalEntityId: entityId }, select: { id: true } })) reject();
  if (!owner.tenantId || !owner.companyId || await tx.financeJournalLine.count({ where: { journalEntryId: journal.id, NOT: journalDimensionOwnership(owner, entityId) } })) reject();
}

/** The existing entity/key uniqueness is not permission to reuse another operation's result. */
export function assertReversalRetry(result: any, original: any, intent: { actorUserId: string; postingDate: Date; reason: string }): void {
  const doc = result.document, basis = original.document;
  const matches = result.status === "posted" && doc.status === "posted"
    && result.reversalOfId === original.id && doc.reversalOfId === original.documentId
    && doc.createdByUserId === intent.actorUserId && doc.sourceType === "finance_journal_reversal" && doc.sourceId === original.id
    && result.postingDate.toISOString().slice(0, 10) === intent.postingDate.toISOString().slice(0, 10)
    && doc.postingDate.toISOString().slice(0, 10) === intent.postingDate.toISOString().slice(0, 10)
    && result.description === intent.reason && doc.description === intent.reason
    && doc.currency === basis.currency && doc.totalAmount.eq(basis.totalAmount) && doc.baseAmount.eq(basis.baseAmount) && doc.fxRate.eq(basis.fxRate)
    && result.totalDebitBase.eq(original.totalCreditBase) && result.totalCreditBase.eq(original.totalDebitBase)
    && result.lines.length === original.lines.length && result.lines.every((line: any) => {
      const old = original.lines.find((candidate: any) => candidate.lineNumber === line.lineNumber);
      return old && line.accountId === old.accountId && line.currency === old.currency && line.fxRate.eq(old.fxRate)
        && line.debitAmount.eq(old.creditAmount) && line.creditAmount.eq(old.debitAmount)
        && line.debitBase.eq(old.creditBase) && line.creditBase.eq(old.debitBase);
    });
  if (!matches) throw financeConflict("Reversal idempotency key conflicts with its accepted intent", "FINANCE_REVERSAL_IDEMPOTENCY_CONFLICT");
}
