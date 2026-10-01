import { requireAuthorizedOrder } from "../domain/order-access";
import { requireActiveOrderOwnership } from "../domain/worker-ownership";
import type { OrderActor } from "../shared/actor";
import path from "path";
import { OrderLabelJobStatus } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { generateLabelPDF } from "../../../modules/labels-core/application/labelService";
import { uploadLabel } from "../../../utils/uploadLabel";
import { orderError } from "../shared";
import { createLabelFailureSupportTicket } from "../../support-core/application/autoTriage";

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

async function loadLabelContent(orderId: string, tenantId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    select: {
      id: true,
      tenantId: true,
      ownerOrgId: true,
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
          orderId: true,
          labelKey: true,
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

export async function generateAndAttachParcelLabelsForOrder(orderId: string, actor?: OrderActor) {
  const authorized = await requireAuthorizedOrder(actor, orderId, "shipment.create");
  const order = await loadLabelContent(orderId, authorized.tenantId!);
  return attachLabels(order);
}

async function attachLabels(order: Awaited<ReturnType<typeof loadLabelContent>>) {
  if (!order.tenantId || !order.ownerOrgId) throw orderError("Label ownership required", 403);
  if (order.parcels.some(parcel => parcel.orderId !== order.id)) {
    throw orderError("Parcel does not belong to authorized order", 403);
  }
  if (!order.parcels.length) return 0;

  const labelUpdates: Array<{ parcelId: string; labelKey: string }> = [];

  for (const parcel of order.parcels) {
    if (parcel.labelKey) continue;
    const labelPath = await generateLabelPDF({
      outputFileName: `${parcel.id}.pdf`,
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
    const { key: labelKey } = await uploadLabel(labelFileName,
      `labels/${order.tenantId}/${order.ownerOrgId}/${order.id}/${parcel.id}.pdf`);

    labelUpdates.push({ parcelId: parcel.id, labelKey });
  }

  if (labelUpdates.length) {
    await prisma.$transaction(
      labelUpdates.map((entry) =>
        prisma.parcel.updateMany({
          where: { id: entry.parcelId, orderId: order.id },
          data: { labelKey: entry.labelKey },
        }),
      ),
    );
  }

  return labelUpdates.length;
}

export async function enqueueOrderLabelJob(orderId: string, actor?: OrderActor) {
  const order = await requireAuthorizedOrder(actor, orderId, "shipment.create");
  await requireActiveOrderOwnership(prisma, orderId, order.tenantId!, order.ownerOrgId!);
  const maxAttempts = parsePositiveInt(process.env.ORDER_LABEL_MAX_ATTEMPTS, 5);

  return prisma.orderLabelJob.upsert({
    where: { orderId },
    create: {
      orderId,
      ownershipTenantId: order.tenantId,
      ownershipCompanyId: order.ownerOrgId,
      acceptedAt: new Date(),
      capability: "label.generate",
      status: OrderLabelJobStatus.pending,
      attempts: 0,
      maxAttempts,
      availableAt: new Date(),
      error: null,
      lockedAt: null,
      lockedBy: null,
    },
    // An accepted/completed operation is immutable. Never reactivate legacy grants.
    update: {},
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

export async function shouldRunOrderLabelAutoFallback(orderId: string, actor?: OrderActor) {
  await requireAuthorizedOrder(actor, orderId, "shipment.create");
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

export async function runOrderLabelAutoFallback(orderId: string, actor?: OrderActor) {
  const shouldRun = await shouldRunOrderLabelAutoFallback(orderId, actor);
  if (!shouldRun) return false;

  await generateAndAttachParcelLabelsForOrder(orderId, actor);

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

export async function scheduleOrderLabelAutoFallback(orderId: string, actor?: OrderActor, delayMs?: number) {
  await requireAuthorizedOrder(actor, orderId, "shipment.create");
  if (!isOrderLabelAutoFallbackEnabled()) return;

  const waitMs = Math.max(1000, delayMs ?? resolveFallbackDelayMs());
  const timer = setTimeout(() => {
    void runOrderLabelAutoFallback(orderId, actor).catch((error) => {
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
      capability: "label.generate",
      acceptedAt: { not: null },
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

async function markJobCompleted(job: LabelJobLike, workerId: string) {
  const completed = await prisma.orderLabelJob.updateMany({
    where: { id: job.id, status: "processing", lockedBy: workerId, attempts: job.attempts },
    data: {
      status: OrderLabelJobStatus.completed,
      error: null,
      lockedAt: null,
      lockedBy: null,
      availableAt: new Date(),
    },
  });
  if (completed.count !== 1) throw orderError("Label lease changed during execution", 403);
}

async function markJobFailure(job: LabelJobLike, workerId: string, error: unknown, authorizedOrderId?: string) {
  const exhausted = job.attempts >= job.maxAttempts;
  const nextStatus = exhausted ? OrderLabelJobStatus.failed : OrderLabelJobStatus.pending;
  const retryAt = new Date(Date.now() + buildRetryDelayMs(job.attempts));
  const denied = (error as { statusCode?: number })?.statusCode === 403;
  const errorMessage = denied ? "Durable label authority denied" : "Label execution failed";

  const updated = await prisma.orderLabelJob.updateMany({
    where: { id: job.id, status: "processing", lockedBy: workerId, attempts: job.attempts },
    data: {
      status: nextStatus,
      error: errorMessage,
      lockedAt: null,
      lockedBy: null,
      availableAt: exhausted ? new Date() : retryAt,
    },
  });

  if (updated.count === 1 && exhausted && !denied && authorizedOrderId) {
    void createLabelFailureSupportTicket({
      orderId: authorizedOrderId,
      jobId: job.id,
      reason: errorMessage,
      exhausted: true,
    }).catch(() => undefined);
  }

  return exhausted;
}

export async function runOrderLabelQueueTick(
  args: RunQueueTickArgs,
): Promise<LabelQueueTickResult> {
  if (!args.workerId) throw orderError("Worker lease identity required", 403);
  const batchSize = Math.min(50, parsePositiveInt(
    args.batchSize ? String(args.batchSize) : process.env.ORDER_LABEL_WORKER_BATCH_SIZE, 10));
  const jobs = await claimOrderLabelJobs(args.workerId, batchSize);
  const result = { claimed: jobs.length, completed: 0, retried: 0, failed: 0 };
  for (const claim of jobs) {
    let authorizedOrderId: string | undefined;
    try {
      // Only the row ID and lease attempt locate work; candidate/queue ownership is ignored.
      const job = await prisma.orderLabelJob.findUnique({ where: { id: claim.id } });
      if (!job || job.status !== "processing" || job.lockedBy !== args.workerId ||
          job.attempts !== claim.attempts || job.capability !== "label.generate" ||
          !job.acceptedAt || !job.ownershipTenantId || !job.ownershipCompanyId) {
        throw orderError("Accepted label grant and current lease required", 403);
      }
      await requireActiveOrderOwnership(prisma, job.orderId, job.ownershipTenantId, job.ownershipCompanyId);
      authorizedOrderId = job.orderId;
      const order = await loadLabelContent(job.orderId, job.ownershipTenantId);
      if (order.ownerOrgId !== job.ownershipCompanyId) throw orderError("Label owner changed", 403);
      await attachLabels(order);
      await markJobCompleted(claim, args.workerId);
      result.completed++;
    } catch (error) {
      const exhausted = await markJobFailure(claim, args.workerId, error, authorizedOrderId);
      if (exhausted) result.failed++; else result.retried++;
    }
  }
  return result;
}
