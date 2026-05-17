import { createHash, randomUUID } from "crypto";
import "dotenv/config";

type Provider = "CLICK" | "PAYME" | "UZUM";
type IntentResponse = {
  paymentIntentId: string;
  status: string;
  checkoutUrl?: string | null;
  providerPaymentId?: string | null;
  reused?: boolean;
};

type PaymentIntentView = {
  id: string;
  status: string;
  statusCanonical?: string;
  provider: string;
};

const API_URL = process.env.SMOKE_API_URL?.trim() || "http://localhost:4000/api";
const TOKEN = process.env.SMOKE_TOKEN?.trim() || "";
const COMPANY_ID = process.env.SMOKE_COMPANY_ID?.trim() || "";
const ORDER_ID = process.env.SMOKE_ORDER_ID?.trim() || "";
const CURRENCY = (process.env.SMOKE_CURRENCY?.trim() || "UZS").toUpperCase();
const AMOUNT_MINOR = BigInt(process.env.SMOKE_AMOUNT_MINOR?.trim() || "130000");

const CLICK_SECRET = process.env.SMOKE_CLICK_SECRET?.trim() || "";
const CLICK_SERVICE_ID = process.env.SMOKE_CLICK_SERVICE_ID?.trim() || "";

const PAYME_SECRET = process.env.SMOKE_PAYME_SECRET?.trim() || "";

const UZUM_SECRET = process.env.SMOKE_UZUM_SECRET?.trim() || "";
const UZUM_SERVICE_ID = process.env.SMOKE_UZUM_SERVICE_ID?.trim() || "";
const UZUM_AUTH_USER = process.env.SMOKE_UZUM_AUTH_USER?.trim() || "";

