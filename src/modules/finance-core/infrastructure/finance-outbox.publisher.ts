import { randomUUID } from "crypto";
import prisma from "../../../config/prismaClient";
import { logFinanceOutboxFailure } from "./finance-outbox-diagnostics";
import { getRedisClient, getRedisPrefix, withRedisTimeout } from "../../../config/redis";
import { financePublicationHash, rejectFinancePublication, resolveFinancePublication } from "./finance-outbox-authority";

const STREAM_KEY = `${getRedisPrefix()}:cp:finance:events`;
const LEASE_SECONDS = 30, MAX_ATTEMPTS = 8;
const IDLE_MS = 1000, REDIS_TIMEOUT_MS = 2500;
export type FinancePublicationClaim = { id: string; claimToken: string };
export type FinancePublicationEnvelope = { id: string; type: string; occurredAt: string; tenantScope: string; legalEntityId: string;
  aggregateType: string; aggregateId: string; schemaVersion: number; payload: { outboxId: string; sourceId: string } };

export async function claimFinanceOutboxBatch(size = 1): Promise<FinancePublicationClaim[]> {
  if (!Number.isInteger(size) || size < 1 || size > 10) throw new Error("Bounded finance claim size required");
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
    // Bounded housekeeping skips competing locks; expiry after dispatch is never a retry.
    await tx.$executeRaw`UPDATE "FinanceDomainEventOutbox" e SET "publicationState"='reconciliation_required',
      "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"lastError"='FINANCE_DISPATCH_UNCERTAIN',"updatedAt"=NOW()
      WHERE e.id IN (SELECT id FROM "FinanceDomainEventOutbox" WHERE "publicationState"='dispatching' AND "leaseExpiresAt"<=NOW()
        ORDER BY "leaseExpiresAt",id FOR UPDATE SKIP LOCKED LIMIT 10)`;
    await tx.$executeRaw`UPDATE "FinanceDomainEventOutbox" e SET "publicationState"='exhausted',
      "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"lastError"='FINANCE_ATTEMPTS_EXHAUSTED',"updatedAt"=NOW()
      WHERE e.id IN (SELECT id FROM "FinanceDomainEventOutbox" WHERE attempts>=${MAX_ATTEMPTS}
        AND ("publicationState"='ready' OR ("publicationState"='claimed' AND "leaseExpiresAt"<=NOW()))
        ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 10)`;
    const token = randomUUID();
    return tx.$queryRaw<FinancePublicationClaim[]>`UPDATE "FinanceDomainEventOutbox" e SET "publicationState"='claimed',
      "claimToken"=${token}::uuid,"claimedAt"=NOW(),"leaseExpiresAt"=NOW()+make_interval(secs=>${LEASE_SECONDS}),attempts=attempts+1,"updatedAt"=NOW()
      WHERE e.id IN (SELECT id FROM "FinanceDomainEventOutbox" WHERE "acceptedAt" IS NOT NULL AND "publishedAt" IS NULL
        AND attempts<${MAX_ATTEMPTS} AND "nextAttemptAt"<=NOW()
        AND ("publicationState"='ready' OR ("publicationState"='claimed' AND "leaseExpiresAt"<=NOW()))
        ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${size}) RETURNING e.id,e."claimToken"`;
  }, { maxWait: 2000, timeout: 10000 });
}

