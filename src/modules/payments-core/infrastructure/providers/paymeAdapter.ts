import { PaymentIntent, PaymentProvider } from "@prisma/client";
import { ProviderWebhookInput } from "../../domain/contracts";
import { formatProviderAmount } from "../../shared/money";
import {
  PaymentProviderAdapter,
  ResolvedProviderConfig,
  VerifyWebhookResult,
} from "./providerAdapter";

const PAYME_CHECKOUT_BASE = {
  TEST: "https://test.paycom.uz",
  PRODUCTION: "https://checkout.paycom.uz",
} as const;

type JsonRpcBody = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function parseRecord(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof input === "object") return input as Record<string, unknown>;
  return {};
}

function parseJsonRpcBody(input: unknown): JsonRpcBody {
  const body = parseRecord(input);
  return {
    jsonrpc: typeof body.jsonrpc === "string" ? body.jsonrpc : "2.0",
    id:
      typeof body.id === "string" || typeof body.id === "number" || body.id === null
        ? body.id
        : null,
    method: typeof body.method === "string" ? body.method : undefined,
    params: typeof body.params === "object" && body.params ? (body.params as Record<string, unknown>) : {},
  };
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const text = readString(record, key);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAuthorization(headers: Record<string, string | string[] | undefined>): string {
  const value = headers.authorization ?? headers.Authorization ?? headers["x-auth"];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function validateAuth(
  headers: Record<string, string | string[] | undefined>,
  secretPlain: string,
): boolean {
  const auth = getAuthorization(headers);
  if (!auth) return false;

  if (auth.toLowerCase().startsWith("basic ")) {
    const encoded = auth.slice(6).trim();
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const [, password] = decoded.split(":");
      return Boolean(password) && password === secretPlain;
    } catch {
      return false;
    }
  }

  if (auth.startsWith("Paycom:")) {
    return auth.slice("Paycom:".length) === secretPlain;
  }

  return false;
}

function mapIntentStatusByMethod(method: string, rpcParams: Record<string, unknown>) {
  if (method === "PerformTransaction") return "succeeded" as const;
  if (method === "CancelTransaction") {
    const reason = readNumber(rpcParams, "reason");
    if (reason === 5) return "refunded" as const;
    return "canceled" as const;
  }
  if (method === "CheckTransaction") {
    const state = readNumber(rpcParams, "state");
    if (state === 2) return "succeeded" as const;
    if (state === -1) return "canceled" as const;
  }
  return "pending" as const;
}

function buildRpcError(id: string | number | null | undefined, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

function buildRpcResult(
  id: string | number | null | undefined,
  payload: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: payload,
  };
}

function buildResultByMethod(args: {
  method: string;
  id: string | number | null | undefined;
  intent: PaymentIntent | null | undefined;
  params: Record<string, unknown>;
}) {
  const nowMs = Date.now();
  const transaction =
    readString(args.params, "id") || args.intent?.providerPaymentId || args.intent?.id || "";
  const createTime = args.intent?.createdAt?.getTime?.() ?? nowMs;
  const performTime =
    args.method === "PerformTransaction" || args.intent?.status === "SUCCEEDED" ? nowMs : 0;
  const cancelTime =
    args.method === "CancelTransaction" || args.intent?.status === "CANCELED" ? nowMs : 0;

  switch (args.method) {
    case "CheckPerformTransaction":
      return buildRpcResult(args.id, { allow: Boolean(args.intent) });
    case "CreateTransaction":
      if (!args.intent) return buildRpcError(args.id, -31050, "Order not found");
      return buildRpcResult(args.id, {
        create_time: createTime,
        transaction,
        state: 1,
      });
    case "PerformTransaction":
      if (!args.intent) return buildRpcError(args.id, -31050, "Order not found");
      return buildRpcResult(args.id, {
        transaction,
        perform_time: performTime,
        state: 2,
      });
    case "CancelTransaction":
      if (!args.intent) return buildRpcError(args.id, -31050, "Order not found");
      return buildRpcResult(args.id, {
        transaction,
        cancel_time: cancelTime || nowMs,
        state: -1,
      });
    case "CheckTransaction":
      if (!args.intent) return buildRpcError(args.id, -31050, "Order not found");
      return buildRpcResult(args.id, {
        create_time: createTime,
        perform_time: performTime,
        cancel_time: cancelTime,
        transaction,
        state: args.intent.status === "SUCCEEDED" ? 2 : args.intent.status === "CANCELED" ? -1 : 1,
        reason: null,
      });
    default:
      return buildRpcError(args.id, -32601, "Method not found");
  }
}

export class PaymeProviderAdapter implements PaymentProviderAdapter {
  provider: PaymentProvider = PaymentProvider.PAYME;

  async createPayment(input: { config: ResolvedProviderConfig; intent: PaymentIntent }) {
    if (!input.config.merchantId) {
      throw new Error("Payme provider config requires merchantId");
    }
    const amount = formatProviderAmount(
      input.intent.amountMinor,
      input.intent.currency,
      "PAYME",
    );
    const accountField = input.config.accountId?.trim() || "order_id";
    const params = `m=${input.config.merchantId};ac.${accountField}=${input.intent.id};a=${String(amount)}`;
    const encoded = Buffer.from(params).toString("base64");
    const base =
      input.config.environment === "PRODUCTION"
        ? PAYME_CHECKOUT_BASE.PRODUCTION
        : PAYME_CHECKOUT_BASE.TEST;

    return {
      providerPaymentId: input.intent.id,
      checkoutUrl: `${base}/${encoded}`,
      rawResponse: {
        provider: "payme",
        params,
        accountField,
      },
    };
  }

  async getStatus(_input: { config: ResolvedProviderConfig; intent: PaymentIntent }) {
    return {
      status: "pending" as const,
      rawResponse: { reason: "payme_status_pull_not_configured_use_webhook" },
    };
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
      rawResponse: { reason: "payme_refund_not_implemented" },
    };
  }

  async verifyWebhook(
    input: ProviderWebhookInput & { config: ResolvedProviderConfig; intent?: PaymentIntent | null },
  ): Promise<VerifyWebhookResult> {
    const rpc = parseJsonRpcBody(input.body);
    const method = rpc.method ?? "";
    const params = rpc.params ?? {};
    const isValid = validateAuth(input.headers, input.config.secretPlain);
    const txId = readString(params, "id") || input.intent?.id || `${input.provider}:${Date.now()}`;
    const mappedStatus = isValid ? mapIntentStatusByMethod(method, params) : undefined;

    const responsePayload = isValid
      ? buildResultByMethod({
          method,
          id: rpc.id,
          intent: input.intent ?? null,
          params,
        })
      : buildRpcError(rpc.id, -32504, "Insufficient privilege");

    return {
      isValid,
      idempotencyKey: txId,
      mappedStatus,
      providerPaymentId: txId,
      externalEventId: txId,
      rawEvent: rpc,
      responsePayload,
    };
  }
}
