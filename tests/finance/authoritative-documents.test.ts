import {
  authoritativeDocumentHash,
  prepareCarrierBill,
  prepareProviderSettlement,
} from "../../src/modules/finance-core/domain/authoritative-documents";

describe("authoritative finance documents", () => {
  it("derives provider settlement totals exactly", () => {
    const result = prepareProviderSettlement({
      providerConfigId: "provider-config",
      providerCode: "STRIPE",
      environment: "TEST",
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-31T00:00:00.000Z"),
      currency: "usd",
      fxRate: "12600",
      fxRateAsOf: new Date("2026-07-31T00:00:00.000Z"),
      reportedNetAmount: "88",
      lines: [
        { type: "payment", amount: "100" },
        { type: "refund", amount: "10" },
        { type: "fee", amount: "3" },
        { type: "adjustment", amount: "1" },
      ],
    });
    expect(result).toEqual(expect.objectContaining({
      currency: "USD",
      grossAmount: "100.0000",
      refundAmount: "10.0000",
      feeAmount: "3.0000",
      adjustmentAmount: "1.0000",
      netAmount: "88.0000",
    }));
  });

  it("rejects a provider statement whose reported net does not reconcile", () => {
    expect(() => prepareProviderSettlement({
      providerConfigId: "provider-config",
      providerCode: "STRIPE",
      environment: "TEST",
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-31T00:00:00.000Z"),
      currency: "USD",
      fxRate: "1",
      reportedNetAmount: "99",
      lines: [{ type: "payment", amount: "100" }, { type: "fee", amount: "3" }],
    })).toThrow(expect.objectContaining({ code: "FINANCE_SETTLEMENT_RECONCILIATION_MISMATCH" }));
  });

  it("derives carrier subtotal, tax, and total from exact lines", () => {
    const result = prepareCarrierBill({
      carrierProviderId: "carrier",
      carrierCode: "fake_carrier",
      supplierInvoiceNumber: "SUP-100",
      invoiceDate: new Date("2026-07-31T00:00:00.000Z"),
      currency: "USD",
      fxRate: "12600",
      fxRateAsOf: new Date("2026-07-31T00:00:00.000Z"),
      reportedTotalAmount: "11",
      lines: [{
        orderId: "order",
        orderLegId: "leg",
        description: "Linehaul",
        quantity: "2.5",
        unitPrice: "4",
        taxAmount: "1",
      }],
    });
    expect(result).toEqual(expect.objectContaining({
      subtotalAmount: "10.0000",
      taxAmount: "1.0000",
      totalAmount: "11.0000",
    }));
    expect(result.lines[0]?.amount).toBe("10.0000");
  });

  it("produces a stable fingerprint independent of object key order", () => {
    expect(authoritativeDocumentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      authoritativeDocumentHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});
