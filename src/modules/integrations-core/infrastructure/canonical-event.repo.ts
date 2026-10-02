import { deriveCanonicalSource } from "../application/canonical-source";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { isDeepStrictEqual } from "util";
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
    const options = { maxWait: 2000, timeout: 5000 };
    const derive = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
      return deriveCanonicalSource(tx, input);
    };
    try {
      const row = await prisma.$transaction(async tx => {
        const data = await derive(tx);
        return tx.integrationCanonicalEvent.create({ data: { ...data, status: "pending" } });
      }, options);
      return mapCanonicalEvent(row);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      // A source uniqueness collision is not permission to return another source,
      // tenant or provider's receipt. Revalidate the persisted source on every retry.
      return prisma.$transaction(async tx => {
        const data = await derive(tx);
        const existing = await tx.integrationCanonicalEvent.findFirst({ where: {
          source: data.source, companyId: data.companyId, providerId: data.providerId,
          domain: data.domain, providerCode: data.providerCode,
          webhookEventId: data.webhookEventId, outboxId: data.outboxId,
        } });
        if (!existing || existing.eventType !== data.eventType || existing.aggregateType !== data.aggregateType ||
          existing.aggregateId !== data.aggregateId || existing.occurredAt.getTime() !== data.occurredAt.getTime() ||
          !isDeepStrictEqual(existing.payloadJson, data.payloadJson)) {
          throw Object.assign(authorityError("Canonical event identity conflict", 409), { code: "INTEGRATION_CANONICAL_ID_CONFLICT" });
        }
        return mapCanonicalEvent(existing);
      }, options);
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
          companyId: { not: null }, providerId: { not: null },
          provider: { is: { status: "active", company: { is: { isActive: true, type: "company",
            tenantId: { not: null }, tenant: { is: { status: "active" } } } } } },
          AND: [{ OR: [
            { source: "inbound_webhook", webhookEventId: { not: null }, outboxId: null },
            { source: "outbound_response", outboxId: { not: null }, webhookEventId: null },
          ] }],
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

  async markFailed(id, message, processAttempts) {
    await db.integrationCanonicalEvent.updateMany({
      where: { id, status: "processing", ...(processAttempts == null ? {} : { processAttempts }) },
      data: {
        status: "failed",
        lockedAt: null,
        lastError: String(message || "canonical event processing failed").slice(0, 1000),
      },
    });
  },
};
