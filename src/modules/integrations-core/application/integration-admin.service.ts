export { listIntegrationOutboxForActor, listIntegrationOutboxAttemptsForActor } from "./outbox-access";
export { replayIntegrationOutboxForActor, retryIntegrationOutboxNowForActor } from "./outbox-recovery";
export { upsertIntegrationProviderForActor, updateIntegrationProviderStatusForActor, deleteIntegrationProviderForActor, rotateIntegrationProviderSecretForActor } from "./provider-mutation";
export { listIntegrationProvidersForActor } from "./provider-access";
import { MembershipStatus } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { authorize, hasAnyPermissionSync } from "../../identity-access";
import type { AppUser } from "../../../types/app-user";

type AuthUser = AppUser;
type IntegrationDomain = "carrier" | "sms" | "payment" | "webhook_sink";
type IntegrationEnvironment = "sandbox" | "production";
type IntegrationProviderStatus = "active" | "paused" | "disabled";
type IntegrationOutboxStatus = "pending" | "processing" | "sent" | "failed" | "dead_letter";
type IntegrationEventProcessStatus = "pending" | "processing" | "processed" | "failed" | "ignored";


const OUTBOX_STATUS_PENDING: IntegrationOutboxStatus = "pending";
const OUTBOX_STATUS_FAILED: IntegrationOutboxStatus = "failed";
const OUTBOX_STATUS_SENT: IntegrationOutboxStatus = "sent";
const OUTBOX_STATUS_DEAD_LETTER: IntegrationOutboxStatus = "dead_letter";

const db = prisma as any;

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function normalizeProviderCode(value: string) {
  return String(value || "").trim().toLowerCase();
}

function canOverrideScope(user: AuthUser) {
  return hasAnyPermissionSync(user, ["policy.override"]);
}

async function listAccessibleCompanyIds(user: AuthUser): Promise<string[] | null> {
  if (canOverrideScope(user)) return null;
  const memberships = await db.companyMembership.findMany({
    where: {
      userId: user.id,
      status: MembershipStatus.active,
    },
    select: {
      companyId: true,
    },
  });
  return Array.from(
    new Set(memberships.map((item: { companyId: string }) => item.companyId).filter(Boolean)),
  ) as string[];
}

export async function listIntegrationWebhookEventsForActor(args: {
  user: AuthUser;
  companyId?: string;
  domain?: IntegrationDomain;
  providerCode?: string;
  q?: string;
  page?: number;
  limit?: number;
}) {
  await authorize(args.user, "integration.outbox.read");
  const scopedIds = await listAccessibleCompanyIds(args.user);
  const companyIdFilter = args.companyId?.trim() || undefined;
  if (companyIdFilter && scopedIds !== null && !scopedIds.includes(companyIdFilter)) {
    const err = new Error("Forbidden for this company") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  if (scopedIds !== null && scopedIds.length === 0) {
    return { items: [], total: 0, page: 1, limit: 20 };
  }

  const page = Math.max(1, Math.trunc(Number(args.page || 1)));
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(args.limit || 20))));
  const q = args.q?.trim();
  const where = {
    ...(companyIdFilter
      ? { companyId: companyIdFilter }
      : scopedIds === null
        ? {}
        : { companyId: { in: scopedIds } }),
    ...(args.domain ? { domain: args.domain } : {}),
    ...(args.providerCode ? { providerCode: normalizeProviderCode(args.providerCode) } : {}),
    ...(q
      ? {
          OR: [
            { providerCode: { contains: q, mode: "insensitive" } },
            { providerEventId: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await db.$transaction([
    db.integrationWebhookEvent.findMany({
      where,
      orderBy: [{ receivedAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        provider: {
          select: {
            id: true,
            providerCode: true,
            status: true,
            environment: true,
          },
        },
        canonicalEvent: {
          select: {
            eventType: true,
            aggregateType: true,
            aggregateId: true,
            occurredAt: true,
          },
        },
        canonicalEvents: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            eventType: true,
            aggregateType: true,
            aggregateId: true,
            lastError: true,
            processedAt: true,
            createdAt: true,
          },
        },
      },
    }),
    db.integrationWebhookEvent.count({ where }),
  ]);

  return {
    items: rows.map((row: any) => ({
      id: row.id,
      companyId: row.companyId ?? null,
      providerId: row.providerId ?? null,
      providerCode: row.providerCode,
      domain: row.domain,
      environment: row.environment,
      providerEventId: row.providerEventId,
      signatureVerified: Boolean(row.signatureVerified),
      rawBodySha256: row.rawBodySha256,
      ipAddress: row.ipAddress ?? null,
      userAgent: row.userAgent ?? null,
      receivedAt: toIso(row.receivedAt),
      processedAt: toIso(row.processedAt),
      provider: row.provider ?? null,
      canonical: row.canonicalEvent ?? null,
      latestCanonicalEvent: row.canonicalEvents?.[0] ?? null,
    })),
    total,
    page,
    limit,
  };
}

export async function listIntegrationCanonicalEventsForActor(args: {
  user: AuthUser;
  companyId?: string;
  status?: IntegrationEventProcessStatus;
  domain?: IntegrationDomain;
  providerCode?: string;
  q?: string;
  page?: number;
  limit?: number;
}) {
  await authorize(args.user, "integration.outbox.read");
  const scopedIds = await listAccessibleCompanyIds(args.user);
  const companyIdFilter = args.companyId?.trim() || undefined;
  if (companyIdFilter && scopedIds !== null && !scopedIds.includes(companyIdFilter)) {
    const err = new Error("Forbidden for this company") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  if (scopedIds !== null && scopedIds.length === 0) {
    return { items: [], total: 0, page: 1, limit: 20 };
  }

  const page = Math.max(1, Math.trunc(Number(args.page || 1)));
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(args.limit || 20))));
  const q = args.q?.trim();
  const where = {
    ...(companyIdFilter
      ? { companyId: companyIdFilter }
      : scopedIds === null
        ? {}
        : { companyId: { in: scopedIds } }),
    ...(args.status ? { status: args.status } : {}),
    ...(args.domain ? { domain: args.domain } : {}),
    ...(args.providerCode ? { providerCode: normalizeProviderCode(args.providerCode) } : {}),
    ...(q
      ? {
          OR: [
            { providerCode: { contains: q, mode: "insensitive" } },
            { eventType: { contains: q, mode: "insensitive" } },
            { aggregateType: { contains: q, mode: "insensitive" } },
            { aggregateId: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await db.$transaction([
    db.integrationCanonicalEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        provider: {
          select: {
            id: true,
            providerCode: true,
            status: true,
            environment: true,
          },
        },
      },
    }),
    db.integrationCanonicalEvent.count({ where }),
  ]);

  return {
    items: rows.map((row: any) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      companyId: row.companyId ?? null,
      providerId: row.providerId ?? null,
      webhookEventId: row.webhookEventId ?? null,
      outboxId: row.outboxId ?? null,
      domain: row.domain,
      providerCode: row.providerCode,
      eventType: row.eventType,
      aggregateType: row.aggregateType ?? null,
      aggregateId: row.aggregateId ?? null,
      processAttempts: row.processAttempts,
      lastError: row.lastError ?? null,
      occurredAt: toIso(row.occurredAt),
      lockedAt: toIso(row.lockedAt),
      processedAt: toIso(row.processedAt),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      provider: row.provider ?? null,
    })),
    total,
    page,
    limit,
  };
}
