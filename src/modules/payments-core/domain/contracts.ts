import { PaymentEnvironment, PaymentIntentStatus, PaymentProvider } from "@prisma/client";

export type ProviderCode = PaymentProvider;

export type CanonicalPaymentStatus =
  | "pending"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "partially_refunded";

export type CreatePaymentIntentInput = {
  companyId?: string;
  orderId: string;
  provider?: ProviderCode;
  amountMinor?: bigint;
  currency?: string;
  idempotencyKey: string;
  returnUrl?: string;
  metadata?: Record<string, unknown>;
};

export type ProviderWebhookInput = {
  provider: PaymentProvider;
  environment: PaymentEnvironment;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
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
