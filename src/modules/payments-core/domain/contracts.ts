import {
  PaymentEnvironment,
  PaymentIntentStatus,
  PaymentProvider,
} from "@prisma/client";

export type CanonicalPaymentStatus =
  | "pending"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "partially_refunded";

export type ProviderCode = PaymentProvider;

export type CreatePaymentIntentInput = {
  companyId: string;
  orderId: string;
  amountMinor: bigint;
  currency: string;
  provider?: ProviderCode;
  idempotencyKey: string;
  returnUrl?: string;
  metadata?: Record<string, unknown>;
};

export type CreatePaymentIntentResult = {
  paymentIntentId: string;
  status: CanonicalPaymentStatus;
  checkoutUrl?: string | null;
  providerPaymentId?: string | null;
};

export type RefundInput = {
  companyId: string;
  paymentIntentId: string;
  amountMinor?: bigint;
  reason?: string;
  idempotencyKey: string;
};

export type ProviderWebhookInput = {
  provider: ProviderCode;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  environment: PaymentEnvironment;
};

export function toCanonicalStatus(status: PaymentIntentStatus): CanonicalPaymentStatus {
  switch (status) {
    case PaymentIntentStatus.REQUIRES_ACTION:
      return "requires_action";
    case PaymentIntentStatus.PROCESSING:
      return "processing";
    case PaymentIntentStatus.SUCCEEDED:
      return "succeeded";
    case PaymentIntentStatus.FAILED:
      return "failed";
    case PaymentIntentStatus.CANCELED:
      return "canceled";
    case PaymentIntentStatus.REFUNDED:
      return "refunded";
    case PaymentIntentStatus.PARTIALLY_REFUNDED:
      return "partially_refunded";
    case PaymentIntentStatus.PENDING:
    default:
      return "pending";
  }
}
