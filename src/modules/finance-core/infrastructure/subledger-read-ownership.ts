import { Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { requireLegalEntityContext } from "../application/legal-entity-access";
import { requireCustomerEntityReference } from "../../customers-core/application/customerEntityRepo";
import { financeBadRequest, financeNotFound } from "../domain/finance.errors";
import { FINANCE_CURRENCIES } from "../domain/ledger";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Page = {limit:number;cursor?:string;currency?:string;customerEntityId?:string;carrierProviderId?:string;asOf?:Date;type?:string;status?:string};
export async function subledgerOwner(actor:AppUser,query:Page,kind:"receivable"|"payable"|"cash") {
  const context = await requireLegalEntityContext(actor,kind==="payable"?"finance.payables.read":"finance.receivables.read");
  const keys = kind==="payable"?["limit","cursor","currency","carrierProviderId","asOf"]:kind==="cash"?["limit","cursor","currency","customerEntityId","type","status"]:["limit","cursor","currency","customerEntityId","asOf"];
  if (!query || Object.keys(query).some(k=>!keys.includes(k)) || !Number.isInteger(query.limit) || query.limit<1 || query.limit>100
    || [query.cursor,query.customerEntityId,query.carrierProviderId].some(v=>v!==undefined&&(typeof v!=="string"||!uuid.test(v)))
    || query.currency!==undefined&&!FINANCE_CURRENCIES.includes(query.currency as any)
    || kind!=="cash"&&(!(query.asOf instanceof Date)||!Number.isFinite(query.asOf.getTime()))
    || query.type!==undefined&&!["receipt","refund"].includes(query.type) || query.status!==undefined&&!["open","applied"].includes(query.status))
    throw financeBadRequest("Invalid subledger query","FINANCE_SUBLEDGER_QUERY_INVALID");
  const entity = await prisma.financeLegalEntity.findFirst({where:{companyId:context.companyId,tenantId:context.tenantId,isActive:true,tenant:{is:{status:"active"}},company:{is:{tenantId:context.tenantId,isActive:true}}},select:{id:true}});
  if (!entity) throw financeNotFound("Finance legal entity is not configured","FINANCE_ENTITY_NOT_CONFIGURED");
  if (query.customerEntityId) await requireCustomerEntityReference(actor,query.customerEntityId);
  if (query.carrierProviderId && !await prisma.integrationProvider.findFirst({where:{id:query.carrierProviderId,companyId:context.companyId,domain:"carrier",company:{is:{tenantId:context.tenantId,isActive:true}}},select:{id:true}}))
    throw financeNotFound("Carrier filter not found","FINANCE_SUBLEDGER_FILTER_INVALID");
  return {...context,legalEntityId:entity.id};
}
type Owner = Awaited<ReturnType<typeof subledgerOwner>>;
// Raw identifiers below are finite implementation aliases, never request fields.
export function entityPredicate(owner:Owner,alias:"r"|"p"|"u") {
  const id=Prisma.raw(alias+'."legalEntityId"');
  return Prisma.sql`${id}=${owner.legalEntityId}::uuid AND EXISTS(SELECT 1 FROM "FinanceLegalEntity" e JOIN "Organization" c ON c.id=e."companyId" JOIN "Tenant" t ON t.id=e."tenantId" WHERE e.id=${id} AND e."companyId"=${owner.companyId}::uuid AND e."tenantId"=${owner.tenantId}::uuid AND c."tenantId"=t.id AND e."isActive" AND c."isActive" AND t.status='active')`;
}
export function orderPredicate(owner:Owner,alias:"r"|"u",application=false) {
  const order=Prisma.raw(alias+'."orderId"'),customer=Prisma.raw(alias+'."customerEntityId"');
  return Prisma.sql`EXISTS(SELECT 1 FROM "Order" o WHERE o.id=${order} AND o."tenantId"=${owner.tenantId}::uuid AND o."ownerOrgId"=${owner.companyId}::uuid AND o."customerEntityId" IS NOT DISTINCT FROM ${customer} AND (${customer} IS NULL OR EXISTS(SELECT 1 FROM "CustomerEntity" c WHERE c.id=${customer} AND c."tenantId"=o."tenantId")))`;
}
export function sourcePredicate(owner:Owner,alias:"r"|"p"|"u") {
  const source=Prisma.raw(alias+'."sourceEventId"');
  const paymentIds=alias==="r"?Prisma.sql`AND (a."paymentIntentId" IS NULL OR a."paymentIntentId"=i.id) AND a."paymentRefundId" IS NULL`:Prisma.empty;
  const refundIds=alias==="r"?Prisma.sql`AND (a."paymentRefundId" IS NULL OR a."paymentRefundId"=f.id) AND (a."paymentIntentId" IS NULL OR a."paymentIntentId"=i.id)`:Prisma.empty;
  return Prisma.sql`EXISTS(SELECT 1 FROM "FinanceSourceEvent" s WHERE s."sourceEventId"=${source} AND s."companyId"=${owner.companyId}::uuid AND s."legalEntityId"=${owner.legalEntityId}::uuid)`;
}
export function receivablePredicate(owner:Owner) {
  return Prisma.sql`${entityPredicate(owner,"r")} AND ${orderPredicate(owner,"r")} AND ${sourcePredicate(owner,"r")} AND EXISTS(SELECT 1 FROM "Invoice" i JOIN "FinanceSourceEvent" s ON s."sourceEventId"=r."sourceEventId" AND s."companyId"=i."companyId" AND s."legalEntityId"=r."legalEntityId" WHERE i.id=r."sourceInvoiceId" AND s."sourceId"=i.id::text AND s."eventType"='invoice.issued' AND i."orderId"=r."orderId" AND i."companyId"=${owner.companyId}::uuid AND i."tenantId"=${owner.tenantId}::uuid AND i.currency=r.currency AND i."customerEntityId" IS NOT DISTINCT FROM r."customerEntityId")`;
}
export function payablePredicate(owner:Owner) {
  return Prisma.sql`${entityPredicate(owner,"p")} AND ${sourcePredicate(owner,"p")} AND EXISTS(SELECT 1 FROM "FinanceCarrierBill" b JOIN "IntegrationProvider" c ON c.id=b."carrierProviderId" JOIN "FinanceSourceEvent" s ON s."sourceEventId"=p."sourceEventId" AND s."companyId"=b."companyId" AND s."legalEntityId"=p."legalEntityId" WHERE b.id=p."sourceCarrierBillId" AND s."sourceId"=b.id::text AND s."eventType"='carrier.bill_approved' AND b."legalEntityId"=p."legalEntityId" AND b."companyId"=${owner.companyId}::uuid AND c."companyId"=b."companyId" AND c.domain='carrier' AND b."carrierProviderId"=p."carrierProviderId" AND b."carrierCode"=p."carrierCode" AND c."providerCode"=b."carrierCode" AND b.currency=p.currency)`;
}
export function cashPredicate(owner:Owner) {
  return Prisma.sql`${entityPredicate(owner,"u")} AND ${orderPredicate(owner,"u")} AND ${sourcePredicate(owner,"u")} AND ${paymentSourcePredicate(owner,"u")}`;
}
export function paymentSourcePredicate(owner:Owner,alias:"r"|"u",application=false) {
  const order=Prisma.raw(alias+'."orderId"'),currency=Prisma.raw(alias+'.currency');
  const source=alias==="r"||application?Prisma.raw('a."sourceEventId"'):Prisma.raw('u."sourceEventId"');
  const payment=alias==="r"?Prisma.sql`a.type IN ('payment','unapplied_receipt')`:application?Prisma.sql`a.type='receivable'`:Prisma.sql`u.type='receipt'`;
  const refund=alias==="r"||application?Prisma.sql`a.type='refund'`:Prisma.sql`u.type='refund'`;
  const paymentIds=alias==="r"?Prisma.sql`AND (a."paymentIntentId" IS NULL OR a."paymentIntentId"=i.id) AND a."paymentRefundId" IS NULL`:Prisma.empty;
  const refundIds=alias==="r"?Prisma.sql`AND (a."paymentRefundId" IS NULL OR a."paymentRefundId"=f.id) AND (a."paymentIntentId" IS NULL OR a."paymentIntentId"=i.id)`:Prisma.empty;
  return Prisma.sql`EXISTS(SELECT 1 FROM "FinanceSourceEvent" s WHERE s."sourceEventId"=${source} AND s."companyId"=${owner.companyId}::uuid AND s."legalEntityId"=${owner.legalEntityId}::uuid AND ((${payment} AND s."eventType"='payment.succeeded' AND EXISTS(SELECT 1 FROM "PaymentIntent" i JOIN "PaymentProviderConfig" c ON c.id=i."providerConfigId" WHERE i.id::text=s."sourceId" ${paymentIds} AND i."companyId"=s."companyId" AND i."orderId"=${order} AND i.currency=${currency} AND c."companyId"=i."companyId" AND c.provider=i.provider AND c.environment=i.environment)) OR (${refund} AND s."eventType"='payment.refunded' AND EXISTS(SELECT 1 FROM "PaymentRefund" f JOIN "PaymentIntent" i ON i.id=f."paymentIntentId" JOIN "PaymentProviderConfig" c ON c.id=i."providerConfigId" WHERE f.id::text=s."sourceId" ${refundIds} AND f."companyId"=s."companyId" AND i."companyId"=f."companyId" AND f."orderId"=${order} AND i."orderId"=f."orderId" AND f.currency=${currency} AND i.currency=f.currency AND f.provider=i.provider AND f.environment=i.environment AND c."companyId"=i."companyId" AND c.provider=i.provider AND c.environment=i.environment))))`;
}
export function receivableAllocationPredicate(owner:Owner) {
  return Prisma.sql`${paymentSourcePredicate(owner,"r")} AND a.currency=r.currency AND a.amount>=0 AND EXISTS(SELECT 1 FROM "FinanceSourceEvent" s WHERE s."sourceEventId"=a."sourceEventId" AND s."companyId"=${owner.companyId}::uuid AND s."legalEntityId"=r."legalEntityId") AND (a."paymentIntentId" IS NULL OR EXISTS(SELECT 1 FROM "PaymentIntent" i JOIN "PaymentProviderConfig" c ON c.id=i."providerConfigId" WHERE i.id=a."paymentIntentId" AND i."companyId"=${owner.companyId}::uuid AND i."orderId"=r."orderId" AND i.currency=r.currency AND c."companyId"=i."companyId" AND c.provider=i.provider AND c.environment=i.environment)) AND (a."paymentRefundId" IS NULL OR EXISTS(SELECT 1 FROM "PaymentRefund" f JOIN "PaymentIntent" i ON i.id=f."paymentIntentId" WHERE f.id=a."paymentRefundId" AND f."companyId"=${owner.companyId}::uuid AND i."companyId"=f."companyId" AND f."orderId"=r."orderId" AND i."orderId"=f."orderId" AND f.currency=r.currency AND (a."paymentIntentId" IS NULL OR a."paymentIntentId"=i.id)))`;
}
export function payableAllocationPredicate(owner:Owner) {
  return Prisma.sql`a."legalEntityId" IS NOT NULL AND a."paymentRunLineId" IS NOT NULL AND a."legalEntityId"=p."legalEntityId" AND a.currency=p.currency AND a.amount>=0 AND EXISTS(SELECT 1 FROM "FinancePaymentRunLine" l JOIN "FinancePaymentRun" run ON run.id=l."paymentRunId" JOIN "FinanceBankAccount" bank ON bank.id=run."bankAccountId" WHERE l.id=a."paymentRunLineId" AND l."payableItemId"=p.id AND l."legalEntityId"=p."legalEntityId" AND run."legalEntityId"=p."legalEntityId" AND bank."legalEntityId"=p."legalEntityId" AND run.currency=p.currency AND bank.currency=p.currency AND l.amount=a.amount AND l.status IN ('executed','allocated') AND run.status='executed' AND l."carrierProviderId"=p."carrierProviderId" AND l."carrierCode"=p."carrierCode" AND l."accountingSourceEventId"=a."sourceEventId") AND EXISTS(SELECT 1 FROM "FinanceSourceEvent" s WHERE s."sourceEventId"=a."sourceEventId" AND s."companyId"=${owner.companyId}::uuid AND s."legalEntityId"=p."legalEntityId")`;
}
