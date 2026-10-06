import { billingHash } from "../../pricing-core/repo/billing-policy";
import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppUser } from "../../../types/app-user";
import { acceptedCashCapability,cashDenied } from "../../identity-access/application/cash-capability-eligibility";
import { lockCashDriver } from "../../identity-access/application/cash-capability-delegation";
import { lockSelectedIdentityReferences } from "../../identity-access/application/credential-lock";
import { companyMembershipPrimitives } from "../../identity-access/application/company-delegation";
import { loadCustodySource,initialPickupWhere } from "../domain/custody-access";
import { requireAcceptedDriver } from "../../identity-access/application/driver-eligibility";
import { enqueueCargoPilotDomainEventsTx } from "../../analytics-core/infrastructure/analyticsOutbox";
const id=z.string().uuid().transform(v=>v.toLowerCase());
const common={orderId:id,operationId:z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/),kind:z.enum(["cod","service_charge"]),note:z.string().max(500).regex(/^[^\x00-\x1f\x7f]*$/).nullable().optional()};
const schemas={collect:z.object({...common,warehouseId:id.optional()}).strict(),
 offer:z.object({...common,expectedEventId:id,recipientMembershipId:id,recipientWarehouseId:id.nullable()}).strict(),
 accept:z.object({...common,expectedEventId:id,offerId:id}).strict(),
 settle:z.object({...common,expectedEventId:id}).strict()};
