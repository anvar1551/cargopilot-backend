import {
  PaymentEnvironment,
  PaymentIntent,
  PaymentProvider,
  PaymentProviderConfig,
} from "@prisma/client";
import {
  CanonicalPaymentStatus,
  ProviderWebhookInput,
} from "../../domain/contracts";
import { ClickProviderAdapter } from "./clickAdapter";
import { PaymeProviderAdapter } from "./paymeAdapter";
import { StripeProviderAdapter } from "./stripeAdapter";
import { UzumProviderAdapter } from "./uzumAdapter";

export type ResolvedProviderConfig = Pick<
  PaymentProviderConfig,
  | "id"
  | "companyId"
  | "provider"
  | "environment"
  | "merchantId"
  | "serviceId"
  | "accountId"
  | "isEnabled"
> & {
  secretPlain: string;
};

export type VerifyWebhookResult = {
  isValid: boolean;
  externalEventId?: string;
  idempotencyKey: string;
  mappedStatus?: CanonicalPaymentStatus;
  providerPaymentId?: string;
  rawEvent?: unknown;
  responsePayload?: Record<string, unknown>;
};

export interface PaymentProviderAdapter {
  provider: PaymentProvider;

  createPayment(input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
  }): Promise<{
    providerPaymentId?: string;
    providerInvoiceId?: string;
    checkoutUrl?: string;
    rawResponse?: unknown;
  }>;

  getStatus(input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
  }): Promise<{
    status: CanonicalPaymentStatus;
    rawResponse?: unknown;
  }>;

  refund(input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
    amountMinor?: bigint;
    reason?: string;
    idempotencyKey: string;
  }): Promise<{
    status: CanonicalPaymentStatus;
    rawResponse?: unknown;
  }>;

  verifyWebhook(input: ProviderWebhookInput & {
    config: ResolvedProviderConfig;
    intent?: PaymentIntent | null;
    rawBody?: string | Buffer;
  }): Promise<VerifyWebhookResult>;
}

class NotImplementedProviderAdapter implements PaymentProviderAdapter {
  provider: PaymentProvider;

  constructor(provider: PaymentProvider) {
    this.provider = provider;
  }

  async createPayment(_input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
  }) {
    return {
      rawResponse: { reason: `${this.provider} adapter is not implemented yet` },
    };
  }

  async getStatus(_input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
  }) {
    return { status: "pending" as const, rawResponse: { reason: "not_implemented" } };
  }

  async refund(_input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
    amountMinor?: bigint;
    reason?: string;
    idempotencyKey: string;
  }) {
    return {
      status: "failed" as const,
      rawResponse: { reason: `${this.provider} adapter refund is not implemented yet` },
    };
  }

  async verifyWebhook(
    input: ProviderWebhookInput & {
      config: ResolvedProviderConfig;
      intent?: PaymentIntent | null;
      rawBody?: string | Buffer;
    },
  ) {
    const idempotencyKey =
      (typeof input.headers["x-idempotency-key"] === "string"
        ? input.headers["x-idempotency-key"]
        : undefined) ?? `${input.provider}:${Date.now()}`;

    return {
      isValid: false,
      idempotencyKey,
      rawEvent: input.body,
    };
  }
}

const adapters = new Map<PaymentProvider, PaymentProviderAdapter>([
  [PaymentProvider.CLICK, new ClickProviderAdapter()],
  [PaymentProvider.PAYME, new PaymeProviderAdapter()],
  [PaymentProvider.UZUM, new UzumProviderAdapter()],
  [PaymentProvider.STRIPE, new StripeProviderAdapter()],
]);

export function getPaymentProviderAdapter(provider: PaymentProvider): PaymentProviderAdapter {
  return adapters.get(provider) ?? new NotImplementedProviderAdapter(provider);
}

export function parsePaymentEnvironment(raw: string | undefined): PaymentEnvironment {
  const text = String(raw ?? "").trim().toUpperCase();
  if (text === "PRODUCTION") return PaymentEnvironment.PRODUCTION;
  return PaymentEnvironment.TEST;
}
