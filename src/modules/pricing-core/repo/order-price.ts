import Decimal from "decimal.js";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { requireAuthorizedOrder } from "../../orders-core/domain/order-access";
import { requireCustomerEntityReference } from "../../customers-core/application/customerEntityRepo";
import { billingActor, billingOwner, billingAuthority, billingError, billingHash, assertBillingRetry, loadApprovedBillingPolicy } from "./billing-policy";
import { calculateAcceptedPrice, billingRouteIdentity } from "../domain/billing-calculation";

import { serviceInstruction, assertServiceBasisUntouched, publishServiceObligation } from "./service-cash-basis";
const request = z.object({ orderId: z.string().uuid().transform(v => v.toLowerCase()), operationId: z.string().uuid().transform(v => v.toLowerCase()),
  reason: z.string().trim().min(1).max(1000) }).strict();
const payerRequest = request.extend({ payerCustomerEntityId: z.string().uuid().transform(v => v.toLowerCase()), evidence: z.string().trim().min(1).max(500) });
export const servicePaymentInstructionSchema=request.extend({billToId:z.string().uuid().transform(v=>v.toLowerCase()),method:z.literal("CASH"),
  collectionParty:z.enum(["SENDER","RECIPIENT"]),evidence:z.string().trim().min(1).max(500)});