type Tx=Prisma.TransactionClient;
type Cap=Awaited<ReturnType<typeof acceptedCashCapability>>;
const ctxActor=(m:any)=>({id:m.userId,membershipId:m.id,companyMembershipId:m.id,tenantId:m.tenantId,companyId:m.companyId,tenantMembershipId:m.tenantMembershipId} as AppUser);
const decimal=(value:unknown)=>new Prisma.Decimal(String(value));
function warehouse(cap:Cap,value:string|null){if(!value||!cap.warehouseIds.includes(value)||!cap.member.scopes.some((s:any)=>s.scopeType==="warehouse"&&s.scopeRefId===value))return cashDenied("CASH_WAREHOUSE_SCOPE_REQUIRED");return value;}
async function pin(tx:Tx,ids:string[],context:{tenantId:string;companyId:string}) {
 const members=await tx.companyMembership.findMany({where:{id:{in:ids},tenantId:context.tenantId,companyId:context.companyId},select:{id:true,userId:true,tenantId:true,companyId:true,tenantMembershipId:true}});
 if(members.length!==new Set(ids).size)return cashDenied();
 for(const membershipId of [...new Set(ids)].sort())await lockCashDriver(tx,membershipId);
 for(const m of [...members].sort((a,b)=>a.userId.localeCompare(b.userId)||a.id.localeCompare(b.id))) {
  if(!m.tenantId||!m.tenantMembershipId||!await lockSelectedIdentityReferences(tx,{userId:m.userId,companyMembershipId:m.id,tenantId:m.tenantId,companyId:m.companyId,tenantMembershipId:m.tenantMembershipId}))return cashDenied();
 }
 return members;
}
async function held(tx:Tx,c:Cap,order:any,kind:string){
 const state=(await tx.$queryRaw<any[]>`SELECT * FROM "RestrictedCashState" WHERE "orderId"=${order.id}::uuid AND kind=${kind} AND "tenantId"=${c.tenantId}::uuid AND "companyId"=${c.companyId}::uuid FOR UPDATE`)[0];
 if(!state||state.legalEntityId!==c.legalEntityId)return cashDenied("CASH_EXACT_OWNERSHIP_UNPROVEN",409);
 const row=await tx.cashCollection.findUnique({where:{id:state.collectionId},include:{events:{orderBy:[{createdAt:"desc"},{id:"desc"}],take:1}}});
 const receipt=await tx.cashCustodyOperation.findUnique({where:{eventId:state.eventId}});
 if(row?.status!=="held"||row.orderId!==order.id||row.kind!==kind||row.currency!==state.currency||row.expectedAmount===null||row.collectedAmount===null||!decimal(row.expectedAmount).eq(state.amount)||!decimal(row.collectedAmount).eq(state.amount)||row.events[0]?.id!==state.eventId||
 !receipt||receipt.orderId!==order.id||receipt.tenantId!==c.tenantId||receipt.companyId!==c.companyId||receipt.companyMembershipId!==state.holderMembershipId||receipt.actorId!==state.holderUserId||receipt.collectionId!==row.id||receipt.currency!==state.currency||!receipt.amount.eq(state.amount)||
 (state.holderWarehouseId?row.currentHolderWarehouseId!==state.holderWarehouseId||row.currentHolderUserId!==null:row.currentHolderUserId!==state.holderUserId||row.currentHolderWarehouseId!==null))return cashDenied("CASH_CUSTODY_INCONSISTENT",409);
 return {state,row};
}
async function sourceCap(tx:Tx,c:Cap,state:any){
 const m=await companyMembershipPrimitives.member(tx,state.holderMembershipId);
 const source=await acceptedCashCapability(tx,ctxActor(m),"cash.handoff");
 if(source.tenantId!==c.tenantId||source.companyId!==c.companyId||source.legalEntityId!==c.legalEntityId||!source.kinds.includes(state.kind)||source.userId!==state.holderUserId)return cashDenied();
 if(state.holderWarehouseId){if(source.profileRevision!=="warehouse-cash.v1")return cashDenied();warehouse(source,state.holderWarehouseId);}
 else if(source.profileRevision!=="local-driver-cash.v1")return cashDenied();
 return source;
}
async function driverTarget(tx:Tx,c:Cap,o:any,target:Cap,originWarehouseId:string){
 const source=await loadCustodySource(tx,{...c.context,membershipId:c.context.companyMembershipId} as any,o.id);
 if(target.profileRevision!=="local-driver-cash.v1"||!source.latest||source.latest.phase!=="last-mile"||o.status!=="out_for_delivery"||o.assignedDriverId!==target.userId||source.latest.driverMembershipId!==target.membershipId||source.latest.driverUserId!==target.userId||source.latest.warehouseId!==originWarehouseId)return cashDenied("CASH_ACCEPTED_LAST_MILE_REQUIRED");
 await requireAcceptedDriver(tx,{tenantId:c.tenantId,companyId:c.companyId},target.membershipId,"local");
}
async function target(tx:Tx,c:Cap,o:any,state:any,recipientId:string,recipientWarehouseId:string|null){
 const m=await companyMembershipPrimitives.member(tx,recipientId),to=await acceptedCashCapability(tx,ctxActor(m),"cash.handoff");
 if(to.userId===c.userId||to.tenantId!==c.tenantId||to.companyId!==c.companyId||to.legalEntityId!==c.legalEntityId||!to.kinds.includes(state.kind))return cashDenied("CASH_RECIPIENT_CONTEXT_REQUIRED");
 if(state.holderWarehouseId){if(recipientWarehouseId!==null)return cashDenied("CASH_TRANSFER_FORM_UNSUPPORTED");warehouse(c,state.holderWarehouseId);await driverTarget(tx,c,o,to,state.holderWarehouseId);}
 else {
  if(c.profileRevision!=="local-driver-cash.v1"||to.profileRevision!=="warehouse-cash.v1"||!recipientWarehouseId||!c.warehouseIds.includes(recipientWarehouseId))return cashDenied("CASH_TRANSFER_FORM_UNSUPPORTED");
  warehouse(to,recipientWarehouseId);
  // Money custody is independent of later parcel assignments/movement. The
  // destination must still have durable owned-order warehouse evidence; a
  // capability warehouse allowlist alone cannot manufacture that relationship.
  const evidence=await tx.orderCustodyAction.findFirst({where:{orderId:o.id,tenantId:c.tenantId,companyId:c.companyId,OR:[
   {phase:"pickup-offered",destinationWarehouseId:recipientWarehouseId},
   {phase:{in:["warehouse","transport-offered","transport","last-mile-offered","last-mile","delivered"]},warehouseId:recipientWarehouseId}
  ]},select:{id:true}});
  if(!evidence)return cashDenied("CASH_AUTHORITATIVE_DESTINATION_REQUIRED");
 }
 return to;
}
async function monetaryBasis(tx:Tx,c:Cap,o:any,kind:string){
 // DOM-06 merchant COD provenance is absent. Never manufacture it from a Float.
 if(kind!=="service_charge")return cashDenied("CASH_MERCHANT_BASIS_UNAVAILABLE",409);
 if(!o.currentPriceApprovalId||["CARD","TRANSFER"].includes(o.paymentType)||!["SENDER","RECIPIENT"].includes(o.deliveryChargePaidBy)||o.serviceChargePaidStatus!=="NOT_PAID")return cashDenied("CASH_ACCEPTED_MONETARY_BASIS_REQUIRED",409);
 const p=await tx.orderPriceApproval.findUnique({where:{snapshotId:o.currentPriceApprovalId},include:{source:true}});
 const payer=p?await tx.orderBillTo.findUnique({where:{id:p.billToId}}):null;
 const entity=await tx.financeLegalEntity.findFirst({where:{id:c.legalEntityId,tenantId:c.tenantId,companyId:c.companyId,isActive:true}});
 if(!p||!payer||!entity||p.tenantId!==c.tenantId||p.companyId!==c.companyId||p.legalEntityId!==c.legalEntityId||p.orderId!==o.id||p.currency!==entity.baseCurrency||p.currency!==o.currency||payer.orderId!==o.id||payer.legalEntityId!==c.legalEntityId||payer.payerCustomerEntityId!==p.payerCustomerEntityId||!p.total.isPositive()||!p.source.total.eq(p.total)||p.source.contentHash!==billingHash(p.source.content))return cashDenied("CASH_ACCEPTED_MONETARY_BASIS_REQUIRED",409);
 // Mirrors can reject inconsistency; they cannot determine or adjust accepted money.
 if(o.serviceCharge===null||!decimal(o.serviceCharge).eq(p.total)||String(p.total.toNumber())!==p.total.toString())return cashDenied("CASH_MIRROR_RECONCILIATION_REQUIRED",409);
 return p;
}
/** Restricted capability path only. No human/global permission bypass and no network work. */
export async function executeRestrictedCash(actor:AppUser,action:keyof typeof schemas,input:unknown){
 const v:any=schemas[action].parse(input),requested=companyMembershipPrimitives.context(actor),permission=action==="collect"?"cash.collect":action==="settle"?"cash.settle":"cash.handoff";
 // Hints discover lock identities only; every field is reloaded after pinning.
 const stateHint=(await prisma.$queryRaw<any[]>`SELECT "holderMembershipId" FROM "RestrictedCashState" WHERE "orderId"=${v.orderId}::uuid AND kind=${v.kind} AND "tenantId"=${requested.tenantId}::uuid AND "companyId"=${requested.companyId}::uuid`)[0];
 const offerHint=action==="accept"?(await prisma.$queryRaw<any[]>`SELECT * FROM "RestrictedCashTransferOffer" WHERE id=${v.offerId}::uuid AND "tenantId"=${requested.tenantId}::uuid AND "companyId"=${requested.companyId}::uuid`)[0]:null;
 const identities=[requested.companyMembershipId,...(stateHint?[stateHint.holderMembershipId]:[]),...(v.recipientMembershipId?[v.recipientMembershipId]:[]),...(offerHint?[offerHint.sourceMembershipId,offerHint.recipientMembershipId]:[])];
 return prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET LOCAL lock_timeout='2000ms'`;await tx.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
  await pin(tx,identities,requested);const cap=await acceptedCashCapability(tx,actor,permission);
  if(!cap.kinds.includes(v.kind))return cashDenied("CASH_KIND_CEILING_REQUIRED");
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"restricted-cash:"+requested.tenantId+":"+requested.companyId+":"+v.operationId},0))::text`;
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${v.orderId}::uuid AND "tenantId"=${requested.tenantId}::uuid AND "ownerOrgId"=${requested.companyId}::uuid FOR UPDATE`;
  const order=await tx.order.findFirst({where:{id:v.orderId,tenantId:cap.tenantId,ownerOrgId:cap.companyId,OR:[{assignedOrgId:null},{assignedOrgId:cap.companyId}]}});
  if(!order)return cashDenied("CASH_ORDER_CONTEXT_REQUIRED");
  const fingerprint=createHash("sha256").update(JSON.stringify({action,context:requested,intent:{...v,note:v.note??null}})).digest("hex");
  const old=(await tx.$queryRaw<any[]>`SELECT * FROM "RestrictedCashReceipt" WHERE "tenantId"=${cap.tenantId}::uuid AND "companyId"=${cap.companyId}::uuid AND "operationId"=${v.operationId}`)[0];
  if(old){if(old.fingerprint!==fingerprint||old.actorMembershipId!==cap.membershipId||old.legalEntityId!==cap.legalEntityId)return cashDenied("CASH_OPERATION_CONFLICT",409);
   const result=old.result;if(result.sourceWarehouseId){if(!cap.warehouseIds.includes(result.sourceWarehouseId))return cashDenied("CASH_RECEIPT_RESOURCE_CEILING_REQUIRED");if(cap.profileRevision==="warehouse-cash.v1")warehouse(cap,result.sourceWarehouseId);}
   if(old.transferOfferId){const prior=(await tx.$queryRaw<any[]>`SELECT * FROM "RestrictedCashTransferOffer" WHERE id=${old.transferOfferId}::uuid AND "tenantId"=${cap.tenantId}::uuid AND "companyId"=${cap.companyId}::uuid`)[0];
    if(!prior||prior.legalEntityId!==cap.legalEntityId)return cashDenied();
    const endpointWarehouse=prior.recipientWarehouseId??prior.sourceWarehouseId;
    if(!cap.warehouseIds.includes(endpointWarehouse))return cashDenied("CASH_RECEIPT_RESOURCE_CEILING_REQUIRED");
    if(cap.profileRevision==="warehouse-cash.v1")warehouse(cap,endpointWarehouse);
   }return result;}
  if(!["assigned","pickup_in_progress","picked_up","at_warehouse","in_transit","out_for_delivery","delivered"].includes(order.status))return cashDenied("CASH_ORDER_STATE_REQUIRED",409);
  let state:any,row:any,amount:Prisma.Decimal,currency:string,priceApprovalId:string,holderMembershipId=cap.membershipId,holderUserId=cap.userId,holderWarehouseId:string|null=null,offer:any=null;
  if(action==="collect"){
   const p=await monetaryBasis(tx,cap,order,v.kind);amount=p.total;currency=p.currency;priceApprovalId=p.snapshotId;
   if(cap.profileRevision==="local-driver-cash.v1"){
    const physical=await loadCustodySource(tx,{...cap.context,membershipId:cap.membershipId} as any,order.id);
    const initial=await tx.order.count({where:{id:order.id,...initialPickupWhere({...cap.context,membershipId:cap.membershipId} as any)}});
    if(!initial&&!(physical.latest?.phase==="last-mile"&&physical.latest.driverMembershipId===cap.membershipId&&physical.latest.driverUserId===cap.userId&&order.assignedDriverId===cap.userId))return cashDenied("CASH_ASSIGNED_COLLECTOR_REQUIRED");
   }else if(cap.profileRevision==="warehouse-cash.v1"){
    holderWarehouseId=warehouse(cap,v.warehouseId??null);if(order.currentWarehouseId!==holderWarehouseId)return cashDenied("CASH_CURRENT_WAREHOUSE_REQUIRED");
   }else return cashDenied();
   await tx.$queryRaw`SELECT id FROM "CashCollection" WHERE "orderId"=${order.id}::uuid AND kind::text=${v.kind} FOR UPDATE`;
   row=await tx.cashCollection.findUnique({where:{orderId_kind:{orderId:order.id,kind:v.kind}}});
   if(!row||row.status!=="expected"||row.currentHolderType!=="none"||row.currentHolderUserId||row.currentHolderWarehouseId||row.collectedAmount!==null||row.expectedAmount===null||row.currency!==currency||!decimal(row.expectedAmount).eq(amount))return cashDenied("CASH_EXPECTED_BASIS_REQUIRED",409);
  }else{
   ({state,row}=await held(tx,cap,order,v.kind));amount=decimal(state.amount);currency=state.currency;priceApprovalId=state.priceApprovalId;
   // An identity changing between hint and Order lock cannot be adopted out of order.
   if(!identities.includes(state.holderMembershipId))return cashDenied("CASH_CONTEXT_CHANGED",409);
   const source=await sourceCap(tx,cap,state);
   if(v.expectedEventId!==state.eventId)return cashDenied("CASH_STATE_STALE",409);
   holderMembershipId=state.holderMembershipId;holderUserId=state.holderUserId;holderWarehouseId=state.holderWarehouseId;
   if(action==="offer"){
    if(state.holderMembershipId!==cap.membershipId)return cashDenied("CASH_CURRENT_HOLDER_REQUIRED");
    const to=await target(tx,cap,order,state,v.recipientMembershipId,v.recipientWarehouseId);
    offer=(await tx.$queryRaw<any[]>`INSERT INTO "RestrictedCashTransferOffer" ("operationId","tenantId","companyId","legalEntityId","orderId","collectionId",kind,amount,currency,"expectedEventId","sourceMembershipId","sourceUserId","sourceWarehouseId","recipientMembershipId","recipientUserId","recipientWarehouseId",fingerprint,note)
     VALUES (${v.operationId},${cap.tenantId}::uuid,${cap.companyId}::uuid,${cap.legalEntityId}::uuid,${order.id}::uuid,${row.id}::uuid,${v.kind},${amount},${currency},${state.eventId}::uuid,${cap.membershipId}::uuid,${cap.userId}::uuid,${state.holderWarehouseId}::uuid,${to.membershipId}::uuid,${to.userId}::uuid,${v.recipientWarehouseId}::uuid,${fingerprint},${v.note??null}) RETURNING id`)[0];
   }else if(action==="accept"){
    offer=(await tx.$queryRaw<any[]>`SELECT * FROM "RestrictedCashTransferOffer" WHERE id=${v.offerId}::uuid AND "tenantId"=${cap.tenantId}::uuid AND "companyId"=${cap.companyId}::uuid FOR SHARE`)[0];
    if(!offer||offer.recipientMembershipId!==cap.membershipId||offer.recipientUserId!==cap.userId||offer.sourceMembershipId!==state.holderMembershipId||offer.sourceWarehouseId!==state.holderWarehouseId||offer.expectedEventId!==state.eventId||offer.collectionId!==row.id||offer.legalEntityId!==cap.legalEntityId||offer.currency!==currency||!decimal(offer.amount).eq(amount))return cashDenied("CASH_OFFER_BINDING_REQUIRED");
    await target(tx,source,order,state,cap.membershipId,offer.recipientWarehouseId);
    holderMembershipId=cap.membershipId;holderUserId=cap.userId;holderWarehouseId=offer.recipientWarehouseId;
   }else{
    if(cap.profileRevision!=="cash-settlement-checker.v1"||!state.holderWarehouseId||!cap.warehouseIds.includes(state.holderWarehouseId))return cashDenied("CASH_WAREHOUSE_SETTLEMENT_REQUIRED");
    const collector=await tx.cashCollectionEvent.findFirst({where:{cashCollectionId:row.id,eventType:"collected"},orderBy:[{createdAt:"asc"},{id:"asc"}]});
    if(!collector?.actorId||[collector.actorId,row.events[0].actorId,state.holderUserId].includes(cap.userId))return cashDenied("CASH_INDEPENDENT_SETTLEMENT_REQUIRED");
   }
  }
  let eventId=state?.eventId;
  if(action!=="offer"){
   const settled=action==="settle",toType=settled?"finance":holderWarehouseId?"warehouse":"driver";
   const event=await tx.cashCollectionEvent.create({data:{cashCollectionId:row.id,eventType:action==="collect"?"collected":settled?"settled":"handoff",amount:amount.toNumber(),actorId:cap.userId,note:v.note??null,
    fromHolderType:action==="collect"?"none":state.holderWarehouseId?"warehouse":"driver",fromHolderId:action==="collect"?null:state.holderWarehouseId??state.holderUserId,toHolderType:toType,toHolderId:settled?null:holderWarehouseId??holderUserId,createdAt:new Date()}});
   eventId=event.id;
   await tx.cashCollection.update({where:{id:row.id},data:{status:settled?"settled":"held",collectedAmount:amount.toNumber(),currentHolderType:toType,currentHolderUserId:settled||holderWarehouseId?null:holderUserId,currentHolderWarehouseId:settled?null:holderWarehouseId,currentHolderLabel:toType,...(action==="collect"?{collectedAt:new Date()}:{}),...(settled?{settledAt:new Date()}: {})}});
   if(action==="collect")await tx.order.update({where:{id:order.id},data:{serviceChargePaidStatus:"PAID"}});
   await tx.cashCustodyOperation.create({data:{tenantId:cap.tenantId,companyId:cap.companyId,orderId:order.id,collectionId:row.id,eventId:event.id,actorId:cap.userId,companyMembershipId:cap.membershipId,operationKey:v.operationId,action:action==="accept"?"handoff":action,fingerprint,amount,currency,resultJson:{eventId:event.id}}});
   if(action==="collect")await tx.$executeRaw`INSERT INTO "RestrictedCashState" ("collectionId","orderId","tenantId","companyId","legalEntityId",kind,amount,currency,"holderMembershipId","holderUserId","holderWarehouseId","eventId","priceApprovalId") VALUES (${row.id}::uuid,${order.id}::uuid,${cap.tenantId}::uuid,${cap.companyId}::uuid,${cap.legalEntityId}::uuid,${v.kind},${amount},${currency},${holderMembershipId}::uuid,${holderUserId}::uuid,${holderWarehouseId}::uuid,${eventId}::uuid,${priceApprovalId}::uuid)`;
   else await tx.$executeRaw`UPDATE "RestrictedCashState" SET "holderMembershipId"=${holderMembershipId}::uuid,"holderUserId"=${holderUserId}::uuid,"holderWarehouseId"=${holderWarehouseId}::uuid,"eventId"=${eventId}::uuid WHERE "collectionId"=${row.id}::uuid`;
   // Finance authority remains unavailable here: protected exact receipts are held
   // evidence, not executable accounting source facts. DOM-06 owns that binding.
   await enqueueCargoPilotDomainEventsTx(tx,[{id:`cash-operation:${event.id}`,type:settled?"cash_settled":"cash_handoff",tenantScope:`company:${cap.companyId}`,entityId:order.id,occurredAt:event.createdAt.toISOString(),payload:{source:"cashCustody",kind:v.kind,tenantId:cap.tenantId,companyId:cap.companyId,cashOperationEventId:event.id}}]);
  }
  const result={orderId:order.id,orderNumber:order.orderNumber,kind:v.kind,action,amount:amount.toString(),currency,expectedEventId:eventId,offerId:offer?.id??null,state:action==="offer"?"offered":action==="settle"?"settled":"held",holderMembershipId:action==="settle"?null:holderMembershipId,holderWarehouseId:action==="settle"?null:holderWarehouseId,sourceWarehouseId:action==="settle"||cap.profileRevision==="warehouse-cash.v1"?(state?.holderWarehouseId??holderWarehouseId):null};
  await tx.$executeRaw`INSERT INTO "RestrictedCashReceipt" ("operationId","tenantId","companyId","legalEntityId","orderId","collectionId","actorMembershipId","actorUserId","capabilityAcceptanceId",action,fingerprint,"transferOfferId",result) VALUES (${v.operationId},${cap.tenantId}::uuid,${cap.companyId}::uuid,${cap.legalEntityId}::uuid,${order.id}::uuid,${row.id}::uuid,${cap.membershipId}::uuid,${cap.userId}::uuid,${cap.acceptedOperationId}::uuid,${action},${fingerprint},${offer?.id??null}::uuid,${JSON.stringify(result)}::jsonb)`;
  return result;
 },{maxWait:3000,timeout:15000});
}
const pageSchema=z.object({limit:z.coerce.number().int().min(1).max(50).default(25),cursor:z.string().max(1024).optional(),orderId:id.optional()}).strict();
/** Minimal authorized cash read; no obligation initialization, mutations or network work. */
export async function readRestrictedCash(actor:AppUser,input:unknown){
 const page=pageSchema.parse(input),requested=companyMembershipPrimitives.context(actor);
 return prisma.$transaction(async tx=>{
  const cap=await acceptedCashCapability(tx,actor,"cash.custody.read",true);
  const warehouses=cap.profileRevision==="warehouse-cash.v1"?cap.warehouseIds.filter((x:string)=>cap.member.scopes.some((s:any)=>s.scopeType==="warehouse"&&s.scopeRefId===x)):cap.warehouseIds;
  const binding=createHash("sha256").update(JSON.stringify({requested,acceptance:cap.acceptedOperationId,warehouses,limit:page.limit,orderId:page.orderId??null})).digest("hex");
  let after:string|null=null;if(page.cursor){try{const decoded=z.object({v:z.literal(1),context:z.literal(binding),after:id}).strict().parse(JSON.parse(Buffer.from(page.cursor,"base64url").toString()));if(Buffer.from(JSON.stringify(decoded)).toString("base64url")!==page.cursor)throw Error();after=decoded.after;}catch{return cashDenied("CASH_CURSOR_CONTEXT_REQUIRED",400);}}
  const warehouseSql=warehouses.length?Prisma.sql` s."holderWarehouseId" IN (${Prisma.join(warehouses.map((x:string)=>Prisma.sql`${x}::uuid`))}) `:Prisma.sql`false`;
  const visibility=cap.profileRevision==="local-driver-cash.v1"?Prisma.sql`(s."holderMembershipId"=${cap.membershipId}::uuid OR offer."recipientMembershipId"=${cap.membershipId}::uuid OR
   (s."collectionId" IS NULL AND ((NOT EXISTS(SELECT 1 FROM "OrderCustodyAction" history WHERE history."orderId"=o.id) AND o."assignedDriverId"=${cap.userId}::uuid AND o."currentWarehouseId" IS NULL AND o.status IN ('assigned','pickup_in_progress','picked_up')) OR
    (physical.phase='last-mile' AND physical."driverMembershipId"=${cap.membershipId}::uuid AND o."assignedDriverId"=${cap.userId}::uuid AND o.status='out_for_delivery'))))`:
   cap.profileRevision==="warehouse-cash.v1"?Prisma.sql`(${warehouseSql} OR (offer."recipientMembershipId"=${cap.membershipId}::uuid AND offer."recipientWarehouseId" IN (${Prisma.join(warehouses.map((x:string)=>Prisma.sql`${x}::uuid`))})) OR (s."collectionId" IS NULL AND o."currentWarehouseId" IN (${Prisma.join(warehouses.map((x:string)=>Prisma.sql`${x}::uuid`))})))`:
   warehouseSql;
  const rows=await tx.$queryRaw<any[]>(Prisma.sql`SELECT o.id AS "orderId",o."orderNumber",o.status AS "orderStatus",s."collectionId",s."eventId" AS "expectedEventId",s.amount::text,s.currency,s."holderMembershipId",s."holderWarehouseId",cc.status AS "cashStatus",offer.id AS "offerId",offer."recipientMembershipId",offer."recipientWarehouseId",price.total::text AS "acceptedServicePrice",price.currency AS "acceptedCurrency"
   FROM "Order" o LEFT JOIN "RestrictedCashState" s ON s."orderId"=o.id AND s.kind='service_charge' AND s."tenantId"=o."tenantId" AND s."companyId"=o."ownerOrgId" AND s."legalEntityId"=${cap.legalEntityId}::uuid
   LEFT JOIN "CashCollection" cc ON cc.id=s."collectionId"
   LEFT JOIN "RestrictedCashTransferOffer" offer ON offer."collectionId"=s."collectionId" AND offer."expectedEventId"=s."eventId" AND NOT EXISTS(SELECT 1 FROM "RestrictedCashReceipt" done WHERE done."transferOfferId"=offer.id AND done.action='accept')
   LEFT JOIN LATERAL(SELECT * FROM "OrderCustodyAction" a WHERE a."orderId"=o.id ORDER BY a.sequence DESC LIMIT 1) physical ON true
   LEFT JOIN "OrderPriceApproval" price ON price."snapshotId"=o."currentPriceApprovalId" AND price."orderId"=o.id AND price."tenantId"=o."tenantId" AND price."companyId"=o."ownerOrgId" AND price."legalEntityId"=${cap.legalEntityId}::uuid
   WHERE o."tenantId"=${cap.tenantId}::uuid AND o."ownerOrgId"=${cap.companyId}::uuid AND (o."assignedOrgId" IS NULL OR o."assignedOrgId"=${cap.companyId}::uuid)
   AND ${cap.kinds.includes("service_charge")?Prisma.sql`true`:Prisma.sql`false`} AND ${visibility}
   AND (${after}::uuid IS NULL OR o.id>${after}::uuid) AND (${page.orderId??null}::uuid IS NULL OR o.id=${page.orderId??null}::uuid)
   AND (s."collectionId" IS NOT NULL OR (price."snapshotId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "CashCollection" legacy WHERE legacy."orderId"=o.id AND legacy.kind='service_charge' AND legacy.status<>'expected')))
   ORDER BY o.id LIMIT ${page.limit+1}`);
  const items=rows.slice(0,page.limit).map(r=>({id:r.orderId,orderId:r.orderId,orderNumber:r.orderNumber,orderStatus:r.orderStatus,kind:"service_charge",expectedEventId:r.expectedEventId??null,
   amount:r.amount??null,currency:r.currency??null,state:r.cashStatus??"preflight-required",offerId:r.offerId??null,recipientMembershipId:r.recipientMembershipId??null,recipientWarehouseId:r.recipientWarehouseId??null,
   holderMembershipId:r.cashStatus==="settled"?null:r.holderMembershipId??null,holderWarehouseId:r.cashStatus==="settled"?null:r.holderWarehouseId??null,acceptedServicePrice:r.acceptedServicePrice??null,acceptedCurrency:r.acceptedCurrency??null}));
  if(page.orderId&&!items.length)return cashDenied("CASH_WORK_NOT_FOUND",404);
  return {items,meta:{limit:page.limit,hasNext:rows.length>page.limit,nextCursor:rows.length>page.limit?Buffer.from(JSON.stringify({v:1,context:binding,after:items[items.length-1].orderId})).toString("base64url"):null}};
 },{maxWait:3000,timeout:10000});
}
