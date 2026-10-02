import { PaymentEnvironment, PaymentProvider, Prisma } from "@prisma/client";
import prisma from "../../../config/prismaClient";
import type { AppUser } from "../../../types/app-user";
import { requireTenantBoundOrderCompanyAuthority } from "../../orders-core/domain/company-authority";
import { buildOrderScopeWhere } from "../../identity-access/access-control";
import { authorityError } from "../../orders-core/domain/creation-authority";

export const paymentIntentReadSelect = { id:true,orderId:true,companyId:true,provider:true,providerConfigId:true,environment:true,
  amountMinor:true,currency:true,status:true,providerPaymentId:true,providerInvoiceId:true,providerCheckoutUrl:true,idempotencyKey:true,createdAt:true,updatedAt:true } satisfies Prisma.PaymentIntentSelect;

/** Fresh selected company and ordinary order scopes; never all user memberships. */
export async function paymentAccess(actor: AppUser, permission="payments.intents.read") {
  const membership = await requireTenantBoundOrderCompanyAuthority(prisma,actor,permission);
  if (!membership.scopes.length) throw authorityError("Explicit payment object scope required",403);
  const scope = await buildOrderScopeWhere(actor,permission);
  if (!scope || scope.id === "__no_access__" || !membership.tenantId) throw authorityError("Payment scope required",403);
  const parent:Prisma.OrderWhereInput={AND:[{tenantId:membership.tenantId,ownerOrgId:membership.companyId},scope]};
  // Correlate every enum pair explicitly: Prisma cannot compare two relation columns.
  const providerTuple:Prisma.PaymentIntentWhereInput[]=[];
  for(const provider of Object.values(PaymentProvider))for(const environment of Object.values(PaymentEnvironment))providerTuple.push({provider,environment,providerConfig:{is:{provider,environment,companyId:membership.companyId}}});
  const where:Prisma.PaymentIntentWhereInput={companyId:membership.companyId,order:{is:parent},providerConfig:{is:{companyId:membership.companyId,company:{is:{tenantId:membership.tenantId,isActive:true,tenant:{is:{status:"active"}}}}}},OR:providerTuple};
  return {membership,parent,where};
}
export async function ownedPaymentIntent(actor:AppUser,id:string,permission="payments.intents.read") {
  if (typeof id!=="string" || !id.trim()) throw authorityError("Payment intent ID required",400);
  const access=await paymentAccess(actor,permission);
  const intent=await prisma.paymentIntent.findFirst({where:{AND:[access.where,{id}]},select:paymentIntentReadSelect});
  if(!intent)throw authorityError("Payment intent not found",404);
  return {access,intent};
}
export function refundOwnership(intent:Prisma.PaymentIntentGetPayload<{select:typeof paymentIntentReadSelect}>,ownedIntent:Prisma.PaymentIntentWhereInput):Prisma.PaymentRefundWhereInput {
  return {paymentIntentId:intent.id,companyId:intent.companyId,orderId:intent.orderId,currency:intent.currency,provider:intent.provider,environment:intent.environment,paymentIntent:{is:ownedIntent}};
}
