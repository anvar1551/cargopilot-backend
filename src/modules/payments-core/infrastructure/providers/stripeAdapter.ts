import Stripe from "stripe";
import { PaymentIntent, PaymentProvider } from "@prisma/client";
import { ProviderWebhookInput } from "../../domain/contracts";
import {
  PaymentProviderAdapter,
  ResolvedProviderConfig,
  VerifyWebhookResult,
} from "./providerAdapter";

const STRIPE_API_VERSION = "2025-10-29.clover";

function toRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

function toStringValue(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "number" || typeof input === "bigint") return String(input);
  return "";
}

function toSafeNumber(amountMinor: bigint): number {
  const value = Number(amountMinor);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Amount is invalid for Stripe payment intent");
  }
  return value;
}

function mapStripePaymentIntentStatus(
  status: Stripe.PaymentIntent.Status | undefined,
): "pending" | "requires_action" | "processing" | "succeeded" | "failed" | "canceled" {
  if (!status) return "pending";
  if (status === "requires_action") return "requires_action";
  if (status === "processing") return "processing";
  if (status === "succeeded") return "succeeded";
  if (status === "canceled") return "canceled";
  if (status === "requires_payment_method" || status === "requires_confirmation") {
    return "pending";
  }
  return "failed";
}

function mapStripeCheckoutPaymentStatus(
  status: Stripe.Checkout.Session.PaymentStatus | null,
): "pending" | "succeeded" {
  return status === "paid" ? "succeeded" : "pending";
}

function buildCheckoutUrls(orderId: string) {
  const clientBase =
    process.env.CHECKOUT_RETURN_BASE_URL?.trim() ||
    process.env.CLIENT_URL?.trim() ||
    "http://localhost:3000";
  const normalizedBase = clientBase.replace(/\/+$/, "");
  return {
    successUrl: `${normalizedBase}/dashboard/orders/${orderId}?payment=success`,
    cancelUrl: `${normalizedBase}/dashboard/orders/${orderId}?payment=cancel`,
  };
}

function getStripeClient(secretKey: string) {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
}

function extractEventIntentId(event: Stripe.Event): string | undefined {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const metadata = toRecord(obj.metadata);
  const fromMetadata = toStringValue(metadata.paymentIntentId);
  if (fromMetadata) return fromMetadata;

  const paymentIntentRef = toStringValue(obj.payment_intent);
  if (paymentIntentRef) return paymentIntentRef;

  if (event.type.startsWith("payment_intent.")) {
    const directId = toStringValue(obj.id);
    if (directId) return directId;
  }

  return undefined;
}

export class StripeProviderAdapter implements PaymentProviderAdapter {
  provider: PaymentProvider = PaymentProvider.STRIPE;

