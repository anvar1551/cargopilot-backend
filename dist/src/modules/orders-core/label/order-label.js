"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveOrderLabelMode = resolveOrderLabelMode;
exports.isOrderLabelAutoFallbackEnabled = isOrderLabelAutoFallbackEnabled;
exports.generateAndAttachParcelLabelsForOrder = generateAndAttachParcelLabelsForOrder;
exports.enqueueOrderLabelJob = enqueueOrderLabelJob;
exports.shouldRunOrderLabelAutoFallback = shouldRunOrderLabelAutoFallback;
exports.runOrderLabelAutoFallback = runOrderLabelAutoFallback;
exports.scheduleOrderLabelAutoFallback = scheduleOrderLabelAutoFallback;
exports.runOrderLabelQueueTick = runOrderLabelQueueTick;
const path_1 = __importDefault(require("path"));
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const labelService_1 = require("../../../modules/labels-core/application/labelService");
const uploadLabel_1 = require("../../../utils/uploadLabel");
const shared_1 = require("../shared");
const autoTriage_1 = require("../../support-core/application/autoTriage");
function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
function resolveOrderLabelMode(rawMode, fallback = "queue") {
    return rawMode === "sync" || rawMode === "async" || rawMode === "queue"
        ? rawMode
        : fallback;
}
function isOrderLabelAutoFallbackEnabled() {
    return process.env.ORDER_LABEL_AUTO_FALLBACK !== "false";
}
function resolveFallbackDelayMs() {
    return parsePositiveInt(process.env.ORDER_LABEL_FALLBACK_DELAY_MS, 15000);
}
function resolveStaleProcessingMs() {
    return parsePositiveInt(process.env.ORDER_LABEL_STALE_PROCESSING_MS, 300000);
}
function buildRetryDelayMs(attempt) {
    const baseDelayMs = parsePositiveInt(process.env.ORDER_LABEL_RETRY_BASE_MS, 15000);
    const capDelayMs = parsePositiveInt(process.env.ORDER_LABEL_RETRY_CAP_MS, 300000);
    return Math.min(baseDelayMs * Math.max(1, attempt), capDelayMs);
}
function trimError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
    return message.length > 1200 ? `${message.slice(0, 1200)}...` : message;
}
async function loadOrderForLabeling(orderId) {
    const order = await prismaClient_1.default.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            createdAt: true,
            pickupAddress: true,
            dropoffAddress: true,
            destinationCity: true,
            referenceId: true,
            weightKg: true,
            serviceType: true,
            codAmount: true,
            currency: true,
            senderName: true,
            senderPhone: true,
            receiverName: true,
            receiverPhone: true,
            parcels: {
                select: {
                    id: true,
                    parcelCode: true,
                    pieceNo: true,
                    pieceTotal: true,
                    weightKg: true,
                },
            },
        },
    });
    if (!order) {
        throw (0, shared_1.orderError)(`Order ${orderId} not found for label generation`, 404);
    }
    return order;
}
async function generateAndAttachParcelLabelsForOrder(orderId) {
    const order = await loadOrderForLabeling(orderId);
    if (!order.parcels.length)
        return 0;
    const labelUpdates = [];
    for (const parcel of order.parcels) {
        const labelPath = await (0, labelService_1.generateLabelPDF)({
            parcelCode: parcel.parcelCode,
            pieceNo: parcel.pieceNo,
            pieceTotal: parcel.pieceTotal,
            pickupAddress: order.pickupAddress,
            dropoffAddress: order.dropoffAddress,
            destinationCity: order.destinationCity ?? undefined,
            referenceId: order.referenceId ?? undefined,
            createdAt: order.createdAt,
            codAmount: order.codAmount ?? undefined,
            currency: order.currency ?? undefined,
            weightKg: parcel.weightKg ?? order.weightKg ?? undefined,
            serviceType: order.serviceType ?? undefined,
            senderName: order.senderName ?? undefined,
            senderPhone: order.senderPhone ?? undefined,
            receiverName: order.receiverName ?? undefined,
            receiverPhone: order.receiverPhone ?? undefined,
        });
        const labelFileName = path_1.default.basename(labelPath);
        const { key: labelKey } = await (0, uploadLabel_1.uploadLabel)(labelFileName);
        labelUpdates.push({ parcelId: parcel.id, labelKey });
    }
    if (labelUpdates.length) {
        await prismaClient_1.default.$transaction(labelUpdates.map((entry) => prismaClient_1.default.parcel.update({
            where: { id: entry.parcelId },
            data: { labelKey: entry.labelKey },
        })));
    }
    return labelUpdates.length;
}
async function enqueueOrderLabelJob(orderId) {
    const maxAttempts = parsePositiveInt(process.env.ORDER_LABEL_MAX_ATTEMPTS, 5);
    return prismaClient_1.default.orderLabelJob.upsert({
        where: { orderId },
        create: {
            orderId,
            status: client_1.OrderLabelJobStatus.pending,
            attempts: 0,
            maxAttempts,
            availableAt: new Date(),
            error: null,
            lockedAt: null,
            lockedBy: null,
        },
        update: {
            status: client_1.OrderLabelJobStatus.pending,
            attempts: 0,
            maxAttempts,
            availableAt: new Date(),
            error: null,
            lockedAt: null,
            lockedBy: null,
        },
    });
}
async function hasMissingParcelLabels(orderId) {
    const unlabeled = await prismaClient_1.default.parcel.count({
        where: {
            orderId,
            OR: [{ labelKey: null }, { labelKey: "" }],
        },
    });
    return unlabeled > 0;
}
async function shouldRunOrderLabelAutoFallback(orderId) {
    const missingLabels = await hasMissingParcelLabels(orderId);
    if (!missingLabels)
        return false;
    const job = await prismaClient_1.default.orderLabelJob.findUnique({
        where: { orderId },
        select: {
            status: true,
            lockedAt: true,
        },
    });
    if (!job)
        return true;
    if (job.status === client_1.OrderLabelJobStatus.completed)
        return false;
    if (job.status === client_1.OrderLabelJobStatus.processing && job.lockedAt) {
        const staleAfterMs = resolveStaleProcessingMs();
        const lockAgeMs = Date.now() - job.lockedAt.getTime();
        return lockAgeMs >= staleAfterMs;
    }
    return true;
}
async function runOrderLabelAutoFallback(orderId) {
    const shouldRun = await shouldRunOrderLabelAutoFallback(orderId);
    if (!shouldRun)
        return false;
    await generateAndAttachParcelLabelsForOrder(orderId);
    await prismaClient_1.default.orderLabelJob.updateMany({
        where: {
            orderId,
            status: {
                in: [
                    client_1.OrderLabelJobStatus.pending,
                    client_1.OrderLabelJobStatus.failed,
                    client_1.OrderLabelJobStatus.processing,
                ],
            },
        },
        data: {
            status: client_1.OrderLabelJobStatus.completed,
            error: "Completed by auto-fallback",
            lockedAt: null,
            lockedBy: null,
            availableAt: new Date(),
        },
    });
    return true;
}
function scheduleOrderLabelAutoFallback(orderId, delayMs) {
    if (!isOrderLabelAutoFallbackEnabled())
        return;
    const waitMs = Math.max(1000, delayMs ?? resolveFallbackDelayMs());
    const timer = setTimeout(() => {
        void runOrderLabelAutoFallback(orderId).catch((error) => {
            console.error(`[order-label] auto fallback failed for order ${orderId}:`, error);
        });
    }, waitMs);
    timer.unref?.();
}
async function claimOrderLabelJobs(workerId, batchSize) {
    const now = new Date();
    const candidates = await prismaClient_1.default.orderLabelJob.findMany({
        where: {
            status: { in: [client_1.OrderLabelJobStatus.pending, client_1.OrderLabelJobStatus.failed] },
            availableAt: { lte: now },
        },
        select: {
            id: true,
            orderId: true,
            attempts: true,
            maxAttempts: true,
        },
        orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
        take: Math.max(batchSize * 2, batchSize),
    });
    const claimed = [];
    for (const candidate of candidates) {
        if (candidate.attempts >= candidate.maxAttempts)
            continue;
        const updated = await prismaClient_1.default.orderLabelJob.updateMany({
            where: {
                id: candidate.id,
                attempts: candidate.attempts,
                status: { in: [client_1.OrderLabelJobStatus.pending, client_1.OrderLabelJobStatus.failed] },
                availableAt: { lte: now },
            },
            data: {
                status: client_1.OrderLabelJobStatus.processing,
                lockedAt: now,
                lockedBy: workerId,
                attempts: { increment: 1 },
                error: null,
            },
        });
        if (updated.count === 1) {
            claimed.push({
                id: candidate.id,
                orderId: candidate.orderId,
                attempts: candidate.attempts + 1,
                maxAttempts: candidate.maxAttempts,
            });
        }
        if (claimed.length >= batchSize)
            break;
    }
    return claimed;
}
async function markJobCompleted(jobId) {
    await prismaClient_1.default.orderLabelJob.update({
        where: { id: jobId },
        data: {
            status: client_1.OrderLabelJobStatus.completed,
            error: null,
            lockedAt: null,
            lockedBy: null,
            availableAt: new Date(),
        },
    });
}
async function markJobFailure(job, error) {
    const exhausted = job.attempts >= job.maxAttempts;
    const nextStatus = exhausted ? client_1.OrderLabelJobStatus.failed : client_1.OrderLabelJobStatus.pending;
    const retryAt = new Date(Date.now() + buildRetryDelayMs(job.attempts));
    const errorMessage = trimError(error);
    await prismaClient_1.default.orderLabelJob.update({
        where: { id: job.id },
        data: {
            status: nextStatus,
            error: errorMessage,
            lockedAt: null,
            lockedBy: null,
            availableAt: exhausted ? new Date() : retryAt,
        },
    });
    if (exhausted) {
        void (0, autoTriage_1.createLabelFailureSupportTicket)({
            orderId: job.orderId,
            jobId: job.id,
            reason: errorMessage,
            exhausted: true,
        }).catch(() => undefined);
    }
    return exhausted;
}
async function runOrderLabelQueueTick(args) {
    const batchSize = parsePositiveInt(args.batchSize ? String(args.batchSize) : process.env.ORDER_LABEL_WORKER_BATCH_SIZE, 10);
    const claimedJobs = await claimOrderLabelJobs(args.workerId, batchSize);
    let completed = 0;
    let retried = 0;
    let failed = 0;
    for (const job of claimedJobs) {
        try {
            await generateAndAttachParcelLabelsForOrder(job.orderId);
            await markJobCompleted(job.id);
            completed += 1;
        }
        catch (error) {
            const exhausted = await markJobFailure(job, error);
            if (exhausted)
                failed += 1;
            else
                retried += 1;
        }
    }
    return {
        claimed: claimedJobs.length,
        completed,
        retried,
        failed,
    };
}
