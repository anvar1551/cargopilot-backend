import { financeBadRequest } from "./finance.errors";

export const FINANCE_POSTING_EVENTS = {
  invoice: ["invoice.issued", "invoice.credit_note_issued"],
  payment: ["payment.succeeded", "payment.provider_fee_recorded"],
  refund: ["payment.refunded"],
  cash_custody: ["cash.collected", "cash.handed_off", "cash.settled"],
  carrier_cost: ["carrier.cost_accrued", "carrier.bill_approved"],
  payable: ["payable.payment_executed"],
} as const;

export const FINANCE_AMOUNT_KEYS = [
  "gross_amount",
  "net_amount",
  "tax_amount",
  "fee_amount",
  "service_charge",
  "cod_amount",
  "refund_amount",
  "carrier_cost",
  "payable_amount",
] as const;

export type FinancePostingSource = keyof typeof FINANCE_POSTING_EVENTS;
export type FinanceAmountKey = (typeof FINANCE_AMOUNT_KEYS)[number];

export type PostingRuleLineInput = {
  side: "debit" | "credit";
  accountId: string;
  amountKey: FinanceAmountKey;
  descriptionTemplate?: string | null;
  dimensions?: Record<string, unknown>;
};

export function assertPostingEvent(sourceType: string, eventType: string) {
  const events = FINANCE_POSTING_EVENTS[sourceType as FinancePostingSource] as readonly string[] | undefined;
  if (!events?.includes(eventType)) {
    throw financeBadRequest(
      `Unsupported posting event ${sourceType}:${eventType}`,
      "FINANCE_POSTING_EVENT_UNSUPPORTED",
    );
  }
}

export function assertPostingRuleLines(lines: PostingRuleLineInput[]) {
  if (lines.length < 2) {
    throw financeBadRequest("A posting rule requires at least two lines", "FINANCE_POSTING_RULE_TOO_FEW_LINES");
  }
  const debitLines = lines.filter((line) => line.side === "debit");
  const creditLines = lines.filter((line) => line.side === "credit");
  const debitKeys = new Set(debitLines.map((line) => line.amountKey));
  const creditKeys = new Set(creditLines.map((line) => line.amountKey));
  if (debitKeys.size === 0 || creditKeys.size === 0) {
    throw financeBadRequest(
      "A posting rule requires both debit and credit lines",
      "FINANCE_POSTING_RULE_UNBALANCED_SHAPE",
    );
  }
  for (const key of debitKeys) {
    if (!creditKeys.has(key)) {
      throw financeBadRequest(
        `Amount key ${key} must appear on both debit and credit sides`,
        "FINANCE_POSTING_RULE_UNBALANCED_SHAPE",
      );
    }
  }
  for (const key of creditKeys) {
    if (!debitKeys.has(key)) {
      throw financeBadRequest(
        `Amount key ${key} must appear on both debit and credit sides`,
        "FINANCE_POSTING_RULE_UNBALANCED_SHAPE",
      );
    }
  }
  for (const key of debitKeys) {
    const debitCount = debitLines.filter((line) => line.amountKey === key).length;
    const creditCount = creditLines.filter((line) => line.amountKey === key).length;
    if (debitCount !== 1 || creditCount !== 1) {
      throw financeBadRequest(
        `Amount key ${key} currently requires exactly one debit and one credit line`,
        "FINANCE_POSTING_RULE_UNBALANCED_SHAPE",
      );
    }
  }
}
