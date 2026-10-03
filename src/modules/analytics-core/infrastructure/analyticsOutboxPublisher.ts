import { randomUUID } from "crypto";
import prisma from "../../../config/prismaClient";
import { withRedisTimeout } from "../../../config/redis";
import { analyticsConfig } from "../config/analyticsConfig";
import { analyticsLogger } from "../config/analyticsLogger";
import { appendCargoPilotDomainEvent, type CargoPilotDomainEvent } from "../realtime/analyticsEvents";
import { analyticsAcceptanceHash, resolveAnalyticsSource } from "./analyticsOutbox";
import { loadAcceptedCashFinance } from "../../finance-core/infrastructure/cash-finance-authority";
const LEASE_SECONDS=30, MAX_ATTEMPTS=8;
type Claim={id:string;claimToken:string};
/** Row authority is PostgreSQL; a process name or Redis leader never authorizes a claim. */
export async function claimAnalyticsOutboxBatch(size=1):Promise<Claim[]> {
  if(!Number.isInteger(size)||size<1||size>10)throw new Error("Bounded analytics claim size required");
  return prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
    await tx.$executeRaw`UPDATE "AnalyticsDomainEventOutbox" SET "publicationState"='reconciliation_required',
      "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"lastError"='ANALYTICS_DISPATCH_UNCERTAIN',"updatedAt"=NOW()
      WHERE "publicationState"='dispatching' AND "leaseExpiresAt"<=NOW()`;
    await tx.$executeRaw`UPDATE "AnalyticsDomainEventOutbox" SET "publicationState"='exhausted',
      "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"lastError"='ANALYTICS_ATTEMPTS_EXHAUSTED',"updatedAt"=NOW()
      WHERE attempts>=${MAX_ATTEMPTS} AND ("publicationState"='ready' OR ("publicationState"='claimed' AND "leaseExpiresAt"<=NOW()))`;
    const token=randomUUID();
    return tx.$queryRaw<Claim[]>`UPDATE "AnalyticsDomainEventOutbox" e SET "publicationState"='claimed',"claimToken"=${token}::uuid,
      "claimedAt"=NOW(),"leaseExpiresAt"=NOW()+make_interval(secs=>${LEASE_SECONDS}),attempts=attempts+1,"updatedAt"=NOW()
      WHERE e.id IN (SELECT id FROM "AnalyticsDomainEventOutbox" WHERE "acceptedAt" IS NOT NULL AND "publishedAt" IS NULL
        AND attempts<${MAX_ATTEMPTS} AND "nextAttemptAt"<=NOW()
        AND ("publicationState"='ready' OR ("publicationState"='claimed' AND "leaseExpiresAt"<=NOW()))
        ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${size}) RETURNING e.id,e."claimToken"`;
  },{maxWait:2000,timeout:10000});
}
/** Every phase is fenced; a guessed/expired queue claim never grants an operation. */
export async function prepareAnalyticsDispatch(claim:Claim):Promise<CargoPilotDomainEvent|null> {
  return prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
    const rows=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "AnalyticsDomainEventOutbox" WHERE id=${claim.id}::uuid
      AND "claimToken"=${claim.claimToken}::uuid AND "publicationState"='claimed' AND "leaseExpiresAt">NOW() FOR UPDATE`;
    if(rows.length!==1)return null;
    const row=await tx.analyticsDomainEventOutbox.findUniqueOrThrow({where:{id:claim.id}});
    try {
      if(!row.acceptedAt||!row.tenantId||!row.companyId||row.eventId.length>200||Buffer.byteLength(JSON.stringify(row.payload))>65536||row.contentHash!==analyticsAcceptanceHash(row))throw new Error("Binding");
      const owner=await resolveAnalyticsSource(tx,{id:row.eventId,type:row.type as any,tenantScope:row.tenantScope,entityId:row.entityId,
        payload:row.payload as any,occurredAt:row.occurredAt.toISOString(),...(row.capability==="support_configuration"?{companySubjectId:row.companyId}:{})});
      if(owner.tenantId!==row.tenantId||owner.companyId!==row.companyId||owner.orderId!==row.orderId||owner.ticketId!==row.ticketId||owner.capability!==row.capability)throw new Error("Binding");
      if(row.capability==="cash_finance_source")await loadAcceptedCashFinance(tx,String((row.payload as any).sourceEventId));
    } catch(error:any) {
      // Known authority denial only. Database/lock failures roll back and remain safely pre-dispatch retryable.
      if(error?.statusCode!==409&&error?.code!=="FINANCE_CASH_AUTHORITY_REJECTED"&&error?.message!=="Binding")throw error;
      await tx.analyticsDomainEventOutbox.update({where:{id:row.id},data:{publicationState:"quarantined",claimToken:null,claimedAt:null,leaseExpiresAt:null,lastError:"ANALYTICS_SOURCE_REJECTED"}});return null;
    }
    const started=await tx.$executeRaw`UPDATE "AnalyticsDomainEventOutbox" SET "publicationState"='dispatching',"dispatchStartedAt"=NOW(),"updatedAt"=NOW()
      WHERE id=${claim.id}::uuid AND "claimToken"=${claim.claimToken}::uuid AND "publicationState"='claimed' AND "leaseExpiresAt">NOW()`;
    if(started!==1)return null;
    return {id:row.eventId,type:row.type as any,entityId:row.entityId,occurredAt:row.occurredAt.toISOString(),schemaVersion:1,
      tenantScope:`tenant:${row.tenantId}:company:${row.companyId}`,
      payload:row.capability==="cash_finance_source"?{sourceEventId:(row.payload as any).sourceEventId}:{}};
  },{maxWait:2000,timeout:10000});
}
export async function completeAnalyticsDispatch(claim:Claim):Promise<boolean> {
  const count=await prisma.$executeRaw`UPDATE "AnalyticsDomainEventOutbox" SET "publicationState"='published',"publishedAt"=NOW(),
    "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"lastError"=NULL,"updatedAt"=NOW()
    WHERE id=${claim.id}::uuid AND "claimToken"=${claim.claimToken}::uuid AND "publicationState"='dispatching' AND "leaseExpiresAt">NOW()`;
  return count===1;
}
async function failClaim(claim:Claim) {
  await prisma.$executeRaw`UPDATE "AnalyticsDomainEventOutbox" SET "publicationState"=CASE WHEN "publicationState"='dispatching' THEN 'reconciliation_required'
    WHEN attempts>=${MAX_ATTEMPTS} THEN 'exhausted' ELSE 'ready' END,
    "lastError"=CASE WHEN "publicationState"='dispatching' THEN 'ANALYTICS_DISPATCH_UNCERTAIN' ELSE 'ANALYTICS_PRE_DISPATCH_FAILED' END,
    "nextAttemptAt"=NOW()+make_interval(secs=>LEAST(300,POWER(2,LEAST(attempts-1,8)))::int),
    "claimToken"=NULL,"claimedAt"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=NOW()
    WHERE id=${claim.id}::uuid AND "claimToken"=${claim.claimToken}::uuid AND "publicationState" IN ('claimed','dispatching')`;
}
let active=false;
/** One underlying command per process. Timeout does not release admission until actual settlement. */
export async function processAnalyticsOutboxBatchOnce() {
  if(active)return {claimed:0,published:0,contained:0,busy:true};active=true;
  let underlying:Promise<void>|undefined,settled=true,finished=false;let claimed=0,published=0,contained=0;
  try {
    const rows=await claimAnalyticsOutboxBatch();claimed=rows.length;
    for(const claim of rows) {
      try {
        const event=await prepareAnalyticsDispatch(claim);if(!event){contained++;continue;}
        settled=false;underlying=Promise.resolve().then(()=>appendCargoPilotDomainEvent(event));
        void underlying.then(()=>{settled=true;if(finished)active=false;},()=>{settled=true;if(finished)active=false;});
        await withRedisTimeout("analytics:outbox:append",()=>underlying!,5000);
        if(await completeAnalyticsDispatch(claim))published++;else{await failClaim(claim);contained++;}
      } catch {await failClaim(claim);contained++;}
    }
    return {claimed,published,contained,busy:false};
  } finally {finished=true;if(settled)active=false;}
}
export async function startAnalyticsOutboxPublisher(options?:{signal?:AbortSignal}) {
  if(!analyticsConfig.outbox.enabled)return;
  while(!options?.signal?.aborted) {
    try {await processAnalyticsOutboxBatchOnce();}
    catch(error){analyticsLogger.throttledError("analytics-outbox-loop","Analytics outbox iteration failed",{error,throttleMs:30000});}
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);options?.signal?.removeEventListener("abort",done);resolve();};const timer=setTimeout(done,analyticsConfig.outbox.idleMs);options?.signal?.addEventListener("abort",done,{once:true});if(options?.signal?.aborted)done();});
  }
}
