import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type {
  EnqueueIntegrationCanonicalEventInput,
  IntegrationCanonicalEventRecord,
  IntegrationCanonicalEventRepository,
} from "../application/canonical-event.types";

const db = prisma as any;

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function toDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function mapCanonicalEvent(row: any): IntegrationCanonicalEventRecord {
  return {
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
    payloadJson: toObject(row.payloadJson),
    occurredAt: toIso(row.occurredAt) || new Date().toISOString(),
    processAttempts: Number(row.processAttempts ?? 0),
    lastError: row.lastError ?? null,
    createdAt: toIso(row.createdAt) || new Date().toISOString(),
    updatedAt: toIso(row.updatedAt) || new Date().toISOString(),
  };
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export const integrationCanonicalEventRepository: IntegrationCanonicalEventRepository = {
  async enqueue(input: EnqueueIntegrationCanonicalEventInput) {
    try {
      const row = await db.integrationCanonicalEvent.create({
        data: {
          source: input.source,
          status: "pending",
          companyId: input.companyId ?? null,
          providerId: input.providerId ?? null,
          webhookEventId: input.webhookEventId ?? null,
          outboxId: input.outboxId ?? null,
          domain: input.domain,
          providerCode: input.providerCode,
          eventType: input.eventType,
          aggregateType: input.aggregateType ?? null,
          aggregateId: input.aggregateId ?? null,
          payloadJson: input.payloadJson as any,
          occurredAt: toDate(input.occurredAt),
        },
      });
      return mapCanonicalEvent(row);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;

      const existing = await db.integrationCanonicalEvent.findFirst({
        where: {
          OR: [
            ...(input.outboxId ? [{ outboxId: input.outboxId }] : []),
            ...(input.webhookEventId ? [{ webhookEventId: input.webhookEventId }] : []),
            {
              source: input.source,
              providerCode: input.providerCode,
              eventType: input.eventType,
              aggregateType: input.aggregateType ?? null,
              aggregateId: input.aggregateId ?? null,
              occurredAt: toDate(input.occurredAt),
            },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
      if (!existing) throw error;
      return mapCanonicalEvent(existing);
    }
  },

  async claimBatch(args) {
    const limit = Math.max(1, Math.min(Number(args.limit || 25), 200));
    const staleProcessingBefore = args.staleProcessingBeforeIso
      ? toDate(args.staleProcessingBeforeIso)
      : null;

    return db.$transaction(async (tx: any) => {
      const candidates = await tx.integrationCanonicalEvent.findMany({
        where: {
          OR: [
            { status: "pending" },
            ...(staleProcessingBefore
              ? [{ status: "processing", lockedAt: { lte: staleProcessingBefore } }]
              : []),
          ],
        },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
        take: limit,
      });

      const claimedIds: string[] = [];
      for (const row of candidates) {
        const claimWhere =
          row.status === "processing"
            ? {
                id: row.id,
                status: "processing",
                ...(staleProcessingBefore ? { lockedAt: { lte: staleProcessingBefore } } : {}),
              }
            : { id: row.id, status: "pending" };
        const updated = await tx.integrationCanonicalEvent.updateMany({
          where: claimWhere,
          data: {
            status: "processing",
            lockedAt: new Date(),
            processAttempts: { increment: 1 },
          },
        });
        if (updated.count > 0) claimedIds.push(row.id);
      }

      if (!claimedIds.length) return [];
      const rows = await tx.integrationCanonicalEvent.findMany({
        where: { id: { in: claimedIds } },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      });
      return rows.map(mapCanonicalEvent);
    });
  },

  async markProcessed(id) {
    await db.integrationCanonicalEvent.update({
      where: { id },
      data: {
        status: "processed",
        lockedAt: null,
        processedAt: new Date(),
        lastError: null,
      },
    });
  },

  async markIgnored(id, message) {
    await db.integrationCanonicalEvent.update({
      where: { id },
      data: {
        status: "ignored",
        lockedAt: null,
        processedAt: new Date(),
        lastError: message ? message.slice(0, 1000) : null,
      },
    });
  },

  async markFailed(id, message) {
    await db.integrationCanonicalEvent.update({
      where: { id },
      data: {
        status: "failed",
        lockedAt: null,
        lastError: String(message || "canonical event processing failed").slice(0, 1000),
      },
    });
  },
};