export async function bindServicePaymentInstruction(u:AppUser,raw:unknown){
  const input=servicePaymentInstructionSchema.parse(raw),{operationId,...intent}=input,intentHash=billingHash(intent);
  return prisma.$transaction(async tx=>{
    const entity=await billingAuthority(tx,u,"billing.payers.bind"),o=await ownedOrder(tx,u,input.orderId,"billing.payers.bind");
    const billTo=await tx.orderBillTo.findFirst({where:{id:input.billToId,orderId:o.id,...billingOwner(u),legalEntityId:entity.id}});
    if(!billTo)throw billingError("CASH_BILL_TO_REQUIRED");
    await requireCustomerEntityReference(u,billTo.payerCustomerEntityId);
    const old=(await tx.$queryRaw<any[]>`SELECT * FROM "OrderServicePaymentInstruction" WHERE "tenantId"=${u.tenantId!}::uuid AND "operationId"=${operationId}::uuid`)[0];
    if(old){assertBillingRetry(old,u,intentHash);return {id:old.id,orderId:old.orderId,method:old.method,collectionParty:old.collectionParty};}
    await assertServiceBasisUntouched(tx,o.id);
    if(o.paymentType!=="CASH" || o.currentPriceApprovalId || await serviceInstruction(tx,o.id))throw billingError("CASH_INSTRUCTION_ALREADY_BOUND_OR_INELIGIBLE");
    const row=(await tx.$queryRaw<any[]>`INSERT INTO "OrderServicePaymentInstruction"
      ("tenantId","companyId","legalEntityId","orderId","billToId","payerCustomerEntityId","actorUserId","companyMembershipId","tenantMembershipId","operationId","intentHash",method,"collectionParty",evidence,reason)
      VALUES (${u.tenantId!}::uuid,${u.companyId!}::uuid,${entity.id}::uuid,${o.id}::uuid,${billTo.id}::uuid,${billTo.payerCustomerEntityId}::uuid,
      ${u.id}::uuid,${u.companyMembershipId!}::uuid,${u.tenantMembershipId!}::uuid,${operationId}::uuid,${intentHash},'CASH',${input.collectionParty},${input.evidence},${input.reason}) RETURNING id`)[0];
    await tx.financeAuditEvent.create({data:{legalEntityId:entity.id,actorUserId:u.id,action:"cash.service.instruction.bound",detailsJson:{instructionId:row.id,orderId:o.id,billToId:billTo.id,collectionParty:input.collectionParty,reason:input.reason}}});
    return {id:row.id,orderId:o.id,method:"CASH",collectionParty:input.collectionParty};
  },{maxWait:2000,timeout:10000});
}
async function ownedOrder(tx: Prisma.TransactionClient, u: AppUser, id: string, permission: string) {
  await requireAuthorizedOrder(u, id, permission);
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${id}::uuid AND "tenantId"=${u.tenantId!}::uuid AND "ownerOrgId"=${u.companyId!}::uuid FOR UPDATE`;
  await requireAuthorizedOrder(u, id, permission);
  const o = await tx.order.findFirst({ where: { id, ...{ tenantId: u.tenantId!, ownerOrgId: u.companyId! } }, include: {
    senderAddressObj: { select: { id: true, tenantId: true, customerEntityId: true, city: true, country:true } },
    receiverAddressObj: { select: { id: true, tenantId: true, customerEntityId: true, city: true, country:true } },
  } });
  if (!o) throw billingError("BILLING_ORDER_NOT_FOUND",404);
  return o;
}
export async function bindOrderBillTo(u: AppUser, raw: unknown) {
  const input = payerRequest.parse(raw), { operationId, ...intent } = input, intentHash = billingHash(intent);
  return prisma.$transaction(async tx => {
    const entity = await billingAuthority(tx,u,"billing.payers.bind");
    const o = await ownedOrder(tx,u,input.orderId,"billing.payers.bind");
    await requireCustomerEntityReference(u,input.payerCustomerEntityId);
    const retry = await tx.orderBillTo.findUnique({ where: { tenantId_operationId: { tenantId: u.tenantId!, operationId } } });
    if (retry) { assertBillingRetry(retry,u,intentHash); return { id: retry.id, payerCustomerEntityId: retry.payerCustomerEntityId }; }
    if (await tx.orderBillTo.findUnique({ where: { orderId:o.id } }) || await tx.invoice.findUnique({ where: { orderId:o.id } })) throw billingError("BILLING_PAYER_ALREADY_BOUND_OR_INVOICED");
    const row = await tx.orderBillTo.create({ data: { ...billingOwner(u), ...billingActor(u), legalEntityId:entity.id, orderId:o.id, payerCustomerEntityId:input.payerCustomerEntityId,
      evidence:input.evidence, reason:input.reason, operationId, intentHash } });
    await tx.financeAuditEvent.create({ data: { legalEntityId:entity.id, actorUserId:u.id, action:"billing.payer.bound", detailsJson:{ orderId:o.id,billToId:row.id,reason:input.reason } } });
    return { id:row.id,payerCustomerEntityId:row.payerCustomerEntityId };
  },{maxWait:2000,timeout:10000});
}
async function compute(tx: Prisma.TransactionClient,u:AppUser,o:Awaited<ReturnType<typeof ownedOrder>>,entityId:string) {
  if (!o.currency || !/^[A-Z]{3}$/.test(o.currency)) throw billingError("BILLING_CURRENCY_POLICY_UNCONFIGURED");
  const policy = await loadApprovedBillingPolicy(tx,u,entityId,o.currency);
  if (!policy.content.billing.eligibleOrderStates.includes(o.status)) throw billingError("BILLING_ORDER_STATE_INELIGIBLE");
  const billTo = await tx.orderBillTo.findFirst({ where:{orderId:o.id,...billingOwner(u),legalEntityId:entityId} });
  if (!billTo) throw billingError("BILLING_PAYER_INSTRUCTION_REQUIRED");
  await requireCustomerEntityReference(u,billTo.payerCustomerEntityId);
  if (!o.customerEntityId || !o.senderAddressObj || !o.receiverAddressObj ||
      [o.senderAddressObj,o.receiverAddressObj].some(a => a.tenantId !== u.tenantId || a.customerEntityId !== o.customerEntityId || !a.city))
    throw billingError("BILLING_STRUCTURED_ROUTE_EVIDENCE_REQUIRED");
  await requireCustomerEntityReference(u,o.customerEntityId);
  const origin=o.senderAddressObj.city!.trim().toLowerCase(), destination=o.receiverAddressObj.city!.trim().toLowerCase();
  const route=billingRouteIdentity(origin,destination,o.senderAddressObj.country,o.receiverAddressObj.country);
  const zones=policy.content.zones.mappings.filter(m=>billingRouteIdentity(m.origin,m.destination,m.originCountry,m.destinationCountry)===route);
  if(zones.length!==1 || o.weightKg==null || !Number.isFinite(o.weightKg) || o.weightKg<=0) throw billingError("BILLING_WEIGHT_OR_ZONE_UNCONFIGURED");
  // Weight is a recorded non-money measurement. No Float estimate is used as selling-price authority.
  const weight=o.weightKg.toString(), zone=zones[0].zone;
  // Filter immutable approved authority before the cap, never mutable draft pricing fields.
  // Return only bounded IDs first; SQL deadlines bound scans of unrelated history.
  const eligible=await tx.$queryRaw<Array<{id:string;createdAt:Date}>>`
    SELECT v.id,p."createdAt" FROM "TariffPlan" p
    JOIN "TariffPublicationDecision" d ON d."versionId"=p."approvedVersionId" AND d."planId"=p.id
      AND d."tenantId"=p."tenantId" AND d."companyId"=p."companyId" AND d.decision='approved'
    JOIN "TariffConfigurationVersion" v ON v.id=d."versionId" AND v."planId"=p.id
      AND v."tenantId"=p."tenantId" AND v."companyId"=p."companyId"
    WHERE p."tenantId"=${u.tenantId!}::uuid AND p."companyId"=${u.companyId!}::uuid AND p.status<>'archived'
      AND v.content->>'currency'=${o.currency} AND v.content->>'serviceType'=${o.serviceType ?? ""}
      AND v.content->>'coverageType'=${zones[0].coverageType} AND v.content->>'transportMode'=${zones[0].transportMode}
      AND v.content->>'pricingStrategy'='FIXED_LANE' AND v.content->>'priceType'='bucket'
      AND (v.content->>'customerEntityId' IS NULL OR v.content->>'customerEntityId'=${o.customerEntityId})
      AND (v.content->>'coverageType'<>'international' OR
        (v.content->>'originCountryCode'=${zones[0].originCountry} AND v.content->>'destinationCountryCode'=${zones[0].destinationCountry}))
      AND (v.content->>'routeTemplateId' IS NULL OR EXISTS (
        SELECT 1 FROM "OrderLeg" l JOIN "RouteTemplate" r ON r.id=l."routeTemplateId"
        JOIN "Organization" company ON company.id=r."companyId"
        WHERE l."orderId"=${o.id}::uuid AND r.id::text=v.content->>'routeTemplateId'
          AND r."companyId"=${u.companyId!}::uuid AND company."tenantId"=${u.tenantId!}::uuid AND r."isActive"=true))
    ORDER BY v.id LIMIT 101`;
  if(eligible.length>100)throw billingError("BILLING_TARIFF_SELECTION_LIMIT");
  const versions=await tx.tariffConfigurationVersion.findMany({where:{id:{in:eligible.map(v=>v.id)},...billingOwner(u)},take:100});
  const createdAt=new Map(eligible.map(v=>[v.id,v.createdAt]));
  const candidates:any[]=[];
  for(const v of versions){
    const c=v.content as any;
    if(!v || !c || billingHash(c)!==v.contentSha256 || c.companyId!==u.companyId || c.tenantId!==u.tenantId ||
      c.coverageType!==zones[0].coverageType || c.transportMode!==zones[0].transportMode ||
      (c.coverageType==="international" && (c.originCountryCode!==zones[0].originCountry || c.destinationCountryCode!==zones[0].destinationCountry)) ||
      c.currency!==o.currency || c.serviceType!==o.serviceType || c.pricingStrategy!=="FIXED_LANE" || c.priceType!=="bucket" ||
      (c.customerEntityId && c.customerEntityId!==o.customerEntityId))continue;
    if(c.routeTemplateId && !await tx.orderLeg.findFirst({where:{orderId:o.id,routeTemplateId:c.routeTemplateId},select:{id:true}}))continue;
    if(c.routeTemplateId && !await tx.routeTemplate.findFirst({where:{id:c.routeTemplateId,companyId:u.companyId,isActive:true,company:{tenantId:u.tenantId}},select:{id:true}}))continue;
    candidates.push({v,c,createdAt:createdAt.get(v.id)!});
  }
  candidates.sort((a,b)=>Number(Boolean(b.c.customerEntityId))-Number(Boolean(a.c.customerEntityId)) || Number(b.c.isDefault)-Number(a.c.isDefault) ||
    b.c.priority-a.c.priority || b.createdAt.getTime()-a.createdAt.getTime() || a.v.id.localeCompare(b.v.id));
  if(!candidates.length)throw billingError("BILLING_APPROVED_TARIFF_REQUIRED");
  const {v,c}=candidates[0], rates=c.rates.filter((r:any)=>r.zone===zone && new Decimal(weight).gte(r.weightFromKg) && new Decimal(weight).lte(r.weightToKg));
  // No fallback to a lower-precedence plan when the selected one has ambiguous/missing coverage.
  if(rates.length!==1)throw billingError("BILLING_BUCKET_AMBIGUOUS_OR_MISSING");
  const price=calculateAcceptedPrice(policy.content,rates[0].price);
  const content={orderId:o.id,legalEntityId:entityId,billToId:billTo.id,payerCustomerEntityId:billTo.payerCustomerEntityId,
    tariffVersionId:v.id,tariffPlanId:v.planId,tariffContentHash:v.contentSha256,policyVersionId:policy.row.id,policyContentHash:policy.row.contentHash,
    inputs:{weight,zone,origin,destination,serviceType:o.serviceType,customerEntityId:o.customerEntityId,senderAddressId:o.senderAddressId,receiverAddressId:o.receiverAddressId},
    components:price.components.map(component=>({...component,sourceVersionId:component.type==="base_tariff"?v.id:policy.row.id})),total:price.total,currency:price.currency};
  return {price,content,hash:billingHash(content),billTo,v,policy};
}
async function acceptSnapshot(tx:Prisma.TransactionClient,u:AppUser,s:any,o:Awaited<ReturnType<typeof ownedOrder>>,operationId:string,intentHash:string,reason:string) {
  if(o.currentPriceApprovalId!==s.previousApprovalId || await tx.invoice.findUnique({where:{orderId:o.id}}))throw billingError("BILLING_REVISION_STALE_OR_INVOICED");
  if(await serviceInstruction(tx,o.id))await assertServiceBasisUntouched(tx,o.id);
  const approved=await tx.orderPriceApproval.create({data:{snapshotId:s.id,...billingOwner(u),...billingActor(u),legalEntityId:s.legalEntityId,orderId:o.id,
    billToId:s.billToId,policyVersionId:s.policyVersionId,payerCustomerEntityId:s.payerCustomerEntityId,currency:s.currency,total:s.total,kind:s.kind,makerUserId:s.actorUserId,operationId,intentHash,reason}});
  await publishServiceObligation(tx,approved,o);
  const changed=await tx.order.updateMany({where:{id:o.id,tenantId:u.tenantId,ownerOrgId:u.companyId,currentPriceApprovalId:s.previousApprovalId},data:{currentPriceApprovalId:s.id}});
  if(changed.count!==1)throw billingError("BILLING_REVISION_CONFLICT");
  await tx.financeAuditEvent.create({data:{legalEntityId:s.legalEntityId,actorUserId:u.id,action:"billing.price.accepted",detailsJson:{orderId:o.id,snapshotId:s.id,previousApprovalId:s.previousApprovalId,reason}}});
  return approved;
}
export async function acceptOrderPrice(u:AppUser,raw:unknown){
  const input=request.parse(raw),{operationId,...intent}=input,intentHash=billingHash(intent);
  return prisma.$transaction(async tx=>{
    const entity=await billingAuthority(tx,u,"pricing.orders.accept"),o=await ownedOrder(tx,u,input.orderId,"pricing.orders.accept");
    const retry=await tx.orderPriceSnapshot.findUnique({where:{tenantId_operationId:{tenantId:u.tenantId!,operationId}}});
    if(retry){assertBillingRetry(retry,u,intentHash);await requireCustomerEntityReference(u,retry.payerCustomerEntityId);return projectPrice(tx,retry);}
    const result=await compute(tx,u,o,entity.id);
    if(await tx.invoice.findUnique({where:{orderId:o.id}}))throw billingError("BILLING_INVOICE_CORRECTION_POLICY_REQUIRED");
    const kind=o.currentPriceApprovalId?"revision":result.price.requiresIndependentApproval?"exception":"standard";
    const row=await tx.orderPriceSnapshot.create({data:{...billingOwner(u),...billingActor(u),legalEntityId:entity.id,orderId:o.id,billToId:result.billTo.id,
      payerCustomerEntityId:result.billTo.payerCustomerEntityId,tariffVersionId:result.v.id,tariffPlanId:result.v.planId,policyVersionId:result.policy.row.id,
      previousApprovalId:o.currentPriceApprovalId,currency:o.currency!,kind,content:result.content as Prisma.InputJsonValue,contentHash:result.hash,total:result.price.total,
      operationId,intentHash,reason:input.reason}});
    await tx.financeAuditEvent.create({data:{legalEntityId:entity.id,actorUserId:u.id,action:"billing.price.proposed",detailsJson:{snapshotId:row.id,contentHash:row.contentHash,reason:input.reason}}});
    if(kind==="standard")await acceptSnapshot(tx,u,row,o,operationId,intentHash,input.reason);
    return projectPrice(tx,row);
  },{maxWait:2000,timeout:10000});
}
const approvalRequest=request.extend({snapshotId:z.string().uuid().transform(v=>v.toLowerCase()),contentHash:z.string().regex(/^[a-f0-9]{64}$/)});
export async function approveOrderPrice(u:AppUser,raw:unknown){
  const input=approvalRequest.parse(raw),{operationId,...intent}=input,intentHash=billingHash(intent);
  return prisma.$transaction(async tx=>{
    const entity=await billingAuthority(tx,u,"pricing.orders.approve"),o=await ownedOrder(tx,u,input.orderId,"pricing.orders.approve");
    const s=await tx.orderPriceSnapshot.findFirst({where:{id:input.snapshotId,orderId:o.id,...billingOwner(u),legalEntityId:entity.id}});
    if(!s)throw billingError("BILLING_PRICE_NOT_FOUND",404);
    if(s.actorUserId===u.id || s.kind==="standard")throw billingError("BILLING_INDEPENDENT_APPROVER_REQUIRED",403);
    if(s.contentHash!==input.contentHash || billingHash(s.content)!==s.contentHash)throw billingError("BILLING_PRICE_CONTENT_CONFLICT");
    await requireCustomerEntityReference(u,s.payerCustomerEntityId);
    const receipt=await tx.orderPriceApproval.findUnique({where:{tenantId_operationId:{tenantId:u.tenantId!,operationId}}});
    if(receipt){assertBillingRetry(receipt,u,intentHash);if(receipt.snapshotId!==s.id)throw billingError("BILLING_INTENT_CONFLICT");return projectPrice(tx,s);}
    const fresh=await compute(tx,u,o,entity.id);
    if(fresh.hash!==s.contentHash)throw billingError("BILLING_PRICE_SOURCE_CHANGED");
    await acceptSnapshot(tx,u,s,o,operationId,intentHash,input.reason);return projectPrice(tx,s);
  },{maxWait:2000,timeout:10000});
}
async function projectPrice(tx:Prisma.TransactionClient,s:any){
  const approval=await tx.orderPriceApproval.findUnique({where:{snapshotId:s.id},select:{snapshotId:true,createdAt:true}});
  return {id:s.id,orderId:s.orderId,contentHash:s.contentHash,currency:s.currency,total:s.total.toFixed(4),content:s.content,
    state:approval?"accepted":"approval_required",acceptedAt:approval?.createdAt??null};
}
