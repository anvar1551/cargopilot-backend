import type { Prisma } from "@prisma/client";
import { financeConflict, financeNotFound } from "../domain/finance.errors";

type Tx = Prisma.TransactionClient;
export async function requireJournalEntity(tx: Tx, companyId: string) {
  const entity = await tx.financeLegalEntity.findUnique({ where: { companyId }, include: { tenant: true, company: true } });
  if (!entity || !entity.tenantId || !entity.isActive || entity.tenant?.status !== "active"
    || !entity.company.isActive || entity.company.tenantId !== entity.tenantId || entity.companyId !== companyId)
    throw financeNotFound("Active owned finance entity required", "FINANCE_ENTITY_NOT_CONFIGURED");
  return entity;
}

/** Defense against uncertified legacy graphs before writes or retry receipts. Never repairs records. */
export async function assertJournalBindings(tx: Tx, journal: any, entityId: string): Promise<void> {
  const reject = () => { throw financeConflict("Journal ownership relationships rejected", "FINANCE_JOURNAL_OWNERSHIP_REJECTED"); };
  if (!journal || journal.legalEntityId !== entityId || !journal.document
    || journal.documentId !== journal.document.id || journal.document.legalEntityId !== entityId
    || !Array.isArray(journal.lines) || journal.lines.some((line: any) => line.legalEntityId !== entityId
      || line.journalEntryId !== journal.id || !line.account || line.accountId !== line.account.id || line.account.legalEntityId !== entityId)) reject();
  if (journal.reversalOfId && !await tx.financeJournalEntry.findFirst({ where: { id: journal.reversalOfId, legalEntityId: entityId }, select: { id: true } })) reject();
  if (journal.document.reversalOfId && !await tx.financeDocument.findFirst({ where: { id: journal.document.reversalOfId, legalEntityId: entityId }, select: { id: true } })) reject();
}
