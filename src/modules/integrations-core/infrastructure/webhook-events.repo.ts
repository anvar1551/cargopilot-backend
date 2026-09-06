import { webhookHeadersForStorage } from "../../../utils/webhookMetadata";
import { createHash } from "crypto";
import prisma from "../../../config/prismaClient";
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
    const existing = await db.integrationWebhookEvent.findFirst({
      where: {
        providerId: String(args.providerId || "").trim(),
        providerEventId: String(args.providerEventId || "").trim(),
      },
      select: { id: true },
    });

    return Boolean(existing?.id);
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
