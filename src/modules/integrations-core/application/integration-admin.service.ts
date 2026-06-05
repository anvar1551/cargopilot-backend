import { MembershipStatus } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { authorize, hasAnyPermissionSync } from "../../identity-access";
import {
  encryptIntegrationSecret,
  secretPayloadToString,
  summarizeSecretPayload,
} from "./integration-secret.crypto";

type AuthUser = Express.User;
type IntegrationDomain = "carrier" | "sms" | "payment" | "webhook_sink";
type IntegrationEnvironment = "sandbox" | "production";
type IntegrationProviderStatus = "active" | "paused" | "disabled";
type IntegrationOutboxStatus = "pending" | "processing" | "sent" | "failed" | "dead_letter";

const PROVIDER_STATUS_ACTIVE: IntegrationProviderStatus = "active";
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

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );
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

async function assertCompanyAccess(user: AuthUser, companyId: string, permission: string) {
  await authorize(user, permission);
  const scopedIds = await listAccessibleCompanyIds(user);
  if (scopedIds === null) return;
  if (scopedIds.includes(companyId)) return;
  const err = new Error("Forbidden for this company") as Error & { statusCode: number };
  err.statusCode = 403;
  throw err;
}

async function getProviderAccessibleOrThrow(user: AuthUser, providerId: string, permission: string) {
  await authorize(user, permission);
  const scopedIds = await listAccessibleCompanyIds(user);
  const provider = await db.integrationProvider.findUnique({
    where: { id: providerId },
    select: {
      id: true,
      companyId: true,
      domain: true,
      providerCode: true,
      status: true,
      environment: true,
      capabilities: true,
      rateLimitRps: true,
      timeoutMs: true,
      retryPolicyId: true,
      secretRef: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!provider) {
    const err = new Error("Integration provider not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  if (scopedIds !== null && !scopedIds.includes(provider.companyId)) {
    const err = new Error("Forbidden for this provider") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  return provider;
}

function mapProviderRow(row: any) {
  return {
    id: row.id,
    companyId: row.companyId,
    domain: row.domain,
    providerCode: row.providerCode,
    status: row.status,
    environment: row.environment,
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.map((item: unknown) => String(item))
      : [],
    rateLimitRps: typeof row.rateLimitRps === "number" ? row.rateLimitRps : null,
    timeoutMs: Number(row.timeoutMs ?? 10000),
    retryPolicyId: row.retryPolicyId ?? null,
    secretRef: row.secretRef ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export async function listIntegrationProvidersForActor(args: {
  user: AuthUser;
  companyId?: string;
  domain?: IntegrationDomain;
  status?: IntegrationProviderStatus;
  environment?: IntegrationEnvironment;
  providerCode?: string;
}) {
  await authorize(args.user, "integration.provider.read");
  const scopedIds = await listAccessibleCompanyIds(args.user);
  const companyIdFilter = args.companyId?.trim() || undefined;
  if (companyIdFilter) {
    if (scopedIds !== null && !scopedIds.includes(companyIdFilter)) {
      const err = new Error("Forbidden for this company") as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
  }

  if (scopedIds !== null && scopedIds.length === 0) {
    return [] as ReturnType<typeof mapProviderRow>[];
  }

  const where = {
    ...(companyIdFilter
      ? { companyId: companyIdFilter }
      : scopedIds === null
        ? {}
        : { companyId: { in: scopedIds } }),
    ...(args.domain ? { domain: args.domain } : {}),
    ...(args.status ? { status: args.status } : {}),
    ...(args.environment ? { environment: args.environment } : {}),
    ...(args.providerCode ? { providerCode: normalizeProviderCode(args.providerCode) } : {}),
  };

  const rows = await db.integrationProvider.findMany({
    where,
    orderBy: [{ companyId: "asc" }, { domain: "asc" }, { providerCode: "asc" }],
  });
  return rows.map(mapProviderRow);
}

export async function upsertIntegrationProviderForActor(args: {
  user: AuthUser;
  companyId: string;
  domain: IntegrationDomain;
  providerCode: string;
  environment: IntegrationEnvironment;
  status?: IntegrationProviderStatus;
  capabilities?: unknown;
  rateLimitRps?: number | null;
  timeoutMs?: number;
  retryPolicyId?: string | null;
}) {
  await assertCompanyAccess(args.user, args.companyId, "integration.provider.manage");

  const providerCode = normalizeProviderCode(args.providerCode);
  if (!providerCode) {
    const err = new Error("providerCode is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const timeoutMs = Number(args.timeoutMs ?? 10000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    const err = new Error("timeoutMs must be between 100 and 120000") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const rateLimitRps =
    args.rateLimitRps == null
      ? null
      : Number.isFinite(args.rateLimitRps) && args.rateLimitRps >= 1
        ? Math.trunc(args.rateLimitRps)
        : NaN;
  if (Number.isNaN(rateLimitRps as number)) {
    const err = new Error("rateLimitRps must be null or >= 1") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const row = await db.integrationProvider.upsert({
    where: {
      companyId_domain_providerCode_environment: {
        companyId: args.companyId,
        domain: args.domain,
        providerCode,
        environment: args.environment,
      },
    },
    create: {
      companyId: args.companyId,
      domain: args.domain,
      providerCode,
      environment: args.environment,
      status: args.status ?? PROVIDER_STATUS_ACTIVE,
      capabilities: normalizeCapabilities(args.capabilities),
      rateLimitRps,
      timeoutMs: Math.trunc(timeoutMs),
      retryPolicyId: args.retryPolicyId ?? null,
      createdByUserId: args.user.id,
      updatedByUserId: args.user.id,
    },
    update: {
      status: args.status ?? undefined,
      capabilities: normalizeCapabilities(args.capabilities),
      rateLimitRps,
      timeoutMs: Math.trunc(timeoutMs),
      retryPolicyId: args.retryPolicyId ?? null,
      updatedByUserId: args.user.id,
    },
  });

  return mapProviderRow(row);
}

export async function updateIntegrationProviderStatusForActor(args: {
  user: AuthUser;
  providerId: string;
  status: IntegrationProviderStatus;
}) {
  const provider = await getProviderAccessibleOrThrow(
    args.user,
    args.providerId,
    "integration.provider.manage",
  );

  const updated = await db.integrationProvider.update({
    where: { id: provider.id },
    data: {
      status: args.status,
      updatedByUserId: args.user.id,
    },
  });
  return mapProviderRow(updated);
}

export async function rotateIntegrationProviderSecretForActor(args: {
  user: AuthUser;
  providerId: string;
  secretPayload: unknown;
  keyVersion?: number;
}) {
  const provider = await getProviderAccessibleOrThrow(
    args.user,
    args.providerId,
    "integration.provider.rotateSecret",
  );
  const raw = secretPayloadToString(args.secretPayload);
  if (!raw.trim()) {
    const err = new Error("secretPayload is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const latest = await db.integrationProviderSecret.findFirst({
    where: { providerId: provider.id },
    orderBy: { keyVersion: "desc" },
    select: { keyVersion: true },
  });
  const resolvedKeyVersion =
    args.keyVersion != null ? Math.trunc(Number(args.keyVersion)) : (latest?.keyVersion ?? 0) + 1;
  if (!Number.isFinite(resolvedKeyVersion) || resolvedKeyVersion < 1) {
    const err = new Error("keyVersion must be >= 1") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const encryptedSecretJson = encryptIntegrationSecret(raw);
  const secretMasked = summarizeSecretPayload(args.secretPayload);

  const created = await db.$transaction(async (tx: any) => {
    const secret = await tx.integrationProviderSecret.create({
      data: {
        providerId: provider.id,
        keyVersion: resolvedKeyVersion,
        encryptedSecretJson,
        secretMasked,
        rotatedAt: new Date(),
        createdByUserId: args.user.id,
      },
    });
    await tx.integrationProvider.update({
      where: { id: provider.id },
      data: {
        secretRef: secret.id,
        updatedByUserId: args.user.id,
      },
    });
    return secret;
  });

  return {
    providerId: provider.id,
    secretRef: created.id,
    keyVersion: created.keyVersion,
    secretMasked: created.secretMasked ?? "****",
    rotatedAt: toIso(created.rotatedAt),
    createdAt: toIso(created.createdAt),
  };
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