  async createPayment(input: { config: ResolvedProviderConfig; intent: PaymentIntent }) {
    const stripe = getStripeClient(input.config.secretPlain);
    const amountMinor = toSafeNumber(input.intent.amountMinor);
    const currency = String(input.intent.currency || "USD").toLowerCase();
    const { successUrl, cancelUrl } = buildCheckoutUrls(input.intent.orderId);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: `CargoPilot order ${input.intent.orderId}`,
            },
            unit_amount: amountMinor,
          },
          quantity: 1,
        },
      ],
      metadata: {
        paymentIntentId: input.intent.id,
        orderId: input.intent.orderId,
        companyId: input.intent.companyId,
      },
      payment_intent_data: {
        metadata: {
          paymentIntentId: input.intent.id,
          orderId: input.intent.orderId,
          companyId: input.intent.companyId,
        },
      },
      client_reference_id: input.intent.id,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return {
      providerPaymentId: toStringValue(session.payment_intent) || undefined,
      providerInvoiceId: session.id,
      checkoutUrl: session.url ?? undefined,
      rawResponse: {
        sessionId: session.id,
        paymentIntent: toStringValue(session.payment_intent) || null,
        paymentStatus: session.payment_status,
        status: session.status,
      },
    };
  }

  async getStatus(input: { config: ResolvedProviderConfig; intent: PaymentIntent }) {
    const stripe = getStripeClient(input.config.secretPlain);

    if (input.intent.providerPaymentId) {
      const paymentIntent = await stripe.paymentIntents.retrieve(input.intent.providerPaymentId);
      return {
        status: mapStripePaymentIntentStatus(paymentIntent.status),
        rawResponse: {
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        },
      };
    }

    if (input.intent.providerInvoiceId) {
      const session = await stripe.checkout.sessions.retrieve(input.intent.providerInvoiceId);
      return {
        status: mapStripeCheckoutPaymentStatus(session.payment_status),
        rawResponse: {
          sessionId: session.id,
          paymentIntent: toStringValue(session.payment_intent) || null,
          paymentStatus: session.payment_status,
          status: session.status,
        },
      };
    }

    return {
      status: "pending" as const,
      rawResponse: { reason: "stripe_payment_reference_missing" },
    };
  }

  async refund(input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
    amountMinor?: bigint;
    reason?: string;
    idempotencyKey: string;
  }) {
    if (!input.intent.providerPaymentId) {
      return {
        status: "failed" as const,
        rawResponse: { reason: "stripe_payment_intent_missing" },
      };
    }

    const stripe = getStripeClient(input.config.secretPlain);
    const refund = await stripe.refunds.create(
      {
        payment_intent: input.intent.providerPaymentId,
        ...(input.amountMinor ? { amount: toSafeNumber(input.amountMinor) } : null),
        ...(input.reason ? { reason: "requested_by_customer" as const } : null),
        metadata: {
          paymentIntentId: input.intent.id,
          ...(input.reason ? { note: input.reason } : null),
        },
      },
      {
        idempotencyKey: input.idempotencyKey,
      },
    );

    const mappedStatus =
      refund.status === "succeeded" ? ("refunded" as const) : ("pending" as const);

    return {
      status: mappedStatus,
      rawResponse: {
        refundId: refund.id,
        status: refund.status,
      },
    };
  }

  async verifyWebhook(
    input: ProviderWebhookInput & {
      config: ResolvedProviderConfig;
      intent?: PaymentIntent | null;
      rawBody?: string | Buffer;
    },
  ): Promise<VerifyWebhookResult> {
    const rawBody =
      typeof input.rawBody === "string"
        ? input.rawBody
        : Buffer.isBuffer(input.rawBody)
          ? input.rawBody.toString("utf8")
          : JSON.stringify(input.body ?? {});
    const signatureHeaderRaw = input.headers["stripe-signature"];
    const signatureHeader = Array.isArray(signatureHeaderRaw)
      ? signatureHeaderRaw[0]
      : signatureHeaderRaw;
    const webhookSecret = input.config.serviceId ?? "";
    const stripe = getStripeClient(input.config.secretPlain);

    if (!signatureHeader || !webhookSecret) {
      return {
        isValid: false,
        idempotencyKey: `stripe:${Date.now()}`,
        rawEvent: input.body,
        responsePayload: {
          ok: false,
          error: "stripe_signature_or_webhook_secret_missing",
        },
      };
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
    } catch (error) {
      return {
        isValid: false,
        idempotencyKey: `stripe:${Date.now()}`,
        rawEvent: input.body,
        responsePayload: {
          ok: false,
          error: error instanceof Error ? error.message : "stripe_signature_verification_failed",
        },
      };
    }

    const paymentIntentIdFromEvent = extractEventIntentId(event);
    const providerPaymentId =
      toStringValue(toRecord(event.data.object).payment_intent) || paymentIntentIdFromEvent;

    let mappedStatus: VerifyWebhookResult["mappedStatus"] = undefined;
    if (event.type === "checkout.session.completed") mappedStatus = "succeeded";
    if (event.type === "checkout.session.async_payment_succeeded") mappedStatus = "succeeded";
    if (event.type === "checkout.session.async_payment_failed") mappedStatus = "failed";
    if (event.type === "payment_intent.processing") mappedStatus = "processing";
    if (event.type === "payment_intent.requires_action") mappedStatus = "requires_action";
    if (event.type === "payment_intent.succeeded") mappedStatus = "succeeded";
    if (event.type === "payment_intent.payment_failed") mappedStatus = "failed";
    if (event.type === "payment_intent.canceled") mappedStatus = "canceled";
    if (event.type === "charge.refunded") mappedStatus = "refunded";

    return {
      isValid: true,
      idempotencyKey: event.id,
      externalEventId: event.id,
      mappedStatus,
      providerPaymentId: providerPaymentId || undefined,
      rawEvent: event,
      responsePayload: {
        ok: true,
        eventId: event.id,
        type: event.type,
        paymentIntentId: paymentIntentIdFromEvent ?? null,
      },
    };
  }
}
