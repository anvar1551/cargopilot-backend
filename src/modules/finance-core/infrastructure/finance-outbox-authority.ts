import { createHash, randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { stableDraftJson } from "../domain/draft-intent";
import { financeConflict } from "../domain/finance.errors";
import { getChartTemplate } from "../domain/chart-template";
import { assertChartInstallationSource } from "../domain/chart-template-authority";
import { assertJournalBindings } from "./journal-integrity";

type Tx = Prisma.TransactionClient;
export type FinancePublicationSource = { legalEntityId: string; aggregateType: string; aggregateId: string; eventType: string };
const sources = {
  "finance.account.created": ["finance_account", "account_invalidation"],
  "finance.chart_template.installed": ["finance_chart_template", "chart_invalidation"],
  "finance.journal.draft_created": ["finance_journal", "draft_invalidation"],
} as const;
export function rejectFinancePublication(): never {
  throw financeConflict("Finance publication source rejected", "FINANCE_OUTBOX_SOURCE_REJECTED");
}
/** Only non-posting facts. No request, queue payload or human impersonation authorizes execution. */
export async function resolveFinancePublication(tx: Tx, input: FinancePublicationSource, lock = false) {
  const spec = sources[input.eventType as keyof typeof sources];
  if (!spec || spec[0] !== input.aggregateType) rejectFinancePublication();
  if (lock) {
    await tx.$queryRaw`SELECT e.id FROM "FinanceLegalEntity" e JOIN "Organization" c ON c.id=e."companyId"
      JOIN "Tenant" t ON t.id=e."tenantId" WHERE e.id=${input.legalEntityId}::uuid FOR SHARE OF e,c,t`;
    // A source cannot be retargeted while its dispatch marker is being committed.
    if (spec[1] === "account_invalidation") await tx.$queryRaw`SELECT id FROM "FinanceAccount" WHERE id=${input.aggregateId}::uuid FOR SHARE`;
    if (spec[1] === "chart_invalidation") await tx.$queryRaw`SELECT id FROM "FinanceChartTemplateInstallation" WHERE id=${input.aggregateId}::uuid FOR SHARE`;
    if (spec[1] === "draft_invalidation") await tx.$queryRaw`SELECT id FROM "FinanceJournalEntry" WHERE id=${input.aggregateId}::uuid FOR SHARE`;
  }
  const entity = await tx.financeLegalEntity.findUnique({ where: { id: input.legalEntityId }, include: { tenant: true, company: true } });
  if (!entity?.tenantId || !entity.isActive || entity.tenant?.status !== "active" || !entity.company.isActive || entity.company.tenantId !== entity.tenantId) rejectFinancePublication();
  const owner = { tenantId: entity.tenantId, companyId: entity.companyId, capability: spec[1], accountId: null as string|null, installationId: null as string|null, journalId: null as string|null };
  if (spec[1] === "account_invalidation") {
    const account = await tx.financeAccount.findUnique({ where: { id: input.aggregateId } });
    if (!account || account.legalEntityId !== entity.id || account.status !== "active") rejectFinancePublication();
    if (account.parentId && !await tx.financeAccount.findFirst({ where: { id: account.parentId, legalEntityId: entity.id }, select: { id: true } })) rejectFinancePublication();
    owner.accountId = account.id;
  } else if (spec[1] === "chart_invalidation") {
    const installation = await tx.financeChartTemplateInstallation.findUnique({ where: { id: input.aggregateId } });
    if (!installation || installation.legalEntityId !== entity.id) rejectFinancePublication();
    const expected = getChartTemplate(installation.templateCode, installation.templateVersion);
    if (!expected) rejectFinancePublication();
    const accounts = await tx.financeAccount.findMany({ where: { legalEntityId: entity.id, AND: [
      { metadataJson: { path: ["templateCode"], equals: installation.templateCode } },
      { metadataJson: { path: ["templateVersion"], equals: installation.templateVersion } },
    ] }, take: expected.length + 1 });
    assertChartInstallationSource(installation, accounts, expected, { entityId: entity.id, baseCurrency: entity.baseCurrency, templateCode: installation.templateCode, templateVersion: installation.templateVersion });
    owner.installationId = installation.id;
  } else {
    const journal = await tx.financeJournalEntry.findUnique({ where: { id: input.aggregateId }, include: { document: true, lines: { take: 501, include: { account: true } } } });
    if (!journal || journal.status !== "draft" || journal.document.type !== "manual_journal" || journal.document.status !== "draft"
      || journal.document.draftTenantId !== entity.tenantId || journal.document.draftCompanyId !== entity.companyId
      || !journal.document.draftIntentHash || !journal.document.draftTenantMembershipId || !journal.document.draftCompanyMembershipId
      || journal.lines.length < 2 || journal.lines.length > 500 || !journal.totalDebitBase.eq(journal.totalCreditBase)) rejectFinancePublication();
    await assertJournalBindings(tx, journal, entity.id, owner);
    owner.journalId = journal.id;
  }
  return owner;
}

export function financePublicationHash(row: FinancePublicationSource & { eventId: string; schemaVersion: number; occurredAt: Date; acceptedAt: Date|null; tenantId: string|null; companyId: string|null; capability: string|null; accountId: string|null; installationId: string|null; journalId: string|null; payloadJson: unknown }) {
  return createHash("sha256").update(stableDraftJson({ eventId: row.eventId, legalEntityId: row.legalEntityId, aggregateType: row.aggregateType,
    aggregateId: row.aggregateId, eventType: row.eventType, schemaVersion: row.schemaVersion, occurredAt: row.occurredAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null, tenantId: row.tenantId, companyId: row.companyId, capability: row.capability,
    accountId: row.accountId, installationId: row.installationId, journalId: row.journalId, payloadJson: row.payloadJson })).digest("hex");
}
/** Called only inside the authorized source transaction, after the source is persisted. */
export async function enqueueAcceptedFinancePublication(tx: Tx, input: FinancePublicationSource) {
  const owner = await resolveFinancePublication(tx, input);
  const row = { ...input, ...owner, eventId: randomUUID(), schemaVersion: 1, occurredAt: new Date(), acceptedAt: new Date(), payloadJson: {} };
  return tx.financeDomainEventOutbox.create({ data: { ...row, contentHash: financePublicationHash(row), publicationState: "ready" } });
}
