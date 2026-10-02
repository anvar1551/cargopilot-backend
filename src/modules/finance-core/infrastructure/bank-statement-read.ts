import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import type { TreasuryPage } from "../application/finance-treasury.port";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { financeBadRequest, financeConflict, financeNotFound } from "../domain/finance.errors";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const summary = { id:true,legalEntityId:true,bankAccountId:true,statementNumber:true,periodStart:true,periodEnd:true,currency:true,
  openingBalance:true,totalDebits:true,totalCredits:true,closingBalance:true,status:true,submittedAt:true,approvedAt:true,rejectedAt:true,createdAt:true,updatedAt:true,
  bankAccount:{select:{id:true,code:true,name:true,currency:true,accountIdentifierMasked:true}},_count:{select:{lines:true}},
} satisfies Prisma.FinanceBankStatementSelect;
const detail = {...summary,lines:{orderBy:{sequence:"asc" as const},take:10001,select:{id:true,bankAccountId:true,sequence:true,bookingDate:true,valueDate:true,direction:true,amount:true,currency:true,
  reconciliationStatus:true,reconciliationTarget:true,reconciledAt:true,
  paymentRun:{select:{id:true,runNumber:true,status:true,bankAccountId:true,currency:true,totalAmount:true}},
  providerSettlement:{select:{id:true,settlementNumber:true,status:true,currency:true,netAmount:true}},
}}} satisfies Prisma.FinanceBankStatementSelect;
function missing():never {throw financeNotFound("Bank statement not found","FINANCE_BANK_STATEMENT_NOT_FOUND");}
async function ownership(actor:AppUser) {
  const context=await requireLegalEntityContext(actor,"finance.bankReconciliation.read");
  const owner={tenantId:context.tenantId,companyId:context.companyId,isActive:true,tenant:{is:{status:"active" as const}},company:{is:{tenantId:context.tenantId,isActive:true}}};
  const entity=await prisma.financeLegalEntity.findFirst({where:owner,select:{id:true}});
  if(!entity)return null;
  return {legalEntityId:entity.id,legalEntity:{is:owner},bankAccount:{is:{legalEntityId:entity.id}},lines:{every:{bankAccount:{is:{legalEntityId:entity.id}},AND:[
    {OR:[{paymentRun:{is:null}},{paymentRun:{is:{legalEntityId:entity.id,bankAccount:{is:{legalEntityId:entity.id}}}}}]},
    {OR:[{providerSettlement:{is:null}},{providerSettlement:{is:{legalEntityId:entity.id}}}]},
  ]}}} satisfies Prisma.FinanceBankStatementWhereInput;
}
export async function listOwnedBankStatements(actor:AppUser,page:TreasuryPage) {
  const owned=await ownership(actor);
  if(!page||Object.keys(page).some(k=>!["cursor","limit","status"].includes(k))||!Number.isInteger(page.limit)||page.limit<1||page.limit>100
    ||(page.cursor!==undefined&&(typeof page.cursor!=="string"||!uuid.test(page.cursor)))
    ||(page.status!==undefined&&!["draft","submitted","approved","rejected"].includes(page.status)))throw financeBadRequest("Invalid bank statement page","FINANCE_INVALID_PAGE");
  if(!owned){if(page.cursor)missing();return {items:[],pageInfo:{hasMore:false,nextCursor:null}};}
  const where:Prisma.FinanceBankStatementWhereInput={...owned,...(page.status?{status:page.status as Prisma.EnumFinanceBankStatementStatusFilter["equals"]}:{})};
  let keyset:Prisma.FinanceBankStatementWhereInput={};
  if(page.cursor){const cursor=await prisma.financeBankStatement.findFirst({where:{AND:[where,{id:page.cursor}]},select:{id:true,periodEnd:true}});if(!cursor)missing();keyset={OR:[{periodEnd:{lt:cursor.periodEnd}},{periodEnd:cursor.periodEnd,id:{lt:cursor.id}}]};}
  const rows=await prisma.financeBankStatement.findMany({where:{AND:[where,keyset]},select:summary,orderBy:[{periodEnd:"desc"},{id:"desc"}],take:page.limit+1});
  const hasMore=rows.length>page.limit,items=rows.slice(0,page.limit);return {items,pageInfo:{hasMore,nextCursor:hasMore?items[items.length-1].id:null}};
}
export async function getOwnedBankStatement(actor:AppUser,id:string) {
  const owned=await ownership(actor);if(typeof id!=="string"||!uuid.test(id))throw financeBadRequest("Invalid bank statement ID","FINANCE_INVALID_ID");if(!owned)missing();
  const row=await prisma.financeBankStatement.findFirst({where:{AND:[owned,{id}]},select:detail});if(!row)missing();
  if(row.lines.length>10000)throw financeConflict("Bank statement exceeds supported detail size","FINANCE_BANK_STATEMENT_DETAIL_LIMIT");
  if(row.bankAccount.currency!==row.currency||row.lines.some(line=>line.bankAccountId!==row.bankAccountId||line.currency!==row.currency
    ||(line.paymentRun&&(line.providerSettlement||line.reconciliationTarget!=="payment_run"||line.reconciliationStatus!=="matched"||line.direction!=="debit"||line.paymentRun.status!=="executed"||line.paymentRun.bankAccountId!==row.bankAccountId||line.paymentRun.currency!==row.currency||!line.amount.equals(line.paymentRun.totalAmount)))
    ||(line.providerSettlement&&(line.reconciliationTarget!=="provider_settlement"||line.reconciliationStatus!=="matched"||line.direction!=="credit"||line.providerSettlement.status!=="approved"||line.providerSettlement.currency!==row.currency||!line.amount.equals(line.providerSettlement.netAmount)))
    ||(line.reconciliationStatus==="matched"&&!line.paymentRun&&!line.providerSettlement)))
    throw financeConflict("Bank statement references are inconsistent","FINANCE_BANK_STATEMENT_REFERENCE_CONFLICT");
  return row;
}
