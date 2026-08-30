import { createHash } from "crypto";
import Decimal from "decimal.js";
import { financeBadRequest, financeConflict } from "./finance.errors";
import { assertFinanceCurrency } from "./ledger";

function positiveAmount(value: string, field: string) {
  try {
    const amount = new Decimal(value);
    if (!amount.isFinite() || amount.lte(0)) throw new Error("not positive");
    return amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  } catch {
    throw financeBadRequest(`${field} must be a positive decimal`, "FINANCE_TREASURY_AMOUNT_INVALID");
  }
}

function signedAmount(value: string, field: string) {
  try {
    const amount = new Decimal(value);
    if (!amount.isFinite()) throw new Error("not finite");
    return amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  } catch {
    throw financeBadRequest(`${field} must be a decimal`, "FINANCE_TREASURY_AMOUNT_INVALID");
  }
}

export function secureBankIdentifier(identifier: string) {
  const normalized = identifier.replace(/\s+/g, "").toUpperCase();
  if (normalized.length < 4 || normalized.length > 100) {
    throw financeBadRequest(
      "Bank account identifier must contain between 4 and 100 characters",
      "FINANCE_BANK_IDENTIFIER_INVALID",
    );
  }
  const visible = normalized.slice(-4);
  return {
    hash: createHash("sha256").update(normalized).digest("hex"),
    masked: `${"*".repeat(Math.min(12, Math.max(4, normalized.length - 4)))}${visible}`,
  };
}

export type PaymentRunLineInput = { payableItemId: string; amount: string };

export function preparePaymentRun(input: {
  paymentDate: Date;
  currency: string;
  fxRate: string;
  fxRateAsOf?: Date | null;
  lines: PaymentRunLineInput[];
}) {
  if (input.lines.length === 0) {
    throw financeBadRequest("Payment run requires at least one payable", "FINANCE_PAYMENT_RUN_EMPTY");
  }
  const seen = new Set<string>();
  const lines = input.lines.map((line, index) => {
    if (seen.has(line.payableItemId)) {
      throw financeConflict("A payable may appear only once per payment run", "FINANCE_PAYMENT_RUN_DUPLICATE_PAYABLE");
    }
    seen.add(line.payableItemId);
    return {
      sequence: index + 1,
      payableItemId: line.payableItemId,
      amount: positiveAmount(line.amount, `lines[${index}].amount`).toFixed(4),
    };
  });
  const totalAmount = lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  return {
    paymentDate: input.paymentDate,
    currency: assertFinanceCurrency(input.currency),
    fxRate: positiveAmount(input.fxRate, "fxRate").toFixed(10),
    fxRateAsOf: input.fxRateAsOf ?? null,
    totalAmount: totalAmount.toFixed(4),
    lines,
  };
}

export type BankStatementLineInput = {
  bookingDate: Date;
  valueDate?: Date | null;
  direction: "debit" | "credit";
  amount: string;
  externalTransactionId?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export function prepareBankStatement(input: {
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  openingBalance: string;
  reportedClosingBalance: string;
  lines: BankStatementLineInput[];
}) {
  if (input.periodStart > input.periodEnd) {
    throw financeBadRequest("periodStart must be on or before periodEnd", "FINANCE_BANK_PERIOD_INVALID");
  }
  if (input.lines.length === 0) {
    throw financeBadRequest("Bank statement requires at least one line", "FINANCE_BANK_STATEMENT_EMPTY");
  }
  const externalIds = new Set<string>();
  const lines = input.lines.map((line, index) => {
    if (line.bookingDate < input.periodStart || line.bookingDate > input.periodEnd) {
      throw financeBadRequest(
        `lines[${index}].bookingDate is outside the statement period`,
        "FINANCE_BANK_LINE_DATE_INVALID",
      );
    }
    const externalTransactionId = line.externalTransactionId?.trim() || null;
    if (externalTransactionId && externalIds.has(externalTransactionId)) {
      throw financeConflict(
        `Duplicate bank transaction ${externalTransactionId}`,
        "FINANCE_BANK_TRANSACTION_DUPLICATE",
      );
    }
    if (externalTransactionId) externalIds.add(externalTransactionId);
    return {
      ...line,
      sequence: index + 1,
      externalTransactionId,
      amount: positiveAmount(line.amount, `lines[${index}].amount`).toFixed(4),
    };
  });
  const openingBalance = signedAmount(input.openingBalance, "openingBalance");
  const totalDebits = lines
    .filter((line) => line.direction === "debit")
    .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  const totalCredits = lines
    .filter((line) => line.direction === "credit")
    .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  const closingBalance = openingBalance.plus(totalCredits).minus(totalDebits);
  const reported = signedAmount(input.reportedClosingBalance, "reportedClosingBalance");
  if (!closingBalance.equals(reported)) {
    throw financeConflict(
      `Statement closing balance ${reported.toFixed(4)} does not reconcile to ${closingBalance.toFixed(4)}`,
      "FINANCE_BANK_BALANCE_MISMATCH",
    );
  }
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency: assertFinanceCurrency(input.currency),
    openingBalance: openingBalance.toFixed(4),
    totalDebits: totalDebits.toFixed(4),
    totalCredits: totalCredits.toFixed(4),
    closingBalance: closingBalance.toFixed(4),
    lines,
  };
}
