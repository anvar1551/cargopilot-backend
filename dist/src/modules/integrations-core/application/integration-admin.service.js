"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listIntegrationProvidersForActor = listIntegrationProvidersForActor;
exports.upsertIntegrationProviderForActor = upsertIntegrationProviderForActor;
exports.updateIntegrationProviderStatusForActor = updateIntegrationProviderStatusForActor;
exports.deleteIntegrationProviderForActor = deleteIntegrationProviderForActor;
exports.rotateIntegrationProviderSecretForActor = rotateIntegrationProviderSecretForActor;
exports.listIntegrationOutboxForActor = listIntegrationOutboxForActor;
exports.listIntegrationOutboxAttemptsForActor = listIntegrationOutboxAttemptsForActor;
exports.listIntegrationWebhookEventsForActor = listIntegrationWebhookEventsForActor;
exports.listIntegrationCanonicalEventsForActor = listIntegrationCanonicalEventsForActor;
exports.replayIntegrationOutboxForActor = replayIntegrationOutboxForActor;
exports.retryIntegrationOutboxNowForActor = retryIntegrationOutboxNowForActor;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const identity_access_1 = require("../../identity-access");
const integration_secret_crypto_1 = require("./integration-secret.crypto");
const PROVIDER_STATUS_ACTIVE = "active";
const OUTBOX_STATUS_PENDING = "pending";
const OUTBOX_STATUS_FAILED = "failed";
const OUTBOX_STATUS_SENT = "sent";
const OUTBOX_STATUS_DEAD_LETTER = "dead_letter";
const db = prismaClient_1.default;
function toIso(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value.toISOString();
    return new Date(value).toISOString();
}
function normalizeProviderCode(value) {
    return String(value || "").trim().toLowerCase();
}
function normalizeCapabilities(value) {
    if (!Array.isArray(value))
        return [];
    return Array.from(new Set(value
        .map((item) => String(item || "").trim())
        .filter(Boolean)));
}
function canOverrideScope(user) {
    return (0, identity_access_1.hasAnyPermissionSync)(user, ["policy.override"]);
}
async function listAccessibleCompanyIds(user) {
    if (canOverrideScope(user))
        return null;
    const memberships = await db.companyMembership.findMany({
        where: {
            userId: user.id,
            status: client_1.MembershipStatus.active,
        },
        select: {
            companyId: true,
        },
    });
    return Array.from(new Set(memberships.map((item) => item.companyId).filter(Boolean)));
}
async function assertCompanyAccess(user, companyId, permission) {
    await (0, identity_access_1.authorize)(user, permission);
    const scopedIds = await listAccessibleCompanyIds(user);
    if (scopedIds === null)
        return;
    if (scopedIds.includes(companyId))
        return;
    const err = new Error("Forbidden for this company");
    err.statusCode = 403;
    throw err;
}
async function getProviderAccessibleOrThrow(user, providerId, permission) {
    await (0, identity_access_1.authorize)(user, permission);
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
        const err = new Error("Integration provider not found");
        err.statusCode = 404;
        throw err;
    }
    if (scopedIds !== null && !scopedIds.includes(provider.companyId)) {
        const err = new Error("Forbidden for this provider");
        err.statusCode = 403;
        throw err;
    }
    return provider;
}
function mapProviderRow(row) {
    return {
        id: row.id,
        companyId: row.companyId,
        domain: row.domain,
        providerCode: row.providerCode,
        status: row.status,
        environment: row.environment,
        capabilities: Array.isArray(row.capabilities)
            ? row.capabilities.map((item) => String(item))
            : [],
        rateLimitRps: typeof row.rateLimitRps === "number" ? row.rateLimitRps : null,
        timeoutMs: Number(row.timeoutMs ?? 10000),
        retryPolicyId: row.retryPolicyId ?? null,
        secretRef: row.secretRef ?? null,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
    };
}
async function listIntegrationProvidersForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "integration.provider.read");
    const scopedIds = await listAccessibleCompanyIds(args.user);
    const companyIdFilter = args.companyId?.trim() || undefined;
    if (companyIdFilter) {
        if (scopedIds !== null && !scopedIds.includes(companyIdFilter)) {
            const err = new Error("Forbidden for this company");
            err.statusCode = 403;
            throw err;
        }
    }
    if (scopedIds !== null && scopedIds.length === 0) {
        return [];
    }
    const q = args.q?.trim();
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
        ...(q
            ? {
                OR: [
                    { providerCode: { contains: q, mode: "insensitive" } },
                    { retryPolicyId: { contains: q, mode: "insensitive" } },
                ],
            }
            : {}),
    };
    const limit = Math.min(Math.max(Number(args.limit ?? 0), 1), 100);
    const usePagination = Boolean(args.limit);
    const rows = await db.integrationProvider.findMany({
        where,
        orderBy: [{ companyId: "asc" }, { domain: "asc" }, { providerCode: "asc" }],
        ...(usePagination
            ? {
                take: limit + 1,
                ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
            }
            : {}),
    });
    if (!usePagination)
        return rows.map(mapProviderRow);
    const pageRows = rows.slice(0, limit);
    const hasNextPage = rows.length > limit;
    const total = await db.integrationProvider.count({ where });
    return {
        data: pageRows.map(mapProviderRow),
        total,
        pageInfo: {
            limit,
            hasNextPage,
            nextCursor: hasNextPage ? pageRows[pageRows.length - 1]?.id ?? null : null,
        },
    };
}
async function upsertIntegrationProviderForActor(args) {
    await assertCompanyAccess(args.user, args.companyId, "integration.provider.manage");
    const providerCode = normalizeProviderCode(args.providerCode);
    if (!providerCode) {
        const err = new Error("providerCode is required");
        err.statusCode = 400;
        throw err;
    }
    const timeoutMs = Number(args.timeoutMs ?? 10000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
        const err = new Error("timeoutMs must be between 100 and 120000");
        err.statusCode = 400;
        throw err;
    }
    const rateLimitRps = args.rateLimitRps == null
        ? null
        : Number.isFinite(args.rateLimitRps) && args.rateLimitRps >= 1
            ? Math.trunc(args.rateLimitRps)
            : NaN;
    if (Number.isNaN(rateLimitRps)) {
        const err = new Error("rateLimitRps must be null or >= 1");
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
async function updateIntegrationProviderStatusForActor(args) {
    const provider = await getProviderAccessibleOrThrow(args.user, args.providerId, "integration.provider.manage");
    const updated = await db.integrationProvider.update({
        where: { id: provider.id },
        data: {
            status: args.status,
            updatedByUserId: args.user.id,
        },
    });
    return mapProviderRow(updated);
}
async function deleteIntegrationProviderForActor(args) {
    const provider = await getProviderAccessibleOrThrow(args.user, args.providerId, "integration.provider.manage");
    const [primaryRules, fallbackRules, outboxRecords, webhookEvents, canonicalEvents,] = await Promise.all([
        db.carrierRoutingRule.count({ where: { providerId: provider.id } }),
        db.carrierRoutingRule.count({ where: { fallbackProviderId: provider.id } }),
        db.integrationOutbox.count({ where: { providerId: provider.id } }),
        db.integrationWebhookEvent.count({ where: { providerId: provider.id } }),
        db.integrationCanonicalEvent.count({ where: { providerId: provider.id } }),
    ]);
    const referenceCount = primaryRules + fallbackRules + outboxRecords + webhookEvents + canonicalEvents;
    if (referenceCount > 0) {
        const err = new Error([
            "Integration provider is still referenced and cannot be deleted.",
            `carrierRules=${primaryRules}`,
            `fallbackRules=${fallbackRules}`,
            `outboxRecords=${outboxRecords}`,
            `webhookEvents=${webhookEvents}`,
            `canonicalEvents=${canonicalEvents}`,
        ].join(" "));
        err.statusCode = 409;
        throw err;
    }
    await db.integrationProvider.delete({ where: { id: provider.id } });
    return {
        deleted: true,
        id: provider.id,
        providerCode: provider.providerCode,
    };
}
async function rotateIntegrationProviderSecretForActor(args) {
    const provider = await getProviderAccessibleOrThrow(args.user, args.providerId, "integration.provider.rotateSecret");
    const raw = (0, integration_secret_crypto_1.secretPayloadToString)(args.secretPayload);
    if (!raw.trim()) {
        const err = new Error("secretPayload is required");
        err.statusCode = 400;
        throw err;
    }
    const latest = await db.integrationProviderSecret.findFirst({
        where: { providerId: provider.id },
        orderBy: { keyVersion: "desc" },
        select: { keyVersion: true },
    });
    const resolvedKeyVersion = args.keyVersion != null ? Math.trunc(Number(args.keyVersion)) : (latest?.keyVersion ?? 0) + 1;
    if (!Number.isFinite(resolvedKeyVersion) || resolvedKeyVersion < 1) {
        const err = new Error("keyVersion must be >= 1");
        err.statusCode = 400;
        throw err;
    }
    const encryptedSecretJson = (0, integration_secret_crypto_1.encryptIntegrationSecret)(raw);
    const secretMasked = (0, integration_secret_crypto_1.summarizeSecretPayload)(args.secretPayload);
    const created = await db.$transaction(async (tx) => {
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
function buildOutboxWhere(args) {
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
async function getOutboxAccessibleOrThrow(user, outboxId, permission) {
    await (0, identity_access_1.authorize)(user, permission);
    const scopedIds = await listAccessibleCompanyIds(user);
    const row = await db.integrationOutbox.findUnique({
        where: { id: outboxId },
    });
    if (!row) {
        const err = new Error("Outbox record not found");
        err.statusCode = 404;
        throw err;
    }
    if (scopedIds !== null && !scopedIds.includes(row.companyId)) {
        const err = new Error("Forbidden for this outbox record");
        err.statusCode = 403;
        throw err;
    }
    return row;
}
async function listIntegrationOutboxForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "integration.outbox.read");
    const scopedIds = await listAccessibleCompanyIds(args.user);
    const companyIdFilter = args.companyId?.trim() || undefined;
    if (companyIdFilter && scopedIds !== null && !scopedIds.includes(companyIdFilter)) {
        const err = new Error("Forbidden for this company");
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
        items: rows.map((row) => ({
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
async function listIntegrationOutboxAttemptsForActor(args) {
    const outbox = await getOutboxAccessibleOrThrow(args.user, args.outboxId, "integration.outbox.read");
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(args.limit || 50))));
    const rows = await db.integrationDeliveryAttempt.findMany({
        where: { outboxId: outbox.id },
        orderBy: [{ attemptNo: "desc" }],
        take: limit,
    });
    return rows.map((row) => ({
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
async function listIntegrationWebhookEventsForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "integration.outbox.read");
    const scopedIds = await listAccessibleCompanyIds(args.user);
    const companyIdFilter = args.companyId?.trim() || undefined;
    if (companyIdFilter && scopedIds !== null && !scopedIds.includes(companyIdFilter)) {
        const err = new Error("Forbidden for this company");
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
        items: rows.map((row) => ({
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
async function listIntegrationCanonicalEventsForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "integration.outbox.read");
    const scopedIds = await listAccessibleCompanyIds(args.user);
    const companyIdFilter = args.companyId?.trim() || undefined;
    if (companyIdFilter && scopedIds !== null && !scopedIds.includes(companyIdFilter)) {
        const err = new Error("Forbidden for this company");
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
        items: rows.map((row) => ({
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
async function replayIntegrationOutboxForActor(args) {
    const outbox = await getOutboxAccessibleOrThrow(args.user, args.outboxId, "integration.outbox.replay");
    if (outbox.status !== OUTBOX_STATUS_DEAD_LETTER && outbox.status !== OUTBOX_STATUS_FAILED) {
        const err = new Error("Only failed/dead-letter records can be replayed");
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
            payload: outbox.payload,
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
async function retryIntegrationOutboxNowForActor(args) {
    const outbox = await getOutboxAccessibleOrThrow(args.user, args.outboxId, "integration.outbox.replay");
    if (outbox.status === OUTBOX_STATUS_SENT) {
        const err = new Error("Sent records cannot be retried");
        err.statusCode = 400;
        throw err;
    }
    if (outbox.status === OUTBOX_STATUS_DEAD_LETTER) {
        const err = new Error("Dead-letter record requires replay endpoint");
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
