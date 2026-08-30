import { PaymentIntentStatus, PaymentRefundStatus } from "@prisma/client";
import {
  mapProviderRefundStatus,
  paymentStatusAfterSuccessfulRefund,
  resolveRefundAmount,
} from "../../src/modules/payments-core/domain/refunds";

describe("payment refund domain", () => {
  it("defaults to the remaining refundable amount", () => {
    expect(resolveRefundAmount({
      paidAmountMinor: 10_000n,
      reservedRefundAmountsMinor: [2_500n, 1_500n],
    })).toEqual({
      amountMinor: 6_000n,
      alreadyRefundedMinor: 4_000n,
      remainingAmountMinor: 6_000n,
    });
  });

  it("rejects zero, over-refund, and fully-refunded requests", () => {
    expect(() => resolveRefundAmount({
      paidAmountMinor: 10_000n,
      reservedRefundAmountsMinor: [],
      requestedAmountMinor: 0n,
    })).toThrow(RangeError);
    expect(() => resolveRefundAmount({
      paidAmountMinor: 10_000n,
      reservedRefundAmountsMinor: [4_000n],
      requestedAmountMinor: 6_001n,
    })).toThrow(RangeError);
    expect(() => resolveRefundAmount({
      paidAmountMinor: 10_000n,
      reservedRefundAmountsMinor: [10_000n],
    })).toThrow(RangeError);
  });

  it("maps provider and aggregate states deterministically", () => {
    expect(mapProviderRefundStatus("refunded")).toBe(PaymentRefundStatus.succeeded);
    expect(mapProviderRefundStatus("processing")).toBe(PaymentRefundStatus.processing);
    expect(mapProviderRefundStatus("canceled")).toBe(PaymentRefundStatus.cancelled);
    expect(mapProviderRefundStatus("failed")).toBe(PaymentRefundStatus.failed);
    expect(paymentStatusAfterSuccessfulRefund(10_000n, 4_000n)).toBe(
      PaymentIntentStatus.PARTIALLY_REFUNDED,
    );
    expect(paymentStatusAfterSuccessfulRefund(10_000n, 10_000n)).toBe(
      PaymentIntentStatus.REFUNDED,
    );
  });
});
