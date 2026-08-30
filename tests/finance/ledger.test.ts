import { FinanceError } from "../../src/modules/finance-core/domain/finance.errors";
import {
  assertFinanceCurrency,
  formatSequence,
  prepareJournal,
} from "../../src/modules/finance-core/domain/ledger";

const debitAccount = "00000000-0000-7000-8000-000000000001";
const creditAccount = "00000000-0000-7000-8000-000000000002";

function balancedJournal(overrides: Record<string, unknown> = {}) {
  return {
    currency: "USD",
    baseCurrency: "UZS",
    fxRate: "12500",
    lines: [
      { accountId: debitAccount, debitAmount: "18", creditAmount: "0" },
      { accountId: creditAccount, debitAmount: "0", creditAmount: "18" },
    ],
    ...overrides,
  } as Parameters<typeof prepareJournal>[0];
}

describe("finance ledger domain", () => {
  it.each(["UZS", "USD", "CNY", "usd"])('accepts supported currency %s', (currency) => {
    expect(assertFinanceCurrency(currency)).toBe(currency.toUpperCase());
  });

  it("rejects unsupported currencies", () => {
    expect(() => assertFinanceCurrency("EUR")).toThrow(
      expect.objectContaining<Partial<FinanceError>>({
        code: "FINANCE_UNSUPPORTED_CURRENCY",
        statusCode: 400,
      }),
    );
  });

  it("prepares a balanced foreign-currency journal", () => {
    const result = prepareJournal(balancedJournal());
    expect(result.totalDebit.toFixed(4)).toBe("18.0000");
    expect(result.totalCredit.toFixed(4)).toBe("18.0000");
    expect(result.totalDebitBase.toFixed(4)).toBe("225000.0000");
    expect(result.totalCreditBase.toFixed(4)).toBe("225000.0000");
  });

  it("forces an exchange rate of one for base-currency journals", () => {
    const result = prepareJournal(
      balancedJournal({ currency: "UZS", baseCurrency: "UZS", fxRate: "999" }),
    );
    expect(result.fxRate.toString()).toBe("1");
    expect(result.totalDebitBase.toFixed(4)).toBe("18.0000");
  });

  it("rejects unbalanced journals", () => {
    expect(() =>
      prepareJournal(
        balancedJournal({
          lines: [
            { accountId: debitAccount, debitAmount: "18", creditAmount: "0" },
            { accountId: creditAccount, debitAmount: "0", creditAmount: "17" },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "FINANCE_UNBALANCED_JOURNAL" }));
  });

  it("rejects lines containing both debit and credit", () => {
    expect(() =>
      prepareJournal(
        balancedJournal({
          lines: [
            { accountId: debitAccount, debitAmount: "18", creditAmount: "1" },
            { accountId: creditAccount, debitAmount: "0", creditAmount: "17" },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "FINANCE_INVALID_JOURNAL_LINE" }));
  });

  it("rejects journals with fewer than two lines", () => {
    expect(() =>
      prepareJournal(
        balancedJournal({
          lines: [{ accountId: debitAccount, debitAmount: "18", creditAmount: "0" }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "FINANCE_TOO_FEW_LINES" }));
  });

  it("rounds monetary values to four decimal places deterministically", () => {
    const result = prepareJournal(
      balancedJournal({
        fxRate: "1.234567",
        lines: [
          { accountId: debitAccount, debitAmount: "1.11115", creditAmount: "0" },
          { accountId: creditAccount, debitAmount: "0", creditAmount: "1.11115" },
        ],
      }),
    );
    expect(result.totalDebit.toFixed(4)).toBe("1.1112");
    expect(result.totalDebitBase.toFixed(4)).toBe("1.3719");
  });

  it("formats auditable document sequences", () => {
    expect(formatSequence("GJ-", 42n, 8)).toBe("GJ-00000042");
  });
});
