import Decimal from "decimal.js";
import prisma from "../../../config/prismaClient";
import { minorToMajorString } from "../shared/money";

type SettlementReferenceLine = {
  sequence: number;
  type: "payment" | "refund" | "fee" | "adjustment";
  amount: string;
  externalTransactionId?: string | null;
  paymentIntentId?: string | null;
  paymentRefundId?: string | null;
  orderId?: string | null;
};

function matchedAmount(amountMinor: bigint, currency: string, expected: string) {
  return new Decimal(minorToMajorString(amountMinor, currency)).eq(expected);
}

export async function resolveProviderSettlementReferences(args: {
  companyId: string;
  providerConfigId: string;
  currency: string;
  lines: SettlementReferenceLine[];
}) {
  const config = await prisma.paymentProviderConfig.findFirst({
    where: { id: args.providerConfigId, companyId: args.companyId },
    select: { id: true, provider: true, environment: true },
  });
  if (!config) {
    throw Object.assign(new Error("Payment provider config not found for this company"), {
      statusCode: 404,
    });
  }

  const paymentLines = args.lines.filter((line) => line.type === "payment");
  const refundLines = args.lines.filter((line) => line.type === "refund");
  const paymentIds = paymentLines.flatMap((line) => line.paymentIntentId ? [line.paymentIntentId] : []);
  const paymentExternalIds = paymentLines.flatMap((line) =>
    line.externalTransactionId ? [line.externalTransactionId] : [],
  );
  const refundIds = refundLines.flatMap((line) => line.paymentRefundId ? [line.paymentRefundId] : []);
  const refundExternalIds = refundLines.flatMap((line) =>
    line.externalTransactionId ? [line.externalTransactionId] : [],
  );

  const [payments, refunds] = await Promise.all([
    prisma.paymentIntent.findMany({
      where: {
        companyId: args.companyId,
        providerConfigId: config.id,
        OR: [
          ...(paymentIds.length ? [{ id: { in: paymentIds } }] : []),
          ...(paymentExternalIds.length ? [{ providerPaymentId: { in: paymentExternalIds } }] : []),
        ],
      },
      select: { id: true, orderId: true, amountMinor: true, currency: true, providerPaymentId: true },
    }),
    prisma.paymentRefund.findMany({
      where: {
        companyId: args.companyId,
        paymentIntent: { providerConfigId: config.id },
        OR: [
          ...(refundIds.length ? [{ id: { in: refundIds } }] : []),
          ...(refundExternalIds.length ? [{ providerRefundId: { in: refundExternalIds } }] : []),
        ],
      },
      select: {
        id: true,
        paymentIntentId: true,
        orderId: true,
        amountMinor: true,
        currency: true,
        providerRefundId: true,
        status: true,
      },
    }),
  ]);

  return {
    provider: {
      id: config.id,
      providerCode: config.provider,
      environment: config.environment,
    },
    lines: args.lines.map((line) => {
      if (line.type === "fee" || line.type === "adjustment") {
        return {
          ...line,
          reconciliationStatus: "ignored" as const,
          reconciliationMessage: "Statement-level accounting line",
        };
      }
      if (line.type === "payment") {
        const match = payments.find((payment) =>
          (line.paymentIntentId && payment.id === line.paymentIntentId) ||
          (line.externalTransactionId && payment.providerPaymentId === line.externalTransactionId),
        );
        if (!match) {
          return {
            ...line,
            reconciliationStatus: "unmatched" as const,
            reconciliationMessage: "No matching payment intent",
          };
        }
        const valid = match.currency === args.currency && matchedAmount(
          match.amountMinor,
          match.currency,
          line.amount,
        );
        return {
          ...line,
          paymentIntentId: match.id,
          orderId: match.orderId,
          reconciliationStatus: valid ? "matched" as const : "mismatch" as const,
          reconciliationMessage: valid ? null : "Payment amount or currency does not match",
        };
      }
      const match = refunds.find((refund) =>
        (line.paymentRefundId && refund.id === line.paymentRefundId) ||
        (line.externalTransactionId && refund.providerRefundId === line.externalTransactionId),
      );
      if (!match) {
        return {
          ...line,
          reconciliationStatus: "unmatched" as const,
          reconciliationMessage: "No matching payment refund",
        };
      }
      const valid = match.status === "succeeded" &&
        match.currency === args.currency &&
        matchedAmount(match.amountMinor, match.currency, line.amount);
      return {
        ...line,
        paymentIntentId: match.paymentIntentId,
        paymentRefundId: match.id,
        orderId: match.orderId,
        reconciliationStatus: valid ? "matched" as const : "mismatch" as const,
        reconciliationMessage: valid ? null : "Refund is not confirmed or amount/currency differs",
      };
    }),
  };
}