function requireBaseEnv() {
  const missing: string[] = [];
  if (!TOKEN) missing.push("SMOKE_TOKEN");
  if (!COMPANY_ID) missing.push("SMOKE_COMPANY_ID");
  if (!ORDER_ID) missing.push("SMOKE_ORDER_ID");
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

function currencyExponent(code: string): number {
  switch (code) {
    case "UZS":
    case "USD":
    case "EUR":
    case "CNY":
    case "RUB":
      return 2;
    default:
      return 2;
  }
}

function minorToMajor(amountMinor: bigint, currency: string): string {
  const exp = currencyExponent(currency);
  const factor = 10 ** exp;
  const major = Number(amountMinor) / factor;
  return major.toFixed(exp);
}

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

async function api<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<{ status: number; data: T }> {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (init.auth !== false) {
    headers.set("Authorization", `Bearer ${TOKEN}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  return {
    status: response.status,
    data: parsed as T,
  };
}

async function createIntent(provider: Provider): Promise<IntentResponse> {
  const idempotencyKey = `smoke-${provider.toLowerCase()}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const { status, data } = await api<IntentResponse | { error?: string }>("/payments/intents", {
    method: "POST",
    body: JSON.stringify({
      companyId: COMPANY_ID,
      orderId: ORDER_ID,
      amountMinor: AMOUNT_MINOR.toString(),
      currency: CURRENCY,
      provider,
      idempotencyKey,
    }),
  });

  if (status >= 300) {
    throw new Error(`[${provider}] create intent failed (${status}): ${JSON.stringify(data)}`);
  }
  const result = data as IntentResponse;
  if (!result.paymentIntentId) {
    throw new Error(`[${provider}] create intent response missing paymentIntentId`);
  }
  return result;
}

async function fetchIntent(id: string): Promise<PaymentIntentView> {
  const { status, data } = await api<PaymentIntentView | { error?: string }>(`/payments/intents/${id}`);
  if (status >= 300) {
    throw new Error(`fetch intent failed (${status}): ${JSON.stringify(data)}`);
  }
  return data as PaymentIntentView;
}

async function runClick() {
  if (!CLICK_SECRET || !CLICK_SERVICE_ID) {
    console.log("[CLICK] skipped: SMOKE_CLICK_SECRET or SMOKE_CLICK_SERVICE_ID missing");
    return;
  }

  const intent = await createIntent("CLICK");
  const clickTransId = `click-${Date.now()}`;
  const signTime = Math.floor(Date.now() / 1000).toString();
  const action = "1";
  const amount = minorToMajor(AMOUNT_MINOR, CURRENCY);
  const signSeed =
    clickTransId +
    CLICK_SERVICE_ID +
    CLICK_SECRET +
    intent.paymentIntentId +
    intent.paymentIntentId +
    amount +
    action +
    signTime;
  const signString = md5(signSeed);

  const body = {
    click_trans_id: clickTransId,
    service_id: CLICK_SERVICE_ID,
    merchant_trans_id: intent.paymentIntentId,
    merchant_prepare_id: intent.paymentIntentId,
    amount,
    action,
    error: "0",
    error_note: "Success",
    sign_time: signTime,
    sign_string: signString,
    click_paydoc_id: `${Date.now()}`,
  };

  const callback = await api<Record<string, unknown>>("/payments/click/callback", {
    method: "POST",
    auth: false,
    body: JSON.stringify(body),
  });

  const refreshed = await fetchIntent(intent.paymentIntentId);
  const ok = callback.status < 300 && (refreshed.statusCanonical === "succeeded" || refreshed.status === "SUCCEEDED");
  console.log(`[CLICK] ${ok ? "PASS" : "FAIL"} callback=${callback.status} status=${refreshed.status}`);
  if (!ok) {
    console.log("[CLICK] callback body:", callback.data);
  }
}

async function runPayme() {
  if (!PAYME_SECRET) {
    console.log("[PAYME] skipped: SMOKE_PAYME_SECRET missing");
    return;
  }

  const intent = await createIntent("PAYME");
  const authBasic = Buffer.from(`Paycom:${PAYME_SECRET}`).toString("base64");
  const body = {
    jsonrpc: "2.0",
    id: `rpc-${Date.now()}`,
    method: "PerformTransaction",
    params: {
      id: `payme-tx-${Date.now()}`,
      account: {
        order_id: intent.paymentIntentId,
      },
    },
  };

  const callback = await api<Record<string, unknown>>("/payments/payme/callback", {
    method: "POST",
    auth: false,
    headers: {
      Authorization: `Basic ${authBasic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const refreshed = await fetchIntent(intent.paymentIntentId);
  const ok = callback.status < 300 && (refreshed.statusCanonical === "succeeded" || refreshed.status === "SUCCEEDED");
  console.log(`[PAYME] ${ok ? "PASS" : "FAIL"} callback=${callback.status} status=${refreshed.status}`);
  if (!ok) {
    console.log("[PAYME] callback body:", callback.data);
  }
}

async function runUzum() {
  if (!UZUM_SECRET || !UZUM_SERVICE_ID || !UZUM_AUTH_USER) {
    console.log(
      "[UZUM] skipped: SMOKE_UZUM_SECRET or SMOKE_UZUM_SERVICE_ID or SMOKE_UZUM_AUTH_USER missing",
    );
    return;
  }

  const intent = await createIntent("UZUM");
  const authBasic = Buffer.from(`${UZUM_AUTH_USER}:${UZUM_SECRET}`).toString("base64");
  const body = {
    serviceId: UZUM_SERVICE_ID,
    transId: `uzum-${Date.now()}`,
    status: "CONFIRMED",
    params: {
      order_id: intent.paymentIntentId,
    },
    amount: Number(AMOUNT_MINOR),
  };

  const callback = await api<Record<string, unknown>>("/payments/uzum/callback", {
    method: "POST",
    auth: false,
    headers: {
      Authorization: `Basic ${authBasic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const refreshed = await fetchIntent(intent.paymentIntentId);
  const ok = callback.status < 300 && (refreshed.statusCanonical === "succeeded" || refreshed.status === "SUCCEEDED");
  console.log(`[UZUM] ${ok ? "PASS" : "FAIL"} callback=${callback.status} status=${refreshed.status}`);
  if (!ok) {
    console.log("[UZUM] callback body:", callback.data);
  }
}

async function main() {
  requireBaseEnv();
  console.log("== CargoPilot payments local smoke ==");
  console.log(`API: ${API_URL}`);
  console.log(`Company: ${COMPANY_ID}`);
  console.log(`Order: ${ORDER_ID}`);
  console.log(`AmountMinor: ${AMOUNT_MINOR.toString()} ${CURRENCY}`);

  await runClick();
  await runPayme();
  await runUzum();

  console.log("== done ==");
}

main().catch((error) => {
  console.error("[payments-local-smoke] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

