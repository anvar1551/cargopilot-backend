import Decimal from "decimal.js";
import { financeBadRequest } from "./finance.errors";

export const FINANCE_CURRENCIES = ["UZS", "USD", "CNY"] as const;
export type FinanceCurrency = (typeof FINANCE_CURRENCIES)[number];

export type JournalLineInput = {
  accountId: string;
  debitAmount: string;
  creditAmount: string;
  description?: string;
  orderId?: string;
  orderLegId?: string;
  customerEntityId?: string;
  branchId?: string;
  warehouseId?: string;
  carrierProviderId?: string;
  costCenterCode?: string;
  profitCenterCode?: string;
  metadata?: Record<string, unknown>;
};

export type PreparedJournalLine = Omit<JournalLineInput, "debitAmount" | "creditAmount"> & {
  lineNumber: number;
  debitAmount: Decimal;
  creditAmount: Decimal;
  debitBase: Decimal;
  creditBase: Decimal;
};

export type PreparedJournal = {
  currency: FinanceCurrency;
  fxRate: Decimal;
  totalDebit: Decimal;
  totalCredit: Decimal;
  totalDebitBase: Decimal;
  totalCreditBase: Decimal;
  lines: PreparedJournalLine[];
};

const MONEY_SCALE = 4;

function decimal(value: string, field: string) {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw financeBadRequest(`${field} must be a valid decimal amount`, "FINANCE_INVALID_AMOUNT");
  }
}

function money(value: Decimal) {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

export function assertFinanceCurrency(value: string): FinanceCurrency {
  const currency = value.trim().toUpperCase();
  if (!FINANCE_CURRENCIES.includes(currency as FinanceCurrency)) {
    throw financeBadRequest(
      `Unsupported finance currency ${currency || value}. Allowed: ${FINANCE_CURRENCIES.join(", ")}`,
      "FINANCE_UNSUPPORTED_CURRENCY",
    );
  }
  return currency as FinanceCurrency;
}

export function prepareJournal(input: {
  currency: string;
  baseCurrency: string;
  fxRate: string;
  lines: JournalLineInput[];
}): PreparedJournal {
  const currency = assertFinanceCurrency(input.currency);
  const baseCurrency = assertFinanceCurrency(input.baseCurrency);
  const requestedRate = decimal(input.fxRate, "fxRate");
  const fxRate = currency === baseCurrency ? new Decimal(1) : requestedRate;

  if (fxRate.lte(0)) {
    throw financeBadRequest("fxRate must be greater than zero", "FINANCE_INVALID_FX_RATE");
  }
  if (input.lines.length < 2) {
    throw financeBadRequest("A journal requires at least two lines", "FINANCE_TOO_FEW_LINES");
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  let totalDebitBase = new Decimal(0);
  let totalCreditBase = new Decimal(0);

  const lines = input.lines.map((line, index): PreparedJournalLine => {
    const debitAmount = money(decimal(line.debitAmount, `lines[${index}].debitAmount`));
    const creditAmount = money(decimal(line.creditAmount, `lines[${index}].creditAmount`));
    const hasDebit = debitAmount.gt(0);
    const hasCredit = creditAmount.gt(0);

    if (debitAmount.lt(0) || creditAmount.lt(0) || hasDebit === hasCredit) {
      throw financeBadRequest(
        `Journal line ${index + 1} must contain exactly one positive debit or credit amount`,
        "FINANCE_INVALID_JOURNAL_LINE",
      );
    }

    const debitBase = money(debitAmount.mul(fxRate));
    const creditBase = money(creditAmount.mul(fxRate));
    totalDebit = totalDebit.add(debitAmount);
    totalCredit = totalCredit.add(creditAmount);
    totalDebitBase = totalDebitBase.add(debitBase);
    totalCreditBase = totalCreditBase.add(creditBase);

    return {
      ...line,
      lineNumber: index + 1,
      debitAmount,
      creditAmount,
      debitBase,
      creditBase,
    };
  });

  if (!money(totalDebit).eq(money(totalCredit))) {
    throw financeBadRequest(
      `Journal is not balanced in ${currency}: debit ${totalDebit.toFixed(4)} != credit ${totalCredit.toFixed(4)}`,
      "FINANCE_UNBALANCED_JOURNAL",
    );
  }
  if (!money(totalDebitBase).eq(money(totalCreditBase))) {
    throw financeBadRequest(
      `Journal is not balanced in ${baseCurrency}`,
      "FINANCE_UNBALANCED_BASE_JOURNAL",
    );
  }

  return {
    currency,
    fxRate,
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
    totalDebitBase: money(totalDebitBase),
    totalCreditBase: money(totalCreditBase),
    lines,
  };
}

export function formatSequence(prefix: string, value: bigint, padding: number) {
  return `${prefix}${value.toString().padStart(padding, "0")}`;
}
