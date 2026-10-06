import { Prisma } from "@prisma/client";
import { billingError } from "./billing-policy";
type Tx = Prisma.TransactionClient;

/** New cash authority cannot reopen an elapsed collection window. Order is locked by callers. */
export function assertServiceObligationWindow(party: string, status: string) {
  const beforePickup = ["pending", "assigned", "pickup_in_progress"];
  const allowed = party === "SENDER" ? beforePickup : party === "RECIPIENT"
    ? [...beforePickup, "picked_up", "at_warehouse", "in_transit", "out_for_delivery"] : [];
  if (!allowed.includes(status)) throw billingError("CASH_COLLECTION_WINDOW_CLOSED");
}

export async function serviceInstruction(tx: Tx, orderId: string): Promise<any | null> {
  return (await tx.$queryRaw<any[]>`SELECT * FROM "OrderServicePaymentInstruction" WHERE "orderId"=${orderId}::uuid`)[0] ?? null;
}
export async function currentServiceObligation(tx: Tx, orderId: string): Promise<any | null> {
  return (await tx.$queryRaw<any[]>`SELECT b.*, b.amount::text AS amount, i."collectionParty"
    FROM "Order" o JOIN "OrderServiceCashObligation" b ON b."priceApprovalId"=o."currentPriceApprovalId"
    AND b."orderId"=o.id AND b."tenantId"=o."tenantId" AND b."companyId"=o."ownerOrgId"
    JOIN "OrderServicePaymentInstruction" i ON i.id=b."instructionId"
    WHERE o.id=${orderId}::uuid`)[0] ?? null;
}
/** Any reservation/attempt, including failed or uncertain, freezes this bounded cash path. */
export async function assertServiceBasisUntouched(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<any[]>`SELECT
    EXISTS(SELECT 1 FROM "PaymentIntent" WHERE "orderId"=${orderId}::uuid) AS payment,
    EXISTS(SELECT 1 FROM "Invoice" WHERE "orderId"=${orderId}::uuid) AS invoice,
    EXISTS(SELECT 1 FROM "CashCollection" c WHERE c."orderId"=${orderId}::uuid AND
      (c.status<>'expected' OR c."collectedAmount" IS NOT NULL OR c."currentHolderType"<>'none'
       OR EXISTS(SELECT 1 FROM "CashCollectionEvent" e WHERE e."cashCollectionId"=c.id AND e."eventType"<>'expected'))) AS cash,
    EXISTS(SELECT 1 FROM "RestrictedCashState" WHERE "orderId"=${orderId}::uuid) AS exact`;
  const o=await tx.order.findUnique({where:{id:orderId},select:{paymentState:true,serviceChargePaidStatus:true}});
  if (!o || rows[0].payment || rows[0].invoice || rows[0].cash || rows[0].exact ||
    o.paymentState!=="UNPAID" || o.serviceChargePaidStatus!=="NOT_PAID") throw billingError("CASH_BASIS_FROZEN");
}
/** Invoked only within accepted-price transaction after actor/reference/order fencing. */
export async function publishServiceObligation(tx: Tx, approval: any, order: any) {
  const i=await serviceInstruction(tx,order.id);
  if(!i)return; // No inferred cash authority from creation defaults.
  if(i.tenantId!==approval.tenantId || i.companyId!==approval.companyId || i.legalEntityId!==approval.legalEntityId ||
    i.billToId!==approval.billToId || i.payerCustomerEntityId!==approval.payerCustomerEntityId || order.paymentType!=="CASH")
    throw billingError("CASH_INSTRUCTION_SOURCE_CONFLICT");
  await assertServiceBasisUntouched(tx,order.id);
  const entity=await tx.financeLegalEntity.findUnique({where:{id:approval.legalEntityId}});
  const amount=new Prisma.Decimal(approval.total);
  if(!entity?.isActive || entity.baseCurrency!==approval.currency || !amount.isFinite() || amount.isNegative())throw billingError("CASH_CURRENCY_BASIS_REQUIRED");
  if(amount.gt(0))assertServiceObligationWindow(i.collectionParty,order.status);
  // Old Float fields are mirrors only; reject values the compatibility schema cannot preserve.
  if(!new Prisma.Decimal(String(amount.toNumber())).eq(amount))throw billingError("CASH_MIRROR_PRECISION_UNSUPPORTED");
  const previous=await currentServiceObligation(tx,order.id);
  let collection=await tx.cashCollection.findUnique({where:{orderId_kind:{orderId:order.id,kind:"service_charge"}}});
  if(collection && (!previous || previous.collectionId!==collection.id))throw billingError("CASH_LEGACY_RECONCILIATION_REQUIRED");
  if(amount.gt(0)) {
    collection=collection?await tx.cashCollection.update({where:{id:collection.id},data:{expectedAmount:amount.toNumber(),currency:approval.currency}}):
      await tx.cashCollection.create({data:{orderId:order.id,kind:"service_charge",expectedAmount:amount.toNumber(),currency:approval.currency}});
  } else if(collection) {
    await tx.cashCollection.update({where:{id:collection.id},data:{expectedAmount:0,currency:approval.currency}});
  }
  if(collection)await tx.cashCollectionEvent.create({data:{cashCollectionId:collection.id,eventType:"expected",amount:amount.toNumber(),actorId:approval.actorUserId,note:"Accepted exact service obligation"}});
  await tx.$executeRaw`INSERT INTO "OrderServiceCashObligation"
    ("priceApprovalId","tenantId","companyId","legalEntityId","orderId","instructionId","billToId","payerCustomerEntityId","policyVersionId",amount,currency,"collectionId","previousApprovalId")
    VALUES (${approval.snapshotId}::uuid,${approval.tenantId}::uuid,${approval.companyId}::uuid,${approval.legalEntityId}::uuid,${order.id}::uuid,
    ${i.id}::uuid,${approval.billToId}::uuid,${approval.payerCustomerEntityId}::uuid,${approval.policyVersionId}::uuid,${amount.toString()}::numeric,${approval.currency},${collection?.id??null}::uuid,${previous?.priceApprovalId??null}::uuid)`;
  await tx.order.update({where:{id:order.id},data:{serviceCharge:amount.toNumber(),deliveryChargePaidBy:i.collectionParty}});
  await tx.financeAuditEvent.create({data:{legalEntityId:approval.legalEntityId,actorUserId:approval.actorUserId,action:"cash.service.obligation.accepted",
    detailsJson:{orderId:order.id,priceApprovalId:approval.snapshotId,instructionId:i.id,amount:amount.toFixed(4),currency:approval.currency}}});
}

