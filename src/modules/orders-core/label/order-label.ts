import path from "path";
import { OrderLabelJobStatus } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { generateLabelPDF } from "../../../modules/labels-core/application/labelService";
import { uploadLabel } from "../../../utils/uploadLabel";
import { orderError } from "../shared";

type LabelJobLike = {
  id: string;
  orderId: string;
  attempts: number;
  maxAttempts: number;
};

type RunQueueTickArgs = {
  workerId: string;
  batchSize?: number;
};

export type OrderLabelMode = "sync" | "async" | "queue";

export type LabelQueueTickResult = {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
};

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function resolveOrderLabelMode(
  rawMode: string | undefined,
  fallback: OrderLabelMode = "queue",
): OrderLabelMode {
  return rawMode === "sync" || rawMode === "async" || rawMode === "queue"
    ? rawMode
    : fallback;
}

export function isOrderLabelAutoFallbackEnabled() {
  return process.env.ORDER_LABEL_AUTO_FALLBACK !== "false";
}

function resolveFallbackDelayMs() {
  return parsePositiveInt(process.env.ORDER_LABEL_FALLBACK_DELAY_MS, 15000);
}

function resolveStaleProcessingMs() {
  return parsePositiveInt(process.env.ORDER_LABEL_STALE_PROCESSING_MS, 300000);
}

function buildRetryDelayMs(attempt: number) {
  const baseDelayMs = parsePositiveInt(process.env.ORDER_LABEL_RETRY_BASE_MS, 15000);
  const capDelayMs = parsePositiveInt(process.env.ORDER_LABEL_RETRY_CAP_MS, 300000);
  return Math.min(baseDelayMs * Math.max(1, attempt), capDelayMs);
}

function trimError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return message.length > 1200 ? `${message.slice(0, 1200)}...` : message;
}

