import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { billingAuthority, billingOwner, billingHash, billingError } from "./billing-policy";
import { buildMembershipOrderScopeWhere } from "../../identity-access/access-control";
import { requireCustomerEntityReference } from "../../customers-core/application/customerEntityRepo";
import { historicalScope } from "./tariff-versions";

const querySchema = z.object({
  view: z.enum(["tariffs", "templates", "regions", "zones", "sla", "policies", "orders", "order"]),
  permission: z.enum(["pricing.read", "billing.payers.bind", "pricing.orders.accept", "pricing.orders.approve"]),
  id: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(20).default(10),
  cursor: z.string().max(1000).optional(), q: z.string().trim().max(100).default(""),
}).strict();
export async function readPricingWorkflow(u: AppUser, raw: unknown) {
  const q = querySchema.parse(raw);
  if ((["tariffs", "templates", "regions", "zones", "sla", "policies"].includes(q.view)) !== (q.permission === "pricing.read")) throw billingError("BILLING_READ_PERMISSION_MISMATCH",400);
  if (["tariffs", "order"].includes(q.view) && !q.id) throw billingError("BILLING_READ_REFERENCE_REQUIRED",400);
  const binding = billingHash({tenant:u.tenantId??null,company:u.companyId??null,membership:u.companyMembershipId??null,user:u.id,view:q.view,permission:q.permission,id:q.id??null,q:q.q});
  let after: string | undefined;
  if(q.cursor){
    try {const c=z.object({binding:z.literal(binding),after:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(q.cursor,"base64url").toString()));after=c.after;}
    catch {throw billingError("BILLING_CURSOR_CONTEXT_MISMATCH",400);}
  }
  const page = <T extends {id:string}>(rows:T[]) => ({items:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?Buffer.from(JSON.stringify({binding,after:rows[q.limit-1].id})).toString("base64url"):null});
  return prisma.$transaction(async tx => {
    const entity=await billingAuthority(tx,u,q.permission),owner={...billingOwner(u),legalEntityId:entity.id};
    // Existing shared reference-data reads are preserved, bounded and explicitly
    // read-only. This does not establish tenant ownership or enable their mutations.
    const range=after?{id:{gt:after}}:{};
    if(q.view==="regions")return page(await tx.pricingRegion.findMany({where:range,orderBy:{id:"asc"},take:q.limit+1,select:{id:true,name:true,code:true,aliases:true,sortOrder:true,isActive:true}}));
    if(q.view==="zones")return page(await tx.zoneMatrixEntry.findMany({where:range,orderBy:{id:"asc"},take:q.limit+1,select:{id:true,zone:true,originRegion:{select:{name:true,code:true}},destinationRegion:{select:{name:true,code:true}}}}));
    if(q.view==="sla")return {...page(await tx.deliverySlaRule.findMany({where:range,orderBy:{id:"asc"},take:q.limit+1,select:{id:true,name:true,description:true,serviceType:true,zone:true,deliveryDays:true,priority:true,isActive:true,originRegion:{select:{name:true}},destinationRegion:{select:{name:true}}}})),policy:await tx.operationalSlaPolicy.findUnique({where:{singletonKey:"global"},select:{staleHours:true,dueSoonHours:true,overdueGraceHours:true}})};
    if(q.view==="templates")return page(await tx.routeTemplate.findMany({where:{companyId:u.companyId!,company:{tenantId:u.tenantId!},...(after?{id:{gt:after}}:{})},orderBy:{id:"asc"},take:q.limit+1,select:{id:true,name:true,code:true}}));
    if(q.view==="tariffs") {
      const plan=await tx.tariffPlan.findFirst({where:{id:q.id,...billingOwner(u)},select:{id:true,approvedVersionId:true,contentGeneration:true,customerEntityId:true}});
      if(!plan)throw billingError("BILLING_TARIFF_NOT_FOUND",404);
      if(plan.customerEntityId)await requireCustomerEntityReference(u,plan.customerEntityId);
      const rows=await tx.tariffConfigurationVersion.findMany({where:{...billingOwner(u),planId:plan.id,...(after?{id:{gt:after}}:{})},orderBy:{id:"asc"},take:q.limit+1,
        select:{id:true,content:true,actorUserId:true,sourceGeneration:true,contentSha256:true,reason:true,proposedAt:true,decisions:{take:1,select:{decision:true,reason:true,decidedAt:true,previousVersionId:true}}}});
      for(const row of rows)await historicalScope(tx,u,row.content);
      // Detailed content remains behind the existing customer/template authorization.
      return {...page(rows.map(({decisions,actorUserId,...r})=>({...r,makerUserId:actorUserId,independent:actorUserId!==u.id,decision:decisions[0]??null}))),plan};
    }
    if(q.view==="policies") {
      const rows=await tx.billingPolicyVersion.findMany({where:{...owner,...(after?{id:{gt:after}}:{})},orderBy:{id:"asc"},take:q.limit+1,
        select:{id:true,currency:true,revision:true,content:true,contentHash:true,actorUserId:true,reason:true,createdAt:true,decisions:{take:1,select:{decision:true,reason:true,createdAt:true}}}});
      // At most one indexed latest-approved lookup per currency on this bounded
      // page. Prisma client-side distinct must not fetch all historical versions.
      const currents=(await Promise.all([...new Set(rows.map(r=>r.currency))].map(currency=>tx.billingPolicyVersion.findFirst({where:{...owner,currency,decisions:{some:{decision:"approved"}}},orderBy:{revision:"desc"},select:{id:true}})))).filter((r):r is {id:string}=>!!r);
      return {...page(rows.map(({decisions,actorUserId,...r})=>({...r,makerUserId:actorUserId,independent:actorUserId!==u.id,decision:decisions[0]??null,current:currents.some(c=>c.id===r.id)}))),entity:{id:entity.id,baseCurrency:entity.baseCurrency}};
    }
    const scope=await buildMembershipOrderScopeWhere(u,q.permission);
    if(!scope)throw billingError("BILLING_ORDER_SCOPE_REQUIRED",403);
    const where:Prisma.OrderWhereInput={AND:[scope,{tenantId:u.tenantId!,ownerOrgId:u.companyId!},...(q.view==="order"?[{id:q.id}]:[]),...(after&&q.view==="orders"?[{id:{gt:after}}]:[]),...(q.q?[{orderNumber:{contains:q.q,mode:"insensitive" as const}}]:[])]};
    const rows=await tx.order.findMany({where,orderBy:{id:"asc"},take:q.view==="order"?1:q.limit+1,
      select:{id:true,orderNumber:true,status:true,currency:true,paymentType:true,customerEntityId:true,currentPriceApprovalId:true,weightKg:true}});
    if(q.view==="orders")return page(rows);
    const order=rows[0];if(!order)throw billingError("BILLING_ORDER_NOT_FOUND",404);
    if(order.customerEntityId)await requireCustomerEntityReference(u,order.customerEntityId);
    const billTo=await tx.orderBillTo.findFirst({where:{...owner,orderId:order.id},select:{id:true,payerCustomerEntityId:true,evidence:true,reason:true,createdAt:true}});
    if(billTo)await requireCustomerEntityReference(u,billTo.payerCustomerEntityId);
    const prices=await tx.orderPriceSnapshot.findMany({where:{...owner,orderId:order.id,...(after?{id:{gt:after}}:{})},orderBy:{id:"asc"},take:q.limit+1,
      select:{id:true,kind:true,total:true,currency:true,content:true,contentHash:true,actorUserId:true,reason:true,createdAt:true,policy:{select:{id:true,contentHash:true,content:true}},OrderPriceApproval_source:{take:1,select:{createdAt:true}}}});
    for(const price of prices)await requireCustomerEntityReference(u,(price.content as any).payerCustomerEntityId);
    const instruction=(await tx.$queryRaw<any[]>`SELECT id,method,"collectionParty",evidence,reason,"createdAt" FROM "OrderServicePaymentInstruction"
      WHERE "orderId"=${order.id}::uuid AND "tenantId"=${u.tenantId!}::uuid AND "companyId"=${u.companyId!}::uuid AND "legalEntityId"=${entity.id}::uuid`)[0]??null;
    const obligation=(await tx.$queryRaw<any[]>`SELECT b."priceApprovalId",b."instructionId",b."billToId",b."collectionId",b."previousApprovalId",b.amount::text,b.currency
      FROM "OrderServiceCashObligation" b WHERE b."orderId"=${order.id}::uuid AND b."tenantId"=${u.tenantId!}::uuid AND b."companyId"=${u.companyId!}::uuid
      AND b."legalEntityId"=${entity.id}::uuid AND b."priceApprovalId"=${order.currentPriceApprovalId}::uuid`)[0]??null;
    return {order,entity:{id:entity.id,baseCurrency:entity.baseCurrency},billTo,instruction,obligation,
      prices:page(prices.map(({OrderPriceApproval_source,actorUserId,total,...p})=>({...p,total:total.toFixed(4),makerUserId:actorUserId,independent:actorUserId!==u.id,current:p.id===order.currentPriceApprovalId,acceptedAt:OrderPriceApproval_source[0]?.createdAt??null}))),
      caution:"Current reads are not authorization to mutate. Collection, any payment attempt/reservation or invoice can freeze the basis; sender deadline is picked_up, recipient deadline delivered. Server revalidates every mutation."};
  },{maxWait:2000,timeout:10000});
}
