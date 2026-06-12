"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationOutboxRepository = void 0;
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const db = prismaClient_1.default;
function toIso(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value.toISOString();
    return new Date(value).toISOString();
}
function mapOutbox(row) {
    return {
        id: row.id,
        companyId: row.companyId,
        providerId: row.providerId ?? null,
        domain: row.domain,
        providerCode: row.providerCode,
        environment: row.environment ?? "sandbox",
        eventType: row.eventType,
        aggregateType: row.aggregateType ?? null,
        aggregateId: row.aggregateId ?? null,
        operation: row.operation ?? null,
        status: row.status,
        maxAttempts: Number(row.maxAttempts ?? 10),
        attemptCount: Number(row.attemptCount ?? 0),
        nextAttemptAt: toIso(row.nextAttemptAt) || new Date().toISOString(),
        lastAttemptAt: toIso(row.lastAttemptAt),
        lastError: row.lastError ?? null,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload,
        createdAt: toIso(row.createdAt) || new Date().toISOString(),
        updatedAt: toIso(row.updatedAt) || new Date().toISOString(),
    };
}
function toDate(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return new Date();
    return parsed;
}
async function createAttempt(args) {
    await args.tx.integrationDeliveryAttempt.create({
        data: {
            outboxId: args.outboxId,
            attemptNo: args.attempt.attemptNo,
            outcome: args.outcome,
            statusCode: args.attempt.statusCode ?? null,
            retryable: Boolean(args.attempt.retryable),
            errorMessage: args.attempt.errorMessage ?? null,
            providerRequestId: args.attempt.providerRequestId ?? null,
            requestJson: (args.attempt.requestJson ?? null),
            responseJson: (args.attempt.responseJson ?? null),
            startedAt: toDate(args.attempt.startedAt),
            finishedAt: toDate(args.attempt.finishedAt),
        },
    });
}
exports.integrationOutboxRepository = {
    async enqueue(record) {
        const row = await db.integrationOutbox.create({
            data: {
                companyId: record.companyId,
                providerId: record.providerId ?? null,
                domain: record.domain,
                providerCode: record.providerCode,
                environment: record.environment,
                eventType: record.eventType,
                aggregateType: record.aggregateType ?? null,
                aggregateId: record.aggregateId ?? null,
                operation: record.operation ?? null,
                status: record.status,
                maxAttempts: record.maxAttempts,
                attemptCount: record.attemptCount,
                nextAttemptAt: toDate(record.nextAttemptAt),
                lastAttemptAt: record.lastAttemptAt ? toDate(record.lastAttemptAt) : null,
                lastError: record.lastError ?? null,
                idempotencyKey: record.idempotencyKey,
                payload: record.payload,
            },
        });
        return mapOutbox(row);
    },
    async claimBatch(args) {
        const limit = Math.max(1, Math.min(args.limit, 500));
        const now = toDate(args.nowIso);
        const staleProcessingBefore = args.staleProcessingBeforeIso
            ? toDate(args.staleProcessingBeforeIso)
            : null;
        return db.$transaction(async (tx) => {
            const candidates = await tx.integrationOutbox.findMany({
                where: {
                    OR: [
                        {
                            status: { in: ["pending", "failed"] },
                            nextAttemptAt: { lte: now },
                        },
                        ...(staleProcessingBefore
                            ? [
                                {
                                    status: "processing",
                                    updatedAt: { lte: staleProcessingBefore },
                                },
                            ]
                            : []),
                    ],
                },
                orderBy: [{ updatedAt: "asc" }, { nextAttemptAt: "asc" }, { createdAt: "asc" }],
                take: limit,
            });
            if (!candidates.length)
                return [];
            const claimedIds = [];
            for (const row of candidates) {
                const claimWhere = row.status === "processing"
                    ? {
                        id: row.id,
                        status: "processing",
                        ...(staleProcessingBefore ? { updatedAt: { lte: staleProcessingBefore } } : {}),
                    }
                    : {
                        id: row.id,
                        status: { in: ["pending", "failed"] },
                        nextAttemptAt: { lte: now },
                    };
                const updated = await tx.integrationOutbox.updateMany({
                    where: claimWhere,
                    data: {
                        status: "processing",
                    },
                });
                if (updated.count > 0)
                    claimedIds.push(row.id);
            }
            if (!claimedIds.length)
                return [];
            const claimedRows = await tx.integrationOutbox.findMany({
                where: { id: { in: claimedIds } },
                orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
            });
            return claimedRows.map(mapOutbox);
        });
    },
    async markSent(id, attempt) {
        await db.$transaction(async (tx) => {
            await createAttempt({ tx, outboxId: id, attempt, outcome: "success" });
            await tx.integrationOutbox.update({
                where: { id },
                data: {
                    status: "sent",
                    lastAttemptAt: toDate(attempt.finishedAt),
                    attemptCount: { increment: 1 },
                    lastError: null,
                },
            });
        });
    },
    async markRetry(id, attempt, nextAttemptAt) {
        await db.$transaction(async (tx) => {
            await createAttempt({ tx, outboxId: id, attempt, outcome: "retry" });
            await tx.integrationOutbox.update({
                where: { id },
                data: {
                    status: "failed",
                    lastAttemptAt: toDate(attempt.finishedAt),
                    attemptCount: { increment: 1 },
                    lastError: attempt.errorMessage ?? null,
                    nextAttemptAt: toDate(nextAttemptAt),
                },
            });
        });
    },
    async markDeadLetter(id, attempt) {
        await db.$transaction(async (tx) => {
            await createAttempt({ tx, outboxId: id, attempt, outcome: "dead_letter" });
            await tx.integrationOutbox.update({
                where: { id },
                data: {
                    status: "dead_letter",
                    lastAttemptAt: toDate(attempt.finishedAt),
                    attemptCount: { increment: 1 },
                    lastError: attempt.errorMessage ?? null,
                },
            });
        });
    },
};
