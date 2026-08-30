import { PaymentIntentStatus, PaymentRefundStatus } from "@prisma/client";

export function resolveRefundAmount(args: {
  paidAmountMinor: bigint;
  reservedRefundAmountsMinor: bigint[];
  requestedAmountMinor?: bigint;
}) {
  const alreadyRefundedMinor = args.reservedRefundAmountsMinor.reduce(
    (total, amount) => total + amount,
    0n,
  );
  const remainingAmountMinor = args.paidAmountMinor - alreadyRefundedMinor;
  const amountMinor = args.requestedAmountMinor ?? remainingAmountMinor;
  if (amountMinor <= 0n || amountMinor > remainingAmountMinor) {
    throw new RangeError("Refund amount exceeds the remaining refundable amount");
  }
  return { amountMinor, alreadyRefundedMinor, remainingAmountMinor };
}

export function mapProviderRefundStatus(status: string): PaymentRefundStatus {
  if (status === "refunded") return PaymentRefundStatus.succeeded;
  if (status === "pending" || status === "processing") return PaymentRefundStatus.processing;
  if (status === "canceled") return PaymentRefundStatus.cancelled;
  return PaymentRefundStatus.failed;
}

export function paymentStatusAfterSuccessfulRefund(
  paidAmountMinor: bigint,
  refundedAmountMinor: bigint,
) {
  return refundedAmountMinor >= paidAmountMinor
    ? PaymentIntentStatus.REFUNDED
    : PaymentIntentStatus.PARTIALLY_REFUNDED;
}
