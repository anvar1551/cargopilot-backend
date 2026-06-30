import {
  PaymentEnvironment,
  PaymentIntentStatus,
  PaymentProvider,
  SupportTicketPriority,
  SupportTicketSource,
} from "@prisma/client";
import { createSupportTicket } from "./supportService";

const systemActor = {
  id: "",
  roleCodes: ["system"],
  permissionCodes: [],
  name: "CargoPilot Auto Triage",
  email: "system@cargopilot.local",
};

function trim(value: unknown, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeSourceKeyPart(value: unknown) {
  return trim(value, 160).replace(/[^a-zA-Z0-9_.:-]+/g, "_") || "unknown";
}

export async function createSystemSupportTicket(input: {
  sourceKey: string;
  title: string;
  summary?: string | null;
  priority?: SupportTicketPriority;
  orderId?: string | null;
  orderNumber?: string | null;
  companyId?: string | null;
  routingKey?: string | null;
}) {
  if (process.env.SUPPORT_AUTO_TRIAGE_ENABLED === "false") return null;

  return createSupportTicket(
    {
      orderId: input.orderId ?? null,
      orderNumber: input.orderNumber ?? null,
      companyId: input.companyId ?? null,
      title: trim(input.title, 240),
      summary: input.summary ? trim(input.summary, 2000) : null,
      priority: input.priority ?? SupportTicketPriority.high,
      source: SupportTicketSource.system_alert,
      ownerId: null,
      sourceKey: trim(input.sourceKey, 500),
      routingKey: input.routingKey ? trim(input.routingKey, 80) : null,
    },
    systemActor,
  ).catch((err: any) => {
    console.error(`[support-auto-triage] ticket creation failed: ${err?.message || "unknown"}`);
    return null;
  });
}

export async function createCarrierFailureSupportTicket(input: {
  orderId: string;
  legId: string;
  providerCode?: string | null;
  status?: string | null;
  reason?: string | null;
  terminal?: boolean;
}) {
  const provider = normalizeSourceKeyPart(input.providerCode);
  const status = normalizeSourceKeyPart(input.status || (input.terminal ? "terminal_failure" : "booking_failed"));
  const sourceKey = `carrier:${input.terminal ? "status" : "booking"}:${input.legId}:${provider}:${status}:v1`;
  const title = input.terminal
    ? "Carrier reported shipment exception"
    : "Carrier booking failed";
  const summary = [
    `Provider: ${input.providerCode || "-"}`,
    `Leg ID: ${input.legId}`,
    input.status ? `Status: ${input.status}` : null,
    input.reason ? `Reason: ${input.reason}` : null,
  ].filter(Boolean).join("\n");

  return createSystemSupportTicket({
    sourceKey,
    orderId: input.orderId,
    title,
    summary,
    priority: input.terminal ? SupportTicketPriority.urgent : SupportTicketPriority.high,
    routingKey: "carrier",
  });
}

export async function createPaymentFailureSupportTicket(input: {
  orderId: string;
  companyId?: string | null;
  paymentIntentId?: string | null;
  provider: PaymentProvider;
  environment?: PaymentEnvironment | null;
  status?: PaymentIntentStatus | string | null;
  reason?: string | null;
}) {
  const status = normalizeSourceKeyPart(input.status || "failed");
  const sourceKey = `payment:intent:${input.paymentIntentId || input.orderId}:${input.provider}:${status}:v1`;
  return createSystemSupportTicket({
    sourceKey,
    orderId: input.orderId,
    companyId: input.companyId ?? null,
    title: "Online payment needs support attention",
    summary: [
      `Provider: ${input.provider}`,
      input.environment ? `Environment: ${input.environment}` : null,
      input.paymentIntentId ? `Payment intent: ${input.paymentIntentId}` : null,
      input.status ? `Status: ${input.status}` : null,
      input.reason ? `Reason: ${input.reason}` : null,
    ].filter(Boolean).join("\n"),
    priority: SupportTicketPriority.high,
    routingKey: "payment",
  });
}

export async function createPaymentWebhookSupportTicket(input: {
  companyId?: string | null;
  provider: PaymentProvider;
  environment: PaymentEnvironment;
  idempotencyKey: string;
  reason: string;
  paymentIntentId?: string | null;
}) {
  const sourceKey = `payment:webhook:${input.provider}:${input.environment}:${normalizeSourceKeyPart(input.idempotencyKey)}:v1`;
  return createSystemSupportTicket({
    sourceKey,
    companyId: input.companyId ?? null,
    title: "Payment webhook rejected",
    summary: [
      `Provider: ${input.provider}`,
      `Environment: ${input.environment}`,
      input.paymentIntentId ? `Payment intent: ${input.paymentIntentId}` : null,
      `Webhook key: ${input.idempotencyKey}`,
      `Reason: ${input.reason}`,
    ].filter(Boolean).join("\n"),
    priority: SupportTicketPriority.urgent,
    routingKey: "payment",
  });
}

export async function createLabelFailureSupportTicket(input: {
  orderId: string;
  jobId?: string | null;
  reason?: string | null;
  exhausted?: boolean;
}) {
  const sourceKey = input.exhausted
    ? `label:failed:${input.orderId}:exhausted:v1`
    : `label:failed:${input.orderId}:inline:v1`;
  return createSystemSupportTicket({
    sourceKey,
    orderId: input.orderId,
    title: input.exhausted ? "Shipping label generation exhausted retries" : "Shipping label generation failed",
    summary: [
      input.jobId ? `Label job: ${input.jobId}` : null,
      input.reason ? `Reason: ${input.reason}` : null,
    ].filter(Boolean).join("\n"),
    priority: input.exhausted ? SupportTicketPriority.urgent : SupportTicketPriority.high,
    routingKey: "label",
  });
}
