import { webhookHeadersForStorage } from "../../../utils/webhookMetadata";
import { createHash } from "crypto";
import prisma from "../../../config/prismaClient";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { Prisma } from "@prisma/client";
import { readVerifiedWebhookIngress } from "../application/webhook-gateway.service";
import { deriveCanonicalSource } from "../application/canonical-source";
import type { WebhookEventRepository } from "../application/webhook-gateway.types";

const db = prisma as any;

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

async function hasProcessed(db: any, args: Parameters<WebhookEventRepository["hasProcessed"]>[0]) {
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
}

export const webhookEventRepository: WebhookEventRepository = {
  hasProcessed: args => hasProcessed(db, args),
  async persistVerified(evidence) {
    const data = readVerifiedWebhookIngress(evidence); // Before any database work.
    const { provider: identity, canonical } = data;
    const occurredAt = new Date(canonical.occurredAt), receivedAt = new Date(data.receivedAt);
    if (!identity.companyId || !identity.providerId || !canonical.eventId ||
      !Number.isFinite(occurredAt.getTime()) || !Number.isFinite(receivedAt.getTime()))
      throw authorityError("Verified webhook context required", 403);
    const receipt = { ...identity, providerEventId: canonical.eventId, rawBodySha256: sha256(data.rawBody) };
    try {
      return await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
        // Serialize this source identity, not caller-supplied aggregate IDs.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${identity.providerId + ":" + canonical.eventId}, 0))`;
        // Keep current configured ownership/status stable through acceptance.
        await tx.$queryRaw`SELECT p.id FROM "IntegrationProvider" p JOIN "Organization" o ON o.id=p."companyId"
          JOIN "Tenant" t ON t.id=o."tenantId" WHERE p.id=${identity.providerId}::uuid FOR SHARE OF p,o,t`;
        const provider = await tx.integrationProvider.findUnique({ where: { id: identity.providerId }, include: { company: { include: { tenant: true } } } });
        if (!provider || provider.status !== "active" || provider.companyId !== identity.companyId || provider.domain !== identity.domain ||
          provider.providerCode !== identity.providerCode || provider.environment !== identity.environment || !provider.company.isActive ||
          provider.company.type !== "company" || !provider.company.tenantId || provider.company.tenant?.id !== provider.company.tenantId ||
          provider.company.tenant.status !== "active") throw authorityError("Webhook provider ownership unavailable", 403);
        if (await hasProcessed(tx, receipt)) return "duplicate" as const;
        const raw = await tx.integrationWebhookEvent.create({ data: { ...identity, providerEventId: canonical.eventId,
          rawBody: data.rawBody, rawBodySha256: receipt.rawBodySha256, headersJson: webhookHeadersForStorage(data.headersJson),
          ipAddress: data.ipAddress, userAgent: null, receivedAt, signatureVerified: true } });
        // Ownership comes from the newly inserted authoritative raw source, never event-name inference.
        await tx.integrationWebhookCanonicalEvent.create({ data: { webhookEventId: raw.id, companyId: raw.companyId,
          domain: raw.domain, providerCode: raw.providerCode, eventType: canonical.eventType, occurredAt,
          aggregateType: canonical.aggregateType ?? null, aggregateId: canonical.aggregateId ?? null, payloadJson: canonical.payload as any } });
        const pending = await deriveCanonicalSource(tx, { source: "inbound_webhook", ...identity, webhookEventId: raw.id,
          eventType: canonical.eventType, occurredAt: occurredAt.toISOString(), aggregateType: canonical.aggregateType ?? null,
          aggregateId: canonical.aggregateId ?? null, payloadJson: canonical.payload });
        await tx.integrationCanonicalEvent.create({ data: { ...pending, status: "pending" } });
        return "accepted" as const;
      }, { maxWait: 2000, timeout: 5000 });
    } catch (error) {
      // Same-source requests serialize above. Other unique collisions cannot claim another receipt.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw Object.assign(authorityError("Webhook event identity conflict", 409), { code: "WEBHOOK_EVENT_ID_CONFLICT" });
      throw error;
    }
  },
};
