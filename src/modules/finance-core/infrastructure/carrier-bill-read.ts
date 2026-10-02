import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { FinanceDocumentPage } from "../application/finance-documents.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const summary={id:true,legalEntityId:true,billNumber:true,carrierCode:true,supplierInvoiceNumber:true,invoiceDate:true,dueDate:true,currency:true,subtotalAmount:true,taxAmount:true,totalAmount:true,fxRate:true,fxRateAsOf:true,status:true,submittedAt:true,approvedAt:true,rejectedAt:true,createdAt:true,updatedAt:true,_count:{select:{lines:true}}} satisfies Prisma.FinanceCarrierBillSelect;
const detail={...summary,lines:{orderBy:{sequence:"asc" as const},take:1001,select:{id:true,sequence:true,quantity:true,unitPrice:true,amount:true,taxAmount:true,createdAt:true}}} satisfies Prisma.FinanceCarrierBillSelect;
function missing():never {throw financeNotFound("Carrier bill not found","FINANCE_CARRIER_BILL_NOT_FOUND");}
async function ownership(actor:AppUser) {
  const context=await requireLegalEntityContext(actor,"finance.payables.read");
  const owner={tenantId:context.tenantId,companyId:context.companyId,isActive:true,tenant:{is:{status:"active" as const}},company:{is:{tenantId:context.tenantId,isActive:true}}};
  const entity=await prisma.financeLegalEntity.findFirst({where:owner,select:{id:true}});
  if(!entity)return null;
  const configs=await prisma.integrationProvider.findMany({where:{companyId:context.companyId,domain:"carrier",company:{is:{tenantId:context.tenantId,isActive:true}}},select:{id:true,providerCode:true},take:33});
  if(configs.length>32)throw financeConflict("Provider configuration exceeds supported read size","FINANCE_CARRIER_BILL_PROVIDER_LIMIT");
  if(!configs.length)return null;
  // Relation joins include every compound column, including leg -> exact line order.
  const order={tenantId:context.tenantId,ownerOrgId:context.companyId};
  const lines={every:{legalEntityId:entity.id,tenantId:context.tenantId,companyId:context.companyId,
    ownedEntity:{is:owner},ownedOrder:{is:order},ownedLeg:{is:{order:{is:order}}}}};
  return {companyId:context.companyId,legalEntityId:entity.id,legalEntity:{is:owner},lines,OR:configs.map(config=>({carrierProviderId:config.id,carrierCode:config.providerCode}))} satisfies Prisma.FinanceCarrierBillWhereInput;
}
export async function listOwnedCarrierBills(actor:AppUser,page:FinanceDocumentPage) {
  const owned=await ownership(actor);
  if(!page||Object.keys(page).some(k=>!["cursor","limit","status"].includes(k))||!Number.isInteger(page.limit)||page.limit<1||page.limit>100
    ||(page.cursor!==undefined&&(typeof page.cursor!=="string"||!uuid.test(page.cursor)))
    ||(page.status!==undefined&&!["draft","submitted","approved","rejected","cancelled"].includes(page.status)))throw financeBadRequest("Invalid carrier bill page","FINANCE_INVALID_PAGE");
  if(!owned){if(page.cursor)missing();return {items:[],pageInfo:{hasMore:false,nextCursor:null}};}
  const where:Prisma.FinanceCarrierBillWhereInput={...owned,...(page.status?{status:page.status as Prisma.EnumFinanceOperationalDocumentStatusFilter["equals"]}:{})};
  let keyset:Prisma.FinanceCarrierBillWhereInput={};
  if(page.cursor){const cursor=await prisma.financeCarrierBill.findFirst({where:{AND:[where,{id:page.cursor}]},select:{id:true,invoiceDate:true}});if(!cursor)missing();keyset={OR:[{invoiceDate:{lt:cursor.invoiceDate}},{invoiceDate:cursor.invoiceDate,id:{lt:cursor.id}}]};}
  const rows=await prisma.financeCarrierBill.findMany({where:{AND:[where,keyset]},select:summary,orderBy:[{invoiceDate:"desc"},{id:"desc"}],take:page.limit+1});
  const hasMore=rows.length>page.limit,items=rows.slice(0,page.limit);return {items,pageInfo:{hasMore,nextCursor:hasMore?items[items.length-1].id:null}};
}
export async function getOwnedCarrierBill(actor:AppUser,id:string) {
  const owned=await ownership(actor);if(typeof id!=="string"||!uuid.test(id))throw financeBadRequest("Invalid carrier bill ID","FINANCE_INVALID_ID");if(!owned)missing();
  const row=await prisma.financeCarrierBill.findFirst({where:{AND:[owned,{id}]},select:detail});if(!row)missing();
  if(row.lines.length>1000)throw financeConflict("Settlement exceeds supported detail size","FINANCE_CARRIER_BILL_DETAIL_LIMIT");
  return row;
}
