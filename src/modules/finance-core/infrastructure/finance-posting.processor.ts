import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { FinanceService } from "../application/finance.service";
import { prismaFinanceRepository } from "./prisma-finance.repository";

const service = new FinanceService(prismaFinanceRepository);
const BATCH_SIZE = Math.max(1, Number(process.env.FINANCE_POSTING_BATCH_SIZE || 50));
const CLAIM_STALE_MS = Math.max(
  30_000,
  Number(process.env.FINANCE_POSTING_CLAIM_STALE_MS || 300_000),
);
const CONSUMER_ID =
  process.env.FINANCE_POSTING_CONSUMER_ID || `${process.env.HOSTNAME || "finance-posting"}-${process.pid}`;

type ClaimedSourceEvent = { id: string };

async function claimBatch(batchSize: number, consumerId: string) {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  return prisma.$queryRaw<ClaimedSourceEvent[]>(Prisma.sql`
    UPDATE "FinanceSourceEvent" AS event
    SET status = 'processing'::"FinanceSourceEventStatus",
        "claimedAt" = NOW(), "claimedBy" = ${consumerId}, "updatedAt" = NOW()
    WHERE event.id IN (
      SELECT candidate.id
      FROM "FinanceSourceEvent" AS candidate
      WHERE candidate."nextAttemptAt" <= NOW()
        AND (
          candidate.status = 'pending'::"FinanceSourceEventStatus"
          OR (
            candidate.status = 'processing'::"FinanceSourceEventStatus"
            AND candidate."claimedAt" < ${staleBefore}
          )
        )
      ORDER BY candidate."createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    RETURNING event.id
  `);
}

export async function processFinancePostingBatchOnce(options?: {
  batchSize?: number;
  consumerId?: string;
}) {
  const consumerId = options?.consumerId ?? CONSUMER_ID;
  const rows = await claimBatch(options?.batchSize ?? BATCH_SIZE, consumerId);
  let posted = 0;
  let exceptions = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await service.processSourceEvent(row.id) as { exception?: boolean };
      if (result.exception) exceptions += 1;
      else posted += 1;
    } catch (error: any) {
      failed += 1;
      await prisma.financeSourceEvent.updateMany({
        where: { id: row.id, status: "processing", claimedBy: consumerId },
        data: {
          status: "pending",
          claimedAt: null,
          claimedBy: null,
          nextAttemptAt: new Date(Date.now() + 5000),
          lastErrorCode: "FINANCE_POSTING_TRANSIENT_ERROR",
          lastErrorMessage: String(error?.message || error).slice(0, 1000),
        },
      }).catch(() => undefined);
    }
  }
  return { claimed: rows.length, posted, exceptions, failed };
}

export function financePostingConsumerId() {
  return CONSUMER_ID;
}