export async function prepareFinanceDispatch(claim: FinancePublicationClaim): Promise<FinancePublicationEnvelope|null> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
    const locked = await tx.$queryRaw<Array<{id: string}>>`SELECT id FROM "FinanceDomainEventOutbox" WHERE id=${claim.id}::uuid
      AND "claimToken"=${claim.claimToken}::uuid AND "publicationState"='claimed' AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`;
    if (locked.length !== 1) return null;
    const row = await tx.financeDomainEventOutbox.findUniqueOrThrow({ where: { id: claim.id } });
    try {
      if (!row.acceptedAt || !row.tenantId || !row.companyId || row.schemaVersion !== 1 || row.contentHash !== financePublicationHash(row)) rejectFinancePublication();
      const owner = await resolveFinancePublication(tx, row, true);
      if (owner.tenantId !== row.tenantId || owner.companyId !== row.companyId || owner.capability !== row.capability
        || owner.accountId !== row.accountId || owner.installationId !== row.installationId || owner.journalId !== row.journalId) rejectFinancePublication();
    } catch (error: any) {
      // Authority/source denials quarantine. Database/lock errors roll back for safe pre-dispatch retry.
      if (!["FINANCE_OUTBOX_SOURCE_REJECTED", "FINANCE_CHART_TEMPLATE_SOURCE_REJECTED", "FINANCE_JOURNAL_OWNERSHIP_REJECTED"].includes(error?.code)) throw error;
      await tx.financeDomainEventOutbox.update({ where: { id: row.id }, data: { publicationState: "quarantined", claimToken: null,
        claimedAt: null, leaseExpiresAt: null, lastError: "FINANCE_SOURCE_REJECTED" } });
      return null;
    }
    const marked = await tx.$executeRaw`UPDATE "FinanceDomainEventOutbox" SET "publicationState"='dispatching',"dispatchStartedAt"=NOW(),"updatedAt"=NOW()
      WHERE id=${claim.id}::uuid AND "claimToken"=${claim.claimToken}::uuid AND "publicationState"='claimed' AND "leaseExpiresAt">clock_timestamp()`;
    if (marked !== 1) return null;
    return { id: row.eventId, type: row.eventType, occurredAt: row.occurredAt.toISOString(), schemaVersion: 1,
      tenantScope: `tenant:${row.tenantId}:company:${row.companyId}`, legalEntityId: row.legalEntityId,
      aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: { outboxId: row.id, sourceId: row.aggregateId } };
  }, { maxWait: 2000, timeout: 10000 });
}
export async function completeFinanceDispatch(claim: FinancePublicationClaim): Promise<boolean> {
  const count = await prisma.$executeRaw`UPDATE "FinanceDomainEventOutbox" SET "publicationState"='published',"publishedAt"=NOW(),
    "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"lastError"=NULL,"updatedAt"=NOW()
    WHERE id=${claim.id}::uuid AND "claimToken"=${claim.claimToken}::uuid AND "publicationState"='dispatching' AND "leaseExpiresAt">clock_timestamp()`;
  return count === 1;
}
export async function failFinanceClaim(claim: FinancePublicationClaim): Promise<void> {
  await prisma.$executeRaw`UPDATE "FinanceDomainEventOutbox" SET "publicationState"=CASE WHEN "publicationState"='dispatching' THEN 'reconciliation_required'
    WHEN attempts>=${MAX_ATTEMPTS} THEN 'exhausted' ELSE 'ready' END,
    "lastError"=CASE WHEN "publicationState"='dispatching' THEN 'FINANCE_DISPATCH_UNCERTAIN' ELSE 'FINANCE_PRE_DISPATCH_FAILED' END,
    "nextAttemptAt"=NOW()+make_interval(secs=>LEAST(300,POWER(2,LEAST(attempts-1,8)))::int),
    "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=NOW()
    WHERE id=${claim.id}::uuid AND "claimToken"=${claim.claimToken}::uuid AND "publicationState" IN ('claimed','dispatching')`;
}
async function append(event: FinancePublicationEnvelope) {
  const redis = await getRedisClient();
  if (!redis) throw new Error("Finance transport unavailable");
  await redis.xadd(STREAM_KEY, "MAXLEN", "~", "100000", "*", "eventId", event.id, "type", event.type,
    "tenantScope", event.tenantScope, "aggregateType", event.aggregateType, "aggregateId", event.aggregateId,
    "schemaVersion", String(event.schemaVersion), "data", JSON.stringify(event));
}
let active = false;
/** One pending transport per process, including client acquisition. Deadline is not cancellation. */
export async function processFinanceOutboxBatchOnce(options?: { batchSize?: number; consumerId?: string }) {
  // Keep old option shape without treating consumerId as authority. One-at-a-time transport is intentional.
  if (options?.batchSize !== undefined && (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10)) throw new Error("Bounded finance claim size required");
  if (active) return { claimed: 0, published: 0, failed: 0, busy: true };
  active = true;
  let settled = true, finished = false, claimed = 0, published = 0, failed = 0;
  try {
    const claims = await claimFinanceOutboxBatch(); claimed = claims.length;
    for (const claim of claims) {
      try {
        const event = await prepareFinanceDispatch(claim);
        if (!event) { failed++; continue; }
        settled = false;
        const pending = Promise.resolve().then(() => append(event));
        void pending.then(() => { settled = true; if (finished) active = false; }, () => { settled = true; if (finished) active = false; });
        await withRedisTimeout("finance:outbox:xadd", () => pending, REDIS_TIMEOUT_MS);
        if (await completeFinanceDispatch(claim)) published++;
        else { await failFinanceClaim(claim); failed++; }
      } catch { await failFinanceClaim(claim); failed++; }
    }
    return { claimed, published, failed, busy: false };
  } finally { finished = true; if (settled) active = false; }
}
export async function startFinanceOutboxPublisher(options?: { signal?: AbortSignal }) {
  while (!options?.signal?.aborted) {
    try { await processFinanceOutboxBatchOnce(); } catch { logFinanceOutboxFailure("loop"); }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); options?.signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, IDLE_MS); options?.signal?.addEventListener("abort", done, { once: true });
      if (options?.signal?.aborted) done();
    });
  }
}
export function getFinanceEventsStreamKey() { return STREAM_KEY; }
