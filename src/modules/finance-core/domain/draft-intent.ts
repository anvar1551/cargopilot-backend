import { createHash } from "crypto";
import Decimal from "decimal.js";
import type { CreateJournalCommand } from "../application/finance.port";
import { prepareJournal } from "./ledger";
import { financeBadRequest, financeConflict } from "./finance.errors";

type Context = { tenantId: string; companyId: string; tenantMembershipId: string; companyMembershipId: string; userId: string };
const dimensions = ["orderId", "orderLegId", "customerEntityId", "branchId", "warehouseId", "carrierProviderId", "costCenterCode", "profitCenterCode"] as const;
export function stableDraftJson(value: unknown): string {
  let count = 0;
  function visit(input: any, depth: number): any {
    if (++count > 20000 || depth > 12) throw financeBadRequest("Draft intent exceeds supported limits", "FINANCE_DRAFT_INTENT_LIMIT");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input; // JSON metadata, never money.
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    if (input && typeof input === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(input)))
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, visit(input[key], depth + 1)]));
    throw financeBadRequest("Draft metadata must be bounded JSON", "FINANCE_DRAFT_INTENT_INVALID");
  }
  const result = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(result, "utf8") > 262144) throw financeBadRequest("Draft intent exceeds supported limits", "FINANCE_DRAFT_INTENT_LIMIT");
  return result;
}
function amount(value: string) {
  if (typeof value !== "string" || value.length > 64) throw financeBadRequest("Invalid draft decimal", "FINANCE_DRAFT_INTENT_INVALID");
  try { const parsed = new Decimal(value); if (!parsed.isFinite()) throw Error(); return parsed.toString(); }
  catch { throw financeBadRequest("Invalid draft decimal", "FINANCE_DRAFT_INTENT_INVALID"); }
}
function date(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw financeBadRequest("Invalid draft date", "FINANCE_DRAFT_INTENT_INVALID");
  return value.toISOString();
}
function reference(value: any) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : value; }
function lineFields(line: any) {
  return { accountId: reference(line.accountId), description: line.description ?? null,
    ...Object.fromEntries(dimensions.map(key => [key, key.endsWith("Id") ? reference(line[key] ?? null) : line[key] ?? null])), metadata: line.metadata ?? null };
}

export function buildDraftIntent(command: CreateJournalCommand, context: Context, entity: { id: string; baseCurrency: string }) {
  const allowed = ["companyId", "actorUserId", "idempotencyKey", "documentDate", "postingDate", "currency", "fxRate", "fxRateAsOf", "description", "sourceType", "sourceId", "sourceEventId", "metadata", "lines"];
  if (!command || typeof command !== "object" || Object.keys(command).some(key => !allowed.includes(key)) || typeof command.idempotencyKey !== "string"
    || command.idempotencyKey.length < 8 || command.idempotencyKey.length > 200 || !Array.isArray(command.lines) || command.lines.length > 500)
    throw financeBadRequest("Invalid draft intent", "FINANCE_DRAFT_INTENT_INVALID");
  for (const line of command.lines) if (!line || typeof line !== "object" || Object.keys(line).some(key => !["accountId", "debitAmount", "creditAmount", "description", "metadata", ...dimensions].includes(key)))
    throw financeBadRequest("Unknown draft line field", "FINANCE_DRAFT_INTENT_INVALID");
  const rawLines = command.lines.map(line => ({ ...line, debitAmount: amount(line.debitAmount), creditAmount: amount(line.creditAmount) }));
  const requestedRate = amount(command.fxRate);
  if (new Decimal(requestedRate).decimalPlaces() > 10) throw financeBadRequest("FX precision exceeds storage representation", "FINANCE_DRAFT_INTENT_INVALID");
  const prepared = prepareJournal({ currency: command.currency, baseCurrency: entity.baseCurrency, fxRate: requestedRate, lines: rawLines });
  const document = { documentDate: date(command.documentDate).slice(0, 10), postingDate: date(command.postingDate).slice(0, 10),
    currency: prepared.currency, fxRateAsOf: command.fxRateAsOf ? date(command.fxRateAsOf) : null,
    description: command.description ?? null, sourceType: command.sourceType ?? null, sourceId: command.sourceId ?? null,
    sourceEventId: command.sourceEventId ?? null, metadata: command.metadata ?? null };
  const fingerprint = createHash("sha256").update(stableDraftJson({ version: 1, context: { tenantId: context.tenantId, companyId: context.companyId, tenantMembershipId: context.tenantMembershipId, companyMembershipId: context.companyMembershipId, userId: context.userId }, legalEntityId: entity.id, baseCurrency: entity.baseCurrency,
    idempotencyKey: command.idempotencyKey, document, requestedFxRate: amount(command.fxRate),
    lines: command.lines.map(line => ({ ...lineFields(line), debitAmount: amount(line.debitAmount), creditAmount: amount(line.creditAmount) })) })).digest("hex");
  const snapshot = { document: { ...document, totalAmount: prepared.totalDebit.toString(), baseAmount: prepared.totalDebitBase.toString(), fxRate: prepared.fxRate.toString() },
    postingDate: document.postingDate, description: document.description,
    totalDebitBase: prepared.totalDebitBase.toString(), totalCreditBase: prepared.totalCreditBase.toString(),
    lines: prepared.lines.map(line => ({ ...lineFields(line), lineNumber: line.lineNumber, debitAmount: line.debitAmount.toString(),
      creditAmount: line.creditAmount.toString(), debitBase: line.debitBase.toString(), creditBase: line.creditBase.toString(), currency: prepared.currency, fxRate: prepared.fxRate.toString() })) };
  return { fingerprint, prepared, snapshot, creatorUserId: context.userId, binding: { draftIntentHash: fingerprint, draftTenantId: context.tenantId, draftCompanyId: context.companyId,
    draftTenantMembershipId: context.tenantMembershipId, draftCompanyMembershipId: context.companyMembershipId } };
}

