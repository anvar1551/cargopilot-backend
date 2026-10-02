import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { FinanceDocumentPage } from "../application/finance-documents.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const summary={id:true,legalEntityId:true,settlementNumber:true,providerCode:true,environment:true,periodStart:true,periodEnd:true,currency:true,grossAmount:true,refundAmount:true,feeAmount:true,adjustmentAmount:true,netAmount:true,fxRate:true,fxRateAsOf:true,status:true,submittedAt:true,approvedAt:true,rejectedAt:true,createdAt:true,updatedAt:true,_count:{select:{lines:true}}} satisfies Prisma.FinanceProviderSettlementSelect;
const detail={...summary,lines:{orderBy:{sequence:"asc" as const},take:5001,select:{id:true,sequence:true,type:true,reconciliationStatus:true,amount:true,occurredAt:true,createdAt:true}}} satisfies Prisma.FinanceProviderSettlementSelect;
function missing():never {throw financeNotFound("Provider settlement not found","FINANCE_SETTLEMENT_NOT_FOUND");}
async function ownership(actor:AppUser) {
  const context=await requireLegalEntityContext(actor,"finance.settlements.read");
  const owner={tenantId:context.tenantId,companyId:context.companyId,isActive:true,tenant:{is:{status:"active" as const}},company:{is:{tenantId:context.tenantId,isActive:true}}};
  const entity=await prisma.financeLegalEntity.findFirst({where:owner,select:{id:true}});
  if(!entity)return null;
  const configs=await prisma.paymentProviderConfig.findMany({where:{companyId:context.companyId,company:{is:{tenantId:context.tenantId,isActive:true}}},select:{id:true,provider:true,environment:true},take:33});
  if(configs.length>32)throw financeConflict("Provider configuration exceeds supported read size","FINANCE_SETTLEMENT_PROVIDER_LIMIT");
  if(!configs.length)return null;
  return {legalEntityId:entity.id,legalEntity:{is:owner},OR:configs.map(config=>({providerConfigId:config.id,providerCode:config.provider,environment:config.environment}))} satisfies Prisma.FinanceProviderSettlementWhereInput;
}
export async function listOwnedProviderSettlements(actor:AppUser,page:FinanceDocumentPage) {
  const owned=await ownership(actor);
  if(!page||Object.keys(page).some(k=>!["cursor","limit","status"].includes(k))||!Number.isInteger(page.limit)||page.limit<1||page.limit>100
    ||(page.cursor!==undefined&&(typeof page.cursor!=="string"||!uuid.test(page.cursor)))
    ||(page.status!==undefined&&!["draft","submitted","approved","rejected","cancelled"].includes(page.status)))throw financeBadRequest("Invalid provider settlement page","FINANCE_INVALID_PAGE");
  if(!owned){if(page.cursor)missing();return {items:[],pageInfo:{hasMore:false,nextCursor:null}};}
  const where:Prisma.FinanceProviderSettlementWhereInput={...owned,...(page.status?{status:page.status as Prisma.EnumFinanceOperationalDocumentStatusFilter["equals"]}:{})};
  let keyset:Prisma.FinanceProviderSettlementWhereInput={};
  if(page.cursor){const cursor=await prisma.financeProviderSettlement.findFirst({where:{AND:[where,{id:page.cursor}]},select:{id:true,periodEnd:true}});if(!cursor)missing();keyset={OR:[{periodEnd:{lt:cursor.periodEnd}},{periodEnd:cursor.periodEnd,id:{lt:cursor.id}}]};}
  const rows=await prisma.financeProviderSettlement.findMany({where:{AND:[where,keyset]},select:summary,orderBy:[{periodEnd:"desc"},{id:"desc"}],take:page.limit+1});
  const hasMore=rows.length>page.limit,items=rows.slice(0,page.limit);return {items,pageInfo:{hasMore,nextCursor:hasMore?items[items.length-1].id:null}};
}
export async function getOwnedProviderSettlement(actor:AppUser,id:string) {
  const owned=await ownership(actor);if(typeof id!=="string"||!uuid.test(id))throw financeBadRequest("Invalid provider settlement ID","FINANCE_INVALID_ID");if(!owned)missing();
  const row=await prisma.financeProviderSettlement.findFirst({where:{AND:[owned,{id}]},select:detail});if(!row)missing();
  if(row.lines.length>5000)throw financeConflict("Settlement exceeds supported detail size","FINANCE_SETTLEMENT_DETAIL_LIMIT");
  return row;
}
