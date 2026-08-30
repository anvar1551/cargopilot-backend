import {
  assertPostingEvent,
  assertPostingRuleLines,
} from "../../src/modules/finance-core/domain/posting-rules";

const debitAccount = "00000000-0000-7000-8000-000000000001";
const creditAccount = "00000000-0000-7000-8000-000000000002";

describe("finance posting rules", () => {
  it("accepts registered source-event combinations", () => {
    expect(() => assertPostingEvent("payment", "payment.succeeded")).not.toThrow();
    expect(() => assertPostingEvent("carrier_cost", "carrier.cost_accrued")).not.toThrow();
    expect(() => assertPostingEvent("payable", "payable.payment_executed")).not.toThrow();
  });

  it("rejects mismatched source-event combinations", () => {
    expect(() => assertPostingEvent("invoice", "payment.succeeded")).toThrow(
      expect.objectContaining({ code: "FINANCE_POSTING_EVENT_UNSUPPORTED" }),
    );
  });

  it("accepts balanced amount-key shapes", () => {
    expect(() =>
      assertPostingRuleLines([
        { side: "debit", accountId: debitAccount, amountKey: "gross_amount" },
        { side: "credit", accountId: creditAccount, amountKey: "gross_amount" },
      ]),
    ).not.toThrow();
  });

  it("rejects rules missing a matching side for an amount key", () => {
    expect(() =>
      assertPostingRuleLines([
        { side: "debit", accountId: debitAccount, amountKey: "gross_amount" },
        { side: "credit", accountId: creditAccount, amountKey: "fee_amount" },
      ]),
    ).toThrow(expect.objectContaining({ code: "FINANCE_POSTING_RULE_UNBALANCED_SHAPE" }));
  });

  it("rejects duplicate full-amount lines that would multiply a posting", () => {
    expect(() =>
      assertPostingRuleLines([
        { side: "debit", accountId: debitAccount, amountKey: "gross_amount" },
        { side: "debit", accountId: creditAccount, amountKey: "gross_amount" },
        { side: "credit", accountId: creditAccount, amountKey: "gross_amount" },
      ]),
    ).toThrow(expect.objectContaining({ code: "FINANCE_POSTING_RULE_UNBALANCED_SHAPE" }));
  });
});
