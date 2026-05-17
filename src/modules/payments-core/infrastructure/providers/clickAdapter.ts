import { createHash } from "crypto";
import { PaymentIntent, PaymentProvider } from "@prisma/client";
import { ProviderWebhookInput } from "../../domain/contracts";
import { formatProviderAmount } from "../../shared/money";
import {
  PaymentProviderAdapter,
  ResolvedProviderConfig,
  VerifyWebhookResult,
} from "./providerAdapter";

const CLICK_BASE_URL = "https://api.click.uz/v2/merchant";

function sha1(input: string) {
  return createHash("sha1").update(input).digest("hex");
}

function md5(input: string) {
  return createHash("md5").update(input).digest("hex");
}

function parseRecord(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof input === "object") {
    return input as Record<string, unknown>;
  }
  return {};
}

function valueAsString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function valueAsNumber(record: Record<string, unknown>, key: string): number | null {
  const raw = valueAsString(record, key);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function headersForClick(config: ResolvedProviderConfig) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const auth = `${config.merchantId}:${sha1(`${timestamp}${config.secretPlain}`)}:${timestamp}`;
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Auth: auth,
  };
}

function throwIfMissingConfig(config: ResolvedProviderConfig) {
  if (!config.merchantId || !config.serviceId) {
    throw new Error("Click provider config requires merchantId and serviceId");
  }
}

async function fetchJson(input: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function mapClickWebhookStatus(args: {
  action: number | null;
  error: number | null;
}): "pending" | "succeeded" | "failed" | "canceled" {
  if (args.error !== null && args.error < 0) return "failed";
  if (args.action === 1) return "succeeded";
  return "pending";
}

export class ClickProviderAdapter implements PaymentProviderAdapter {
  provider: PaymentProvider = PaymentProvider.CLICK;

  async createPayment(input: { config: ResolvedProviderConfig; intent: PaymentIntent }) {
    throwIfMissingConfig(input.config);
    const amount = formatProviderAmount(
      input.intent.amountMinor,
      input.intent.currency,
      "CLICK",
    );
    const merchantTransId = input.intent.id;
    const requestBody: Record<string, unknown> = {
      service_id: input.config.serviceId,
      merchant_trans_id: merchantTransId,
      amount,
    };

    const response = await fetchJson(`${CLICK_BASE_URL}/invoice/create`, {
      method: "POST",
      headers: headersForClick(input.config),
      body: JSON.stringify(requestBody),
    });

    const payload = parseRecord(response.payload);
    const invoiceId = valueAsString(payload, "invoice_id") || undefined;
    const paymentLink = valueAsString(payload, "payment_link") || undefined;
    const clickPayUrl = paymentLink
      ? paymentLink
      : `https://my.click.uz/services/pay?service_id=${encodeURIComponent(input.config.serviceId!)}&merchant_id=${encodeURIComponent(input.config.merchantId!)}&amount=${encodeURIComponent(String(amount))}&transaction_param=${encodeURIComponent(merchantTransId)}`;

    return {
      providerPaymentId: valueAsString(payload, "payment_id") || undefined,
      providerInvoiceId: invoiceId,
      checkoutUrl: clickPayUrl,
      rawResponse: {
        ok: response.ok,
        status: response.status,
        request: requestBody,
        response: payload,
      },
    };
  }

  async getStatus(input: { config: ResolvedProviderConfig; intent: PaymentIntent }) {
    throwIfMissingConfig(input.config);
    if (!input.intent.providerInvoiceId) {
      return { status: "pending" as const, rawResponse: { reason: "invoice_id_missing" } };
    }

    const response = await fetchJson(
      `${CLICK_BASE_URL}/invoice/status/${encodeURIComponent(input.config.serviceId!)}/${encodeURIComponent(input.intent.providerInvoiceId)}`,
      {
        method: "GET",
        headers: headersForClick(input.config),
      },
    );

    const payload = parseRecord(response.payload);
    const clickStatus = valueAsNumber(payload, "status");
    let mappedStatus: "pending" | "succeeded" | "canceled" | "failed" = "pending";
    if (clickStatus !== null) {
      if (clickStatus > 0) mappedStatus = "succeeded";
      else if (clickStatus === -99) mappedStatus = "canceled";
      else if (clickStatus < 0) mappedStatus = "failed";
    }

    return {
      status: mappedStatus,
      rawResponse: { ok: response.ok, status: response.status, response: payload },
    };
  }

  async refund(input: {
    config: ResolvedProviderConfig;
    intent: PaymentIntent;
    amountMinor?: bigint;
    reason?: string;
    idempotencyKey: string;
  }) {
    throwIfMissingConfig(input.config);
    if (!input.intent.providerPaymentId) {
      return { status: "failed" as const, rawResponse: { reason: "provider_payment_id_missing" } };
    }

    const response = await fetchJson(
      `${CLICK_BASE_URL}/payment/reversal/${encodeURIComponent(input.config.serviceId!)}/${encodeURIComponent(input.intent.providerPaymentId)}`,
      {
        method: "DELETE",
        headers: headersForClick(input.config),
      },
    );
    const payload = parseRecord(response.payload);
    const errorCode = valueAsNumber(payload, "error_code");
    const mappedStatus = errorCode === 0 ? ("refunded" as const) : ("failed" as const);
    return {
      status: mappedStatus,
      rawResponse: { ok: response.ok, status: response.status, response: payload },
    };
  }

  async verifyWebhook(
    input: ProviderWebhookInput & { config: ResolvedProviderConfig },
  ): Promise<VerifyWebhookResult> {
    const body = parseRecord(input.body);
    const clickTransId = valueAsString(body, "click_trans_id");
    const serviceId = valueAsString(body, "service_id");
    const merchantTransId = valueAsString(body, "merchant_trans_id");
    const merchantPrepareId = valueAsString(body, "merchant_prepare_id");
    const amount = valueAsString(body, "amount");
    const action = valueAsString(body, "action");
    const error = valueAsString(body, "error");
    const signTime = valueAsString(body, "sign_time");
    const providedSign = valueAsString(body, "sign_string").toLowerCase();

    const signSeed =
      clickTransId +
      serviceId +
      input.config.secretPlain +
      merchantTransId +
      (action === "1" ? merchantPrepareId : "") +
      amount +
      action +
      signTime;
    const expectedSign = md5(signSeed).toLowerCase();
    const isValid =
      Boolean(clickTransId && serviceId && merchantTransId && amount && action && signTime) &&
      serviceId === (input.config.serviceId ?? "") &&
      providedSign.length > 0 &&
      expectedSign === providedSign;

    const mappedStatus = isValid
      ? mapClickWebhookStatus({
          action: Number.isFinite(Number(action)) ? Number(action) : null,
          error: Number.isFinite(Number(error)) ? Number(error) : null,
        })
      : undefined;

    return {
      isValid,
      idempotencyKey: clickTransId || `${input.provider}:${Date.now()}`,
      mappedStatus,
      providerPaymentId: clickTransId || undefined,
      externalEventId: valueAsString(body, "click_paydoc_id") || undefined,
      rawEvent: body,
      responsePayload: {
        click_trans_id: clickTransId,
        merchant_trans_id: merchantTransId,
        merchant_confirm_id: merchantTransId,
        merchant_prepare_id: merchantPrepareId || merchantTransId || "0",
        error: isValid ? 0 : -1,
        error_note: isValid ? "Success" : "SIGN CHECK FAILED!",
      },
    };
  }
}
