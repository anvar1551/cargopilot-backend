import { financeConflict } from "./finance.errors";

/** No durable approved invoice pricing/FX execution capability exists yet. */
export function rejectUnacceptedInvoiceExecution(record: {
  sourceType?: unknown; eventType?: unknown; sourceEventId?: unknown; payloadJson?: unknown;
}) {
  const payload = record.payloadJson as Record<string, unknown> | null | undefined;
  const invoice = (value: unknown) => typeof value === "string" && value.startsWith("invoice:");
  const event = (value: unknown) => typeof value === "string" && value.startsWith("invoice.");
  if (record.sourceType === "invoice" || event(record.eventType) || invoice(record.sourceEventId) ||
      payload?.sourceType === "invoice" || event(payload?.eventType) || invoice(payload?.sourceEventId)) {
    throw financeConflict("Invoice execution requires approved durable pricing and FX acceptance",
      "FINANCE_INVOICE_AUTHORITY_REQUIRED");
  }
}