async function loadOrderForLabeling(orderId: string) {
  const order = await prisma.order.findUnique({
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
    throw orderError(`Order ${orderId} not found for label generation`, 404);
  }

  return order;
}

export async function generateAndAttachParcelLabelsForOrder(orderId: string) {
  const order = await loadOrderForLabeling(orderId);
  if (!order.parcels.length) return 0;

  const labelUpdates: Array<{ parcelId: string; labelKey: string }> = [];

  for (const parcel of order.parcels) {
    const labelPath = await generateLabelPDF({
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

    const labelFileName = path.basename(labelPath);
    const { key: labelKey } = await uploadLabel(labelFileName);

    labelUpdates.push({ parcelId: parcel.id, labelKey });
  }

  if (labelUpdates.length) {
    await prisma.$transaction(
      labelUpdates.map((entry) =>
        prisma.parcel.update({
          where: { id: entry.parcelId },
          data: { labelKey: entry.labelKey },
        }),
      ),
    );
  }

  return labelUpdates.length;
}

export async function enqueueOrderLabelJob(orderId: string) {
  const maxAttempts = parsePositiveInt(process.env.ORDER_LABEL_MAX_ATTEMPTS, 5);

  return prisma.orderLabelJob.upsert({
    where: { orderId },
    create: {
      orderId,
      status: OrderLabelJobStatus.pending,
      attempts: 0,
      maxAttempts,
      availableAt: new Date(),
      error: null,
      lockedAt: null,
      lockedBy: null,
    },
    update: {
      status: OrderLabelJobStatus.pending,
      attempts: 0,
      maxAttempts,
      availableAt: new Date(),
      error: null,
      lockedAt: null,
      lockedBy: null,
    },
  });
}

async function hasMissingParcelLabels(orderId: string) {
  const unlabeled = await prisma.parcel.count({
    where: {
      orderId,
      OR: [{ labelKey: null }, { labelKey: "" }],
    },
  });

  return unlabeled > 0;
}

export async function shouldRunOrderLabelAutoFallback(orderId: string) {
  const missingLabels = await hasMissingParcelLabels(orderId);
  if (!missingLabels) return false;

  const job = await prisma.orderLabelJob.findUnique({
    where: { orderId },
    select: {
      status: true,
      lockedAt: true,
    },
  });

  if (!job) return true;
  if (job.status === OrderLabelJobStatus.completed) return false;

  if (job.status === OrderLabelJobStatus.processing && job.lockedAt) {
    const staleAfterMs = resolveStaleProcessingMs();
    const lockAgeMs = Date.now() - job.lockedAt.getTime();
    return lockAgeMs >= staleAfterMs;
  }

  return true;
}

export async function runOrderLabelAutoFallback(orderId: string) {
  const shouldRun = await shouldRunOrderLabelAutoFallback(orderId);
  if (!shouldRun) return false;

  await generateAndAttachParcelLabelsForOrder(orderId);

  await prisma.orderLabelJob.updateMany({
    where: {
      orderId,
      status: {
        in: [
          OrderLabelJobStatus.pending,
          OrderLabelJobStatus.failed,
          OrderLabelJobStatus.processing,
        ],
      },
    },
    data: {
      status: OrderLabelJobStatus.completed,
      error: "Completed by auto-fallback",
      lockedAt: null,
      lockedBy: null,
      availableAt: new Date(),
    },
  });

  return true;
}

export function scheduleOrderLabelAutoFallback(orderId: string, delayMs?: number) {
  if (!isOrderLabelAutoFallbackEnabled()) return;

  const waitMs = Math.max(1000, delayMs ?? resolveFallbackDelayMs());
  const timer = setTimeout(() => {
    void runOrderLabelAutoFallback(orderId).catch((error) => {
      console.error(
        `[order-label] auto fallback failed for order ${orderId}:`,
        error,
      );
    });
  }, waitMs);
  timer.unref?.();
}

async function claimOrderLabelJobs(workerId: string, batchSize: number): Promise<LabelJobLike[]> {
  const now = new Date();

  const candidates = await prisma.orderLabelJob.findMany({
    where: {
      status: { in: [OrderLabelJobStatus.pending, OrderLabelJobStatus.failed] },
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

  const claimed: LabelJobLike[] = [];

  for (const candidate of candidates) {
    if (candidate.attempts >= candidate.maxAttempts) continue;

    const updated = await prisma.orderLabelJob.updateMany({
      where: {
        id: candidate.id,
        attempts: candidate.attempts,
        status: { in: [OrderLabelJobStatus.pending, OrderLabelJobStatus.failed] },
        availableAt: { lte: now },
      },
      data: {
        status: OrderLabelJobStatus.processing,
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

    if (claimed.length >= batchSize) break;
  }

  return claimed;
}

async function markJobCompleted(jobId: string) {
  await prisma.orderLabelJob.update({
    where: { id: jobId },
    data: {
      status: OrderLabelJobStatus.completed,
      error: null,
      lockedAt: null,
      lockedBy: null,
      availableAt: new Date(),
    },
  });
}

async function markJobFailure(job: LabelJobLike, error: unknown) {
  const exhausted = job.attempts >= job.maxAttempts;
  const nextStatus = exhausted ? OrderLabelJobStatus.failed : OrderLabelJobStatus.pending;
  const retryAt = new Date(Date.now() + buildRetryDelayMs(job.attempts));

  await prisma.orderLabelJob.update({
    where: { id: job.id },
    data: {
      status: nextStatus,
      error: trimError(error),
      lockedAt: null,
      lockedBy: null,
      availableAt: exhausted ? new Date() : retryAt,
    },
  });

  return exhausted;
}

export async function runOrderLabelQueueTick(
  args: RunQueueTickArgs,
): Promise<LabelQueueTickResult> {
  const batchSize = parsePositiveInt(
    args.batchSize ? String(args.batchSize) : process.env.ORDER_LABEL_WORKER_BATCH_SIZE,
    10,
  );

  const claimedJobs = await claimOrderLabelJobs(args.workerId, batchSize);

  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (const job of claimedJobs) {
    try {
      await generateAndAttachParcelLabelsForOrder(job.orderId);
      await markJobCompleted(job.id);
      completed += 1;
    } catch (error) {
      const exhausted = await markJobFailure(job, error);
      if (exhausted) failed += 1;
      else retried += 1;
    }
  }

  return {
    claimed: claimedJobs.length,
    completed,
    retried,
    failed,
  };
}
