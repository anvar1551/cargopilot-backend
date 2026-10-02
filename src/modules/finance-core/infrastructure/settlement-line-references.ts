import type { Prisma } from "@prisma/client";
import type { PreparedProviderSettlement } from "../application/finance-documents.port";
import { financeConflict } from "../domain/finance.errors";

// Private document reference validation. This does not accept a supplier/provider source or accounting policy.
export async function resolveSettlementLines(tx:Prisma.TransactionClient, owner:{id:string;tenantId:string;companyId:string}, settlement:PreparedProviderSettlement) {
  const invalid=()=>financeConflict("Settlement source ownership is inconsistent","FINANCE_SETTLEMENT_SOURCE_INVALID");
  if (!settlement.lines.length || settlement.lines.length>5000) throw invalid();
  const orderOwner={tenantId:owner.tenantId,ownerOrgId:owner.companyId};
  if (!await tx.financeLegalEntity.findFirst({where:{id:owner.id,tenantId:owner.tenantId,companyId:owner.companyId,isActive:true,
    tenant:{is:{status:"active"}},company:{is:{tenantId:owner.tenantId,isActive:true}}},select:{id:true}})) throw invalid();
  const config=await tx.paymentProviderConfig.findFirst({where:{id:settlement.providerConfigId,companyId:owner.companyId},select:{provider:true,environment:true}});
  if (!config || config.provider!==settlement.providerCode || config.environment!==settlement.environment) throw invalid();
  const intentOwner={companyId:owner.companyId,providerConfigId:settlement.providerConfigId,provider:config.provider,environment:config.environment,currency:settlement.currency,order:{is:orderOwner}};
  const refunds=await tx.paymentRefund.findMany({where:{id:{in:[...new Set(settlement.lines.flatMap(l=>l.paymentRefundId?[l.paymentRefundId]:[]))]},companyId:owner.companyId,currency:settlement.currency,provider:config.provider,environment:config.environment,paymentIntent:{is:intentOwner}},
    select:{id:true,paymentIntentId:true,orderId:true},take:5001});
  const intents=await tx.paymentIntent.findMany({where:{...intentOwner,id:{in:[...new Set([...refunds.map(r=>r.paymentIntentId),...settlement.lines.flatMap(l=>l.paymentIntentId?[l.paymentIntentId]:[])])]}},select:{id:true,orderId:true},take:5001});
  const orders=await tx.order.findMany({where:{...orderOwner,id:{in:[...new Set(settlement.lines.flatMap(l=>l.orderId?[l.orderId]:[]))]}},select:{id:true},take:5001});
  const byRefund=new Map(refunds.map(r=>[r.id,r])),byIntent=new Map(intents.map(i=>[i.id,i])),ownedOrders=new Set(orders.map(o=>o.id));
  return settlement.lines.map(line=>{
    const refund=line.paymentRefundId?byRefund.get(line.paymentRefundId):undefined;
    if (line.paymentRefundId && !refund) throw invalid();
    const intentId=refund?.paymentIntentId ?? line.paymentIntentId;
    const intent=intentId?byIntent.get(intentId):undefined;
    if (line.type==="payment" && (!intentId || line.paymentRefundId) || line.type==="refund" && !refund
      || intentId && !intent || line.paymentIntentId && line.paymentIntentId!==intentId
      || refund && refund.orderId!==intent?.orderId || line.orderId && (intent ? line.orderId!==intent.orderId : !ownedOrders.has(line.orderId))) throw invalid();
    return {...line,paymentIntentId:intentId ?? null,orderId:intent?.orderId ?? line.orderId ?? null,
      legalEntityId:owner.id,tenantId:owner.tenantId,companyId:owner.companyId,providerConfigId:settlement.providerConfigId,currency:settlement.currency};
  });
}
