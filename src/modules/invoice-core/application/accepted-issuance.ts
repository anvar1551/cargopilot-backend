import { z } from "zod";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { authorizedInvoiceWhere } from "./invoiceAccess";
import { requireCustomerEntityReference } from "../../customers-core/application/customerEntityRepo";
import { billingAuthority, billingOwner, billingActor, billingHash, billingError, assertBillingRetry } from "../../pricing-core/repo/billing-policy";
import { parseBillingPolicy } from "../../pricing-core/domain/billing-calculation";

export const acceptedInvoiceIntentSchema = z.object({ orderId:z.string().uuid().transform(v=>v.toLowerCase()),operationId:z.string().uuid().transform(v=>v.toLowerCase()),
  priceApprovalId:z.string().uuid().transform(v=>v.toLowerCase()),reason:z.string().trim().min(1).max(1000) }).strict();
export async function issueAcceptedOrderInvoice(u:AppUser,raw:unknown){
  const input=acceptedInvoiceIntentSchema.parse(raw),{operationId,...intent}=input,intentHash=billingHash(intent);
  return prisma.$transaction(async tx=>{
    const entity=await billingAuthority(tx,u,"finance.invoices.issue");
    const owned=await authorizedInvoiceWhere(u,"finance.invoices.issue");
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${input.orderId}::uuid AND "tenantId"=${u.tenantId!}::uuid AND "ownerOrgId"=${u.companyId!}::uuid FOR UPDATE`;
    const freshOwned=await authorizedInvoiceWhere(u,"finance.invoices.issue");
    const o=await tx.order.findFirst({where:{AND:[{id:input.orderId,tenantId:u.tenantId,ownerOrgId:u.companyId},freshOwned.order!.is!]}});
    if(!o)throw billingError("BILLING_ORDER_NOT_FOUND",404);
    const receipt=await tx.invoiceIssuanceReceipt.findUnique({where:{tenantId_operationId:{tenantId:u.tenantId!,operationId}}});
    if(receipt){
      assertBillingRetry(receipt,u,intentHash);
      const existing=await tx.invoice.findFirst({where:{AND:[owned,{id:receipt.invoiceId,billingPriceApprovalId:input.priceApprovalId,billingLegalEntityId:entity.id}]}});
      if(!existing || existing.billingPriceApprovalId!==receipt.priceApprovalId)throw billingError("BILLING_INVOICE_RECEIPT_CONFLICT");
      await requireCustomerEntityReference(u,existing.billingPayerCustomerEntityId!);
      return existing;
    }
    if(o.currentPriceApprovalId!==input.priceApprovalId)throw billingError("BILLING_CURRENT_ACCEPTED_PRICE_REQUIRED");
    const accepted=await tx.orderPriceApproval.findFirst({where:{snapshotId:input.priceApprovalId,orderId:o.id,...billingOwner(u),legalEntityId:entity.id},include:{source:true}});
    if(!accepted || billingHash(accepted.source.content)!==accepted.source.contentHash)throw billingError("BILLING_ACCEPTED_PRICE_REQUIRED");
    await requireCustomerEntityReference(u,accepted.payerCustomerEntityId);
    const policy=await tx.billingPolicyVersion.findFirst({where:{id:accepted.policyVersionId,...billingOwner(u),legalEntityId:entity.id,currency:accepted.currency,decisions:{some:{decision:"approved"}}}});
    if(!policy || billingHash(policy.content)!==policy.contentHash)throw billingError("BILLING_ACCEPTED_POLICY_REQUIRED");
    const config=parseBillingPolicy(policy.content);
    if(!config.billing.eligibleOrderStates.includes(o.status))throw billingError("BILLING_ORDER_STATE_INELIGIBLE");
    // This schema's fxRate represents a base conversion. Never fabricate identity FX for a foreign base currency.
    if(entity.baseCurrency!==accepted.currency)throw billingError("BILLING_BASE_CURRENCY_FX_POLICY_REQUIRED");
    if(await tx.invoice.findUnique({where:{orderId:o.id}}))throw billingError("BILLING_INVOICE_ALREADY_EXISTS_OR_UNACCEPTED");
    const sequence=await tx.financeNumberSequence.upsert({where:{legalEntityId_key:{legalEntityId:entity.id,key:"service_invoice"}},
      create:{legalEntityId:entity.id,key:"service_invoice",prefix:config.billing.numberPrefix,nextValue:2n,padding:8},
      update:{nextValue:{increment:1}}});
    const number=config.billing.numberPrefix+"-"+(sequence.nextValue-1n).toString().padStart(8,"0");
    const now=new Date(),dueAt=new Date(now.getTime()+config.billing.dueDays*86400000);
    const invoice=await tx.invoice.create({data:{tenantId:u.tenantId,companyId:u.companyId!,orderId:o.id,customerId:o.customerId,customerEntityId:o.customerEntityId,
      invoiceNumber:number,amount:accepted.total,currency:accepted.currency,fxRate:"1",status:"issued",issuedByUserId:u.id,issuedAt:now,dueAt,
      billingPriceApprovalId:accepted.snapshotId,billingPolicyVersionId:policy.id,billingPayerCustomerEntityId:accepted.payerCustomerEntityId,billingLegalEntityId:entity.id,billingOrderBillToId:accepted.billToId}});
    const result=await tx.invoiceIssuanceReceipt.create({data:{...billingOwner(u),...billingActor(u),legalEntityId:entity.id,orderId:o.id,invoiceId:invoice.id,
      priceApprovalId:accepted.snapshotId,currency:accepted.currency,total:accepted.total,operationId,intentHash,reason:input.reason}});
    await tx.financeAuditEvent.create({data:{legalEntityId:entity.id,actorUserId:u.id,action:"billing.invoice.issued",
      detailsJson:{invoiceId:invoice.id,priceApprovalId:accepted.snapshotId,policyVersionId:policy.id,reason:input.reason}}});
    // Durable source-bound fact, intentionally held. Existing accounting publishers do not accept invoices.
    await tx.billingInvoiceOutbox.create({data:{receiptId:result.id,...billingOwner(u),legalEntityId:entity.id,orderId:o.id,invoiceId:invoice.id,
      eventType:"invoice.issued",state:"held_no_accounting_authority"}});
    return invoice;
  },{maxWait:2000,timeout:10000});
}
