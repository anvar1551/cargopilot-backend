import { financeConflict } from "./finance.errors";

/** No source-specific accepted extraction is implemented for generic outbox payloads. */
export function rejectUnsupportedGenericFinanceIngestion(): never {
  throw financeConflict("Finance source requires source-specific durable authority", "FINANCE_SOURCE_AUTHORITY_REQUIRED");
}
/** An active rule/conditions/account configuration is not independent acceptance. */
export function rejectUnapprovedAutomaticPosting(): void {
  throw financeConflict("Automatic posting requires an independently accepted immutable rule version", "FINANCE_POSTING_RULE_APPROVAL_REQUIRED");
}
export function requireSupportedFinanceSource(record: any) {
  if (record?.sourceType === "cash_custody" || (typeof record?.sourceEventId === "string" && record.sourceEventId.startsWith("cash:")) || record?.payloadJson?.sourceType === "cash_custody") return;
  rejectUnsupportedGenericFinanceIngestion();
}