/** Parent order is already authorized and locked by the transition caller. */
export async function assertExactServiceTransition(tx: Tx, orderId: string, stage: "pickup"|"delivery") {
  const i=await serviceInstruction(tx,orderId);
  if(!i || i.collectionParty!==(stage==="pickup"?"SENDER":"RECIPIENT"))return;
  const b=await currentServiceObligation(tx,orderId);
  if(!b || b.instructionId!==i.id)throw billingError("CASH_SERVICE_OBLIGATION_REQUIRED");
  if(new Prisma.Decimal(b.amount).isZero())return;
  const state=(await tx.$queryRaw<any[]>`SELECT s."priceApprovalId",s.amount::text,s.currency FROM "RestrictedCashState" s
    WHERE s."collectionId"=${b.collectionId}::uuid AND s."tenantId"=${b.tenantId}::uuid AND s."companyId"=${b.companyId}::uuid
      AND s."legalEntityId"=${b.legalEntityId}::uuid AND s."orderId"=${orderId}::uuid AND s.kind='service_charge'`)[0];
  if(!state || state.priceApprovalId!==b.priceApprovalId || !new Prisma.Decimal(state.amount).eq(b.amount) || state.currency!==b.currency)
    throw billingError("CASH_SERVICE_COLLECTION_REQUIRED");
}

export function assertServiceCollectionTiming(party:string,status:string,profile:string) {
  const allowed=party==="SENDER"?["assigned","pickup_in_progress"]:party==="RECIPIENT"?
    (profile==="warehouse-cash.v1"?["at_warehouse"]:["out_for_delivery"]):[];
  if(!allowed.includes(status))throw billingError("CASH_COLLECTION_TIMING_REQUIRED");
}
