import { webhookHeadersForStorage } from "../../../utils/webhookMetadata";
import { createHash } from "crypto";
import prisma from "../../../config/prismaClient";
import { authorityError } from "../../orders-core/domain/creation-authority";
import type { CanonicalWebhookEvent } from "../domain/ports";
import type { WebhookEventRepository } from "../application/webhook-gateway.types";

const db = prisma as any;

function toDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function inferDomain(eventType: string) {
  const normalized = String(eventType || "").toLowerCase();
  if (normalized.startsWith("carrier.")) return "carrier" as const;
  if (normalized.startsWith("sms.")) return "sms" as const;
  if (normalized.startsWith("payment.")) return "payment" as const;
  return "webhook_sink" as const;
}

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export const webhookEventRepository: WebhookEventRepository = {
  async hasProcessed(args) {
    if (!args.companyId || !args.providerId || !args.providerEventId || !args.providerCode ||
      !/^[a-f0-9]{64}$/.test(args.rawBodySha256) || !["carrier", "sms", "payment", "webhook_sink"].includes(args.domain) ||
      !["sandbox", "production"].includes(args.environment)) throw authorityError("Verified webhook identity required", 403);
    const existing = await db.integrationWebhookEvent.findFirst({
      where: {
        providerId: String(args.providerId || "").trim(),
        providerEventId: String(args.providerEventId || "").trim(),
      },
      select: { id: true, companyId: true, providerId: true, domain: true, providerCode: true, environment: true,
        rawBodySha256: true, signatureVerified: true,
        provider: { select: { companyId: true, domain: true, providerCode: true, environment: true, status: true,
          company: { select: { isActive: true, type: true, tenantId: true, tenant: { select: { id: true, status: true } } } } } },
        canonicalEvent: { select: { companyId: true, domain: true, providerCode: true } },
        canonicalEvents: { where: { source: "inbound_webhook", outboxId: null, companyId: args.companyId, providerId: args.providerId,
          domain: args.domain, providerCode: args.providerCode }, take: 1, select: { id: true } },
      },
    });
    if (!existing) return false;
    if (!args.companyId || !args.providerId || !/^[a-f0-9]{64}$/.test(args.rawBodySha256) || !existing.signatureVerified ||
      existing.companyId !== args.companyId || existing.providerId !== args.providerId || existing.domain !== args.domain ||
      existing.providerCode !== args.providerCode || existing.environment !== args.environment || existing.rawBodySha256 !== args.rawBodySha256)
      throw Object.assign(authorityError("Webhook event identity conflict", 409), { code: "WEBHOOK_EVENT_ID_CONFLICT" });
    const provider = existing.provider;
    if (!provider || provider.status !== "active" || provider.companyId !== args.companyId || provider.domain !== args.domain ||
      provider.providerCode !== args.providerCode || provider.environment !== args.environment || !provider.company.isActive || provider.company.type !== "company" ||
      !provider.company.tenantId || provider.company.tenant?.id !== provider.company.tenantId || provider.company.tenant.status !== "active")
      throw authorityError("Webhook provider ownership unavailable", 403);
    const normalized = existing.canonicalEvent;
    if (normalized && (normalized.companyId !== args.companyId || normalized.domain !== args.domain || normalized.providerCode !== args.providerCode))
      throw Object.assign(authorityError("Webhook normalized identity conflict", 409), { code: "WEBHOOK_EVENT_ID_CONFLICT" });
    if (!normalized || existing.canonicalEvents.length !== 1)
      throw Object.assign(authorityError("Webhook processing persistence incomplete", 503), { code: "WEBHOOK_INGRESS_INCOMPLETE" });
    return true; // Durable acceptance, not a claim that domain processing has completed.
  },

  async saveRawEvent(args) {
    const row = await db.integrationWebhookEvent.create({
      data: {
        providerCode: String(args.providerCode || "").trim(),
        companyId: args.companyId,
        providerId: args.providerId,
        domain: args.domain,
        environment: args.environment,
        providerEventId: String(args.providerEventId || "").trim(),
        rawBody: args.rawBody,
        rawBodySha256: sha256(args.rawBody),
        headersJson: webhookHeadersForStorage(args.headersJson),
        ipAddress: args.ipAddress ?? null,
        userAgent: null,
        receivedAt: toDate(args.receivedAt),
        signatureVerified: args.signatureVerified,
      },
    });

    return { webhookEventId: row.id };
  },

  async saveCanonicalEvent(args) {
    await db.integrationWebhookCanonicalEvent.create({
      data: {
        webhookEventId: args.webhookEventId,
        providerCode: args.canonical.providerCode,
        domain: inferDomain(args.canonical.eventType),
        eventType: args.canonical.eventType,
        occurredAt: toDate(args.canonical.occurredAt),
        companyId: args.canonical.companyId ?? null,
        aggregateType: args.canonical.aggregateType ?? null,
        aggregateId: args.canonical.aggregateId ?? null,
        payloadJson: args.canonical.payload as any,
      },
    });

    await db.integrationWebhookEvent.update({
      where: { id: args.webhookEventId },
      data: {
        processedAt: new Date(),
      },
    });
  },
};

export function buildCanonicalWebhookEvent(input: CanonicalWebhookEvent): CanonicalWebhookEvent {
  return {
    providerCode: input.providerCode,
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    companyId: input.companyId ?? null,
    aggregateType: input.aggregateType ?? null,
    aggregateId: input.aggregateId ?? null,
    payload: input.payload,
    signatureVerified: Boolean(input.signatureVerified),
    rawBodySha256: input.rawBodySha256,
  };
}
