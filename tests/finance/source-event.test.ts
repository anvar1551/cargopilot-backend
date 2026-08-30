import {
  documentTypeForSource,
  financeSourceEventHash,
  normalizeFinanceSourceEvent,
  postingRuleMatches,
} from "../../src/modules/finance-core/domain/source-event";

const baseEvent = {
  schemaVersion: 1 as const,
  sourceEventId: "payment:intent-1:succeeded",
  companyId: "00000000-0000-7000-8000-000000000001",
  sourceType: "payment" as const,
  eventType: "payment.succeeded",
  sourceId: "intent-1",
  actorUserId: "00000000-0000-7000-8000-000000000002",
  occurredAt: "2026-08-02T10:00:00.000Z",
  currency: "usd",
  fxRate: "12600.25",
  fxRateAsOf: "2026-08-02T09:59:00.000Z",
  amounts: { gross_amount: "18" },
  dimensions: { orderId: "00000000-0000-7000-8000-000000000003" },
  attributes: { provider: "STRIPE", channel: "checkout" },
  metadata: { providerPaymentId: "pi_123" },
};

describe("canonical finance source event", () => {
  it("normalizes currency, dates, amounts, and hashes deterministically", () => {
    const normalized = normalizeFinanceSourceEvent(baseEvent);
    const reordered = normalizeFinanceSourceEvent({
      ...baseEvent,
      metadata: { providerPaymentId: "pi_123" },
      amounts: { gross_amount: "18.00000" },
    });

    expect(normalized.currency).toBe("USD");
    expect(normalized.amounts.gross_amount).toBe("18.0000");
    expect(normalized.postingDate.toISOString()).toBe(baseEvent.occurredAt);
    expect(financeSourceEventHash(normalized)).toBe(financeSourceEventHash(reordered));
  });

  it("matches posting conditions against dimensions and attributes", () => {
    const event = normalizeFinanceSourceEvent(baseEvent);
    expect(postingRuleMatches(event, {
      currency: ["UZS", "USD"],
      provider: "STRIPE",
      orderId: baseEvent.dimensions.orderId,
    })).toBe(true);
    expect(postingRuleMatches(event, { provider: "PAYME" })).toBe(false);
  });

  it("rejects unsupported amount keys and non-positive amounts", () => {
    expect(() => normalizeFinanceSourceEvent({
      ...baseEvent,
      amounts: { unknown_amount: "10" } as any,
    })).toThrow(expect.objectContaining({ code: "FINANCE_SOURCE_EVENT_AMOUNT_KEY" }));
    expect(() => normalizeFinanceSourceEvent({
      ...baseEvent,
      amounts: { gross_amount: "0" },
    })).toThrow(expect.objectContaining({ code: "FINANCE_SOURCE_EVENT_AMOUNT_INVALID" }));
  });

  it("distinguishes approved carrier bills from estimated carrier accruals", () => {
    expect(documentTypeForSource("carrier_cost", "carrier.bill_approved")).toBe("carrier_bill");
    expect(documentTypeForSource("carrier_cost", "carrier.cost_accrued")).toBe(
      "carrier_cost_accrual",
    );
    expect(documentTypeForSource("payable", "payable.payment_executed")).toBe("payment");
  });
});
