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

function buildOutboxWhere(args: {
  scopedCompanyIds: string[] | null;
  companyId?: string;
  status?: IntegrationOutboxStatus;
  domain?: IntegrationDomain;
  providerCode?: string;
}) {
  return {
    ...(args.companyId
      ? { companyId: args.companyId }
      : args.scopedCompanyIds === null
        ? {}
        : { companyId: { in: args.scopedCompanyIds } }),
    ...(args.status ? { status: args.status } : {}),
    ...(args.domain ? { domain: args.domain } : {}),
    ...(args.providerCode ? { providerCode: normalizeProviderCode(args.providerCode) } : {}),
  };
}

async function getOutboxAccessibleOrThrow(user: AuthUser, outboxId: string, permission: string) {
  await authorize(user, permission);
  const scopedIds = await listAccessibleCompanyIds(user);
  const row = await db.integrationOutbox.findUnique({
    where: { id: outboxId },
  });
  if (!row) {
    const err = new Error("Outbox record not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  if (scopedIds !== null && !scopedIds.includes(row.companyId)) {
    const err = new Error("Forbidden for this outbox record") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  return row;
}

export async function listIntegrationOutboxForActor(args: {
  user: AuthUser;
  companyId?: string;
  status?: IntegrationOutboxStatus;
  domain?: IntegrationDomain;
  providerCode?: string;
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
  const where = buildOutboxWhere({
    scopedCompanyIds: scopedIds,
    companyId: companyIdFilter,
    status: args.status,
    domain: args.domain,
    providerCode: args.providerCode,
  });

  const [rows, total] = await db.$transaction([
    db.integrationOutbox.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
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
        attempts: {
          orderBy: { attemptNo: "desc" },
          take: 1,
          select: {
            attemptNo: true,
            outcome: true,
            statusCode: true,
            retryable: true,
            errorMessage: true,
            createdAt: true,
          },
        },
      },
    }),
    db.integrationOutbox.count({ where }),
  ]);

  return {
    items: rows.map((row: any) => ({
      id: row.id,
      companyId: row.companyId,
      providerId: row.providerId ?? null,
      providerCode: row.providerCode,
      domain: row.domain,
      environment: row.environment,
      eventType: row.eventType,
      aggregateType: row.aggregateType ?? null,
      aggregateId: row.aggregateId ?? null,
      operation: row.operation ?? null,
      status: row.status,
      maxAttempts: row.maxAttempts,
      attemptCount: row.attemptCount,
      nextAttemptAt: toIso(row.nextAttemptAt),
      lastAttemptAt: toIso(row.lastAttemptAt),
      lastError: row.lastError ?? null,
      idempotencyKey: row.idempotencyKey,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      provider: row.provider,
      latestAttempt: row.attempts?.[0] ?? null,
    })),
    total,
    page,
    limit,
  };
}

export async function listIntegrationOutboxAttemptsForActor(args: {
  user: AuthUser;
  outboxId: string;
  limit?: number;
}) {
  const outbox = await getOutboxAccessibleOrThrow(
    args.user,
    args.outboxId,
    "integration.outbox.read",
  );
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(args.limit || 50))));
  const rows = await db.integrationDeliveryAttempt.findMany({
    where: { outboxId: outbox.id },
    orderBy: [{ attemptNo: "desc" }],
    take: limit,
  });
  return rows.map((row: any) => ({
    id: row.id,
    outboxId: row.outboxId,
    attemptNo: row.attemptNo,
    outcome: row.outcome,
    statusCode: row.statusCode ?? null,
    retryable: Boolean(row.retryable),
    errorMessage: row.errorMessage ?? null,
    providerRequestId: row.providerRequestId ?? null,
    requestJson: row.requestJson ?? null,
    responseJson: row.responseJson ?? null,
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    createdAt: toIso(row.createdAt),
  }));
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

export async function replayIntegrationOutboxForActor(args: {
  user: AuthUser;
  outboxId: string;
}) {
  const outbox = await getOutboxAccessibleOrThrow(
    args.user,
    args.outboxId,
    "integration.outbox.replay",
  );
  if (outbox.status !== OUTBOX_STATUS_DEAD_LETTER && outbox.status !== OUTBOX_STATUS_FAILED) {
    const err = new Error("Only failed/dead-letter records can be replayed") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const replayIdempotencyKey = `${outbox.idempotencyKey}:replay:${suffix}`;

  const cloned = await db.integrationOutbox.create({
    data: {
      companyId: outbox.companyId,
      providerId: outbox.providerId ?? null,
      domain: outbox.domain,
      providerCode: outbox.providerCode,
      environment: outbox.environment,
      eventType: outbox.eventType,
      aggregateType: outbox.aggregateType ?? null,
      aggregateId: outbox.aggregateId ?? null,
      operation: outbox.operation ?? null,
      status: OUTBOX_STATUS_PENDING,
      maxAttempts: outbox.maxAttempts,
      attemptCount: 0,
      nextAttemptAt: new Date(),
      lastAttemptAt: null,
      lastError: null,
      idempotencyKey: replayIdempotencyKey,
      payload: outbox.payload as any,
    },
  });

  return {
    replayedFromOutboxId: outbox.id,
    outboxId: cloned.id,
    idempotencyKey: cloned.idempotencyKey,
    status: cloned.status,
    nextAttemptAt: toIso(cloned.nextAttemptAt),
  };
}

export async function retryIntegrationOutboxNowForActor(args: {
  user: AuthUser;
  outboxId: string;
}) {
  const outbox = await getOutboxAccessibleOrThrow(
    args.user,
    args.outboxId,
    "integration.outbox.replay",
  );
  if (outbox.status === OUTBOX_STATUS_SENT) {
    const err = new Error("Sent records cannot be retried") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  if (outbox.status === OUTBOX_STATUS_DEAD_LETTER) {
    const err = new Error("Dead-letter record requires replay endpoint") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const updated = await db.integrationOutbox.update({
    where: { id: outbox.id },
    data: {
      status: OUTBOX_STATUS_FAILED,
      nextAttemptAt: new Date(),
    },
  });

  return {
    outboxId: updated.id,
    status: updated.status,
    nextAttemptAt: toIso(updated.nextAttemptAt),
    updatedAt: toIso(updated.updatedAt),
  };
}
