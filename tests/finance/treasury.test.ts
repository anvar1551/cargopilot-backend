import {
  prepareBankStatement,
  preparePaymentRun,
  secureBankIdentifier,
} from "../../src/modules/finance-core/domain/treasury";

describe("finance treasury domain", () => {
  it("hashes normalized bank identifiers and exposes only a masked suffix", () => {
    const first = secureBankIdentifier("UZ 12 3456 7890");
    const second = secureBankIdentifier("uz1234567890");

    expect(first.hash).toBe(second.hash);
    expect(first.masked).toMatch(/\*+7890$/);
    expect(first.masked).not.toContain("123456");
  });

  it("builds exact payment-run totals and rejects duplicate payables", () => {
    expect(preparePaymentRun({
      paymentDate: new Date("2026-08-03T00:00:00.000Z"),
      currency: "usd",
      fxRate: "12600.25",
      lines: [
        { payableItemId: "payable-1", amount: "10.125" },
        { payableItemId: "payable-2", amount: "7.875" },
      ],
    })).toEqual(expect.objectContaining({
      currency: "USD",
      totalAmount: "18.0000",
      fxRate: "12600.2500000000",
    }));

    expect(() => preparePaymentRun({
      paymentDate: new Date("2026-08-03T00:00:00.000Z"),
      currency: "USD",
      fxRate: "1",
      lines: [
        { payableItemId: "same", amount: "5" },
        { payableItemId: "same", amount: "5" },
      ],
    })).toThrow(expect.objectContaining({ code: "FINANCE_PAYMENT_RUN_DUPLICATE_PAYABLE" }));
  });

  it("reconciles statement balances using credits minus debits", () => {
    const statement = prepareBankStatement({
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-31T00:00:00.000Z"),
      currency: "USD",
      openingBalance: "100",
      reportedClosingBalance: "115.50",
      lines: [
        {
          bookingDate: new Date("2026-08-03T00:00:00.000Z"),
          direction: "credit",
          amount: "25.50",
          externalTransactionId: "credit-1",
        },
        {
          bookingDate: new Date("2026-08-04T00:00:00.000Z"),
          direction: "debit",
          amount: "10",
          externalTransactionId: "debit-1",
        },
      ],
    });

    expect(statement).toEqual(expect.objectContaining({
      totalCredits: "25.5000",
      totalDebits: "10.0000",
      closingBalance: "115.5000",
    }));
  });

  it("rejects duplicate bank transactions and mismatched closing balances", () => {
    const base = {
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-31T00:00:00.000Z"),
      currency: "USD",
      openingBalance: "0",
      reportedClosingBalance: "20",
    };
    expect(() => prepareBankStatement({
      ...base,
      lines: [
        { bookingDate: base.periodStart, direction: "credit", amount: "10", externalTransactionId: "same" },
        { bookingDate: base.periodStart, direction: "credit", amount: "10", externalTransactionId: "same" },
      ],
    })).toThrow(expect.objectContaining({ code: "FINANCE_BANK_TRANSACTION_DUPLICATE" }));

    expect(() => prepareBankStatement({
      ...base,
      lines: [
        { bookingDate: base.periodStart, direction: "credit", amount: "19", externalTransactionId: "one" },
      ],
    })).toThrow(expect.objectContaining({ code: "FINANCE_BANK_BALANCE_MISMATCH" }));
  });
});