export function assertDraftRetry(journal: any, intent: ReturnType<typeof buildDraftIntent>) {
  const reject = () => { throw financeConflict("Draft idempotency key conflicts or has no verified intent binding", "FINANCE_DRAFT_IDEMPOTENCY_CONFLICT"); };
  const doc = journal.document;
  if (doc.createdByUserId !== intent.creatorUserId || doc.type !== "manual_journal" || doc.status !== "draft" || journal.status !== "draft"
    || Object.entries(intent.binding).some(([key, value]) => doc[key] !== value)) reject();
  const snapshot = { document: { documentDate: date(doc.documentDate).slice(0, 10), postingDate: date(doc.postingDate).slice(0, 10),
    currency: doc.currency, fxRateAsOf: doc.fxRateAsOf ? date(doc.fxRateAsOf) : null, description: doc.description ?? null,
    sourceType: doc.sourceType ?? null, sourceId: doc.sourceId ?? null, sourceEventId: doc.sourceEventId ?? null, metadata: doc.metadataJson ?? null,
    totalAmount: doc.totalAmount.toString(), baseAmount: doc.baseAmount.toString(), fxRate: doc.fxRate.toString() },
    postingDate: date(journal.postingDate).slice(0, 10), description: journal.description ?? null,
    totalDebitBase: journal.totalDebitBase.toString(), totalCreditBase: journal.totalCreditBase.toString(),
    lines: journal.lines.map((line: any) => ({ ...lineFields({ ...line, metadata: line.metadataJson }), lineNumber: line.lineNumber,
      debitAmount: line.debitAmount.toString(), creditAmount: line.creditAmount.toString(), debitBase: line.debitBase.toString(),
      creditBase: line.creditBase.toString(), currency: line.currency, fxRate: line.fxRate.toString() })) };
  if (stableDraftJson(snapshot) !== stableDraftJson(intent.snapshot)) reject();
}

/** Preserve the inspected journal DTO without serializing dedicated receipt fields or raw metadata. */
export function projectDraftResult(journal: any) {
  const pick = (row: any, keys: string[]) => Object.fromEntries(keys.map(key => [key, row[key]]));
  return { ...pick(journal, ["id", "legalEntityId", "documentId", "journalNumber", "status", "postingDate", "description", "totalDebitBase", "totalCreditBase", "postedAt", "reversedAt", "reversalOfId", "createdAt", "updatedAt"]),
    document: pick(journal.document, ["id", "documentNumber", "status", "documentDate", "postingDate", "currency", "totalAmount", "baseAmount", "fxRate", "description", "sourceType", "sourceId"]),
    lines: journal.lines.map((line: any) => ({ ...pick(line, ["id", "lineNumber", "accountId", "debitAmount", "creditAmount", "currency", "fxRate", "debitBase", "creditBase", "description"]),
      account: pick(line.account, ["id", "legalEntityId", "code", "name", "type", "status", "parentId", "allowPosting", "isControlAccount", "currency", "description", "createdAt", "updatedAt"]) })) };
}
