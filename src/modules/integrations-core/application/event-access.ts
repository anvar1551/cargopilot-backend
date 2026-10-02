import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { integrationMetadataScope, metadataPage, type IntegrationMetadataDomain } from "./metadata-scope";

type Status = "pending" | "processing" | "processed" | "failed" | "ignored";
type Query = { user: AppUser; companyId?: string; domain?: IntegrationMetadataDomain; providerCode?: string; q?: string; page?: number; limit?: number };
const iso = (value: Date | null) => value?.toISOString() ?? null;
const providerSelect = { id: true, providerCode: true, status: true, environment: true } satisfies Prisma.IntegrationProviderSelect;
function provider(row: { id: string; providerCode: string; status: string; environment: string } | null) {
  return row ? { id: row.id, providerCode: row.providerCode, status: row.status, environment: row.environment } : null;
}
async function scope(args: Query) {
  const page = metadataPage(args.page, 1, 10000), limit = metadataPage(args.limit, 20, 100);
  if (args.q !== undefined && (typeof args.q !== "string" || args.q.length > 180)) throw authorityError("Invalid integration search", 400);
  return { ...await integrationMetadataScope(args.user, args.companyId, args.domain, args.providerCode), page, limit,
    search: args.q?.trim() ? { providerCode: { contains: args.q.trim(), mode: "insensitive" as const } } : {} };
}
export async function listIntegrationWebhookEventsForActor(args: Query) {
  const { context, providers, page, limit, search } = await scope(args);
  const where: Prisma.IntegrationWebhookEventWhereInput = { ...context, ...search, OR: providers.map(p => ({
    providerId: p.id, domain: p.domain, providerCode: p.providerCode, environment: p.environment,
    provider: { is: { ...context, id: p.id, domain: p.domain, providerCode: p.providerCode, environment: p.environment } },
  })) };
  const select = { id: true, companyId: true, providerId: true, domain: true, providerCode: true, environment: true,
    signatureVerified: true, rawBodySha256: true, receivedAt: true, processedAt: true, provider: { select: providerSelect },
  } satisfies Prisma.IntegrationWebhookEventSelect;
  const [rows, total] = await prisma.$transaction([
    prisma.integrationWebhookEvent.findMany({ where, select, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
    prisma.integrationWebhookEvent.count({ where }),
  ]);
  return { items: rows.map(row => ({ id: row.id, companyId: row.companyId, providerId: row.providerId, domain: row.domain,
    providerCode: row.providerCode, environment: row.environment, providerEventId: null,
    signatureVerified: row.signatureVerified, rawBodySha256: /^[a-f0-9]{64}$/i.test(row.rawBodySha256) ? row.rawBodySha256 : null,
    ipAddress: null, userAgent: null, receivedAt: iso(row.receivedAt), processedAt: iso(row.processedAt),
    provider: provider(row.provider), canonical: null, latestCanonicalEvent: null,
  })), total, page, limit };
}
export async function listIntegrationCanonicalEventsForActor(args: Query & { status?: Status }) {
  if (args.status !== undefined && !["pending", "processing", "processed", "failed", "ignored"].includes(args.status))
    throw authorityError("Invalid integration event status", 400);
  const { context, providers, page, limit, search } = await scope(args);
  const where: Prisma.IntegrationCanonicalEventWhereInput = {
    companyId: context.companyId, ...search, ...(args.status ? { status: args.status } : {}), OR: providers.map(p => {
      const tuple = { companyId: context.companyId, providerId: p.id, domain: p.domain, providerCode: p.providerCode };
      const source = { ...tuple, environment: p.environment,
        provider: { is: { ...context, id: p.id, domain: p.domain, providerCode: p.providerCode, environment: p.environment } } };
      return { ...tuple, provider: source.provider, OR: [
        { source: "inbound_webhook", outboxId: null, webhookEvent: { is: { ...context, ...source, signatureVerified: true } } },
        { source: "outbound_response", webhookEventId: null, outbox: { is: { ...context, ...source, AND: [
          { OR: [{ ownershipTenantId: null, ownershipOrderId: null }, {
            ownershipTenantId: context.company.is.tenantId, ownershipOrderId: { not: null },
            ownedOrder: { is: { tenantId: context.company.is.tenantId, ownerOrgId: context.companyId } },
          }] },
        ] } } },
      ] };
    }),
  };
  const select = { id: true, source: true, status: true, companyId: true, providerId: true, webhookEventId: true, outboxId: true,
    domain: true, providerCode: true, processAttempts: true, occurredAt: true, lockedAt: true, processedAt: true,
    createdAt: true, updatedAt: true, provider: { select: providerSelect },
  } satisfies Prisma.IntegrationCanonicalEventSelect;
  const [rows, total] = await prisma.$transaction([
    prisma.integrationCanonicalEvent.findMany({ where, select, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
    prisma.integrationCanonicalEvent.count({ where }),
  ]);
  return { items: rows.map(row => ({ id: row.id, source: row.source, status: row.status, companyId: row.companyId, providerId: row.providerId,
    webhookEventId: row.webhookEventId, outboxId: row.outboxId, domain: row.domain, providerCode: row.providerCode,
    eventType: null, aggregateType: null, aggregateId: null, lastError: null, processAttempts: row.processAttempts,
    occurredAt: iso(row.occurredAt), lockedAt: iso(row.lockedAt), processedAt: iso(row.processedAt),
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), provider: provider(row.provider),
  })), total, page, limit };
}
