import { collectProviderConfigIssues } from "./payment-settings";
export { getCompanyPaymentPolicyForActor, upsertCompanyPaymentPolicyForActor, listProviderConfigsForActor, listAvailableProvidersForActor, upsertProviderConfigForActor, patchProviderConfigForActor, testProviderConfigForActor } from "./payment-settings";
import { acceptPaymentWebhook } from "./payment-webhook";
import { paymentAccess, ownedPaymentIntent, refundOwnership, paymentIntentReadSelect } from "./payment-access";
import { authorityError } from "../../orders-core/domain/creation-authority";
import { createAuthorizedPayment } from "./payment-creation";
import {
  PaymentEnvironment,
  PaymentIntentStatus,
  PaymentProvider,
  PaymentRefundStatus,
  Prisma,
} from "@prisma/client";
import prisma from "../../../config/prismaClient";

import {
  CreatePaymentIntentInput,
  ProviderCode,
  toCanonicalStatus,
} from "../domain/contracts";
import {
  getPaymentProviderAdapter,
  ResolvedProviderConfig,
} from "../infrastructure/providers/providerAdapter";
import { decryptSecret } from "./paymentCrypto";
import type { AppUser } from "../../../types/app-user";


type AuthUser = AppUser;
function assertProviderConfigValid(args: {
  provider: PaymentProvider;
  merchantId?: string | null;
  serviceId?: string | null;
  accountId?: string | null;
  secret?: string | null;
}) {
  const issues = collectProviderConfigIssues(args);
  if (issues.length === 0) return;
  const err = new Error(issues.join("; ")) as Error & { statusCode: number; issues?: string[] };
  err.statusCode = 400;
  err.issues = issues;
  throw err;
}

function toResolvedProviderConfig(
  config: Prisma.PaymentProviderConfigGetPayload<{
    select: {
      id: true;
      companyId: true;
      provider: true;
      environment: true;
      merchantId: true;
      serviceId: true;
      accountId: true;
      isEnabled: true;
      secretEncrypted: true;
    };
  }>,
): ResolvedProviderConfig {
  return {
    id: config.id,
    companyId: config.companyId,
    provider: config.provider,
    environment: config.environment,
    merchantId: config.merchantId,
    serviceId: config.serviceId,
    accountId: config.accountId,
    isEnabled: config.isEnabled,
    secretPlain: decryptSecret(config.secretEncrypted),
  };
}

async function resolveActiveConfig(args: {
  companyId: string;
  provider?: ProviderCode;
  environment?: PaymentEnvironment;
}, db: Pick<Prisma.TransactionClient, "paymentProviderConfig"> = prisma) {
  const where: Prisma.PaymentProviderConfigWhereInput = {
    companyId: args.companyId,
    isEnabled: true,
    ...(args.provider ? { provider: args.provider } : null),
    ...(args.environment ? { environment: args.environment } : null),
  };

  const explicit = await db.paymentProviderConfig.findFirst({
    where,
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      companyId: true,
      provider: true,
      environment: true,
      merchantId: true,
      serviceId: true,
      accountId: true,
      isEnabled: true,
      secretEncrypted: true,
    },
  });
  if (!explicit) {
    const err = new Error("No enabled payment provider config found for company") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  assertProviderConfigValid({
    provider: explicit.provider,
    merchantId: explicit.merchantId,
    serviceId: explicit.serviceId,
    accountId: explicit.accountId,
    secret: decryptSecret(explicit.secretEncrypted),
  });

  return explicit;
}

export async function createPaymentIntentForActor(args: {
  user: AuthUser;
  input: CreatePaymentIntentInput;
}) {
  return createAuthorizedPayment(args, {
    db: prisma,
    resolveConfig: async (context, tx) => toResolvedProviderConfig(await resolveActiveConfig(context, tx)),
    adapter: getPaymentProviderAdapter,
  });
}

function publicPaymentIntentPayload(
  intent: {
    id: string;
    orderId: string;
    companyId: string;
    provider: PaymentProvider;
    providerConfigId: string;
    environment: PaymentEnvironment;
    amountMinor: bigint;
    currency: string;
    status: PaymentIntentStatus;
    providerPaymentId: string | null;
    providerInvoiceId: string | null;
    providerCheckoutUrl: string | null;
    idempotencyKey: string;
    createdAt: Date;
    updatedAt: Date;
  },
  extra?: Record<string, unknown>,
) {
  return {
    id: intent.id,
    orderId: intent.orderId,
    companyId: intent.companyId,
    provider: intent.provider,
    providerConfigId: intent.providerConfigId,
    environment: intent.environment,
    amountMinor: intent.amountMinor.toString(),
    currency: intent.currency,
    status: intent.status,
    statusCanonical: toCanonicalStatus(intent.status),
    providerPaymentId: intent.providerPaymentId,
    providerInvoiceId: intent.providerInvoiceId,
    providerCheckoutUrl: intent.providerCheckoutUrl,
    idempotencyKey: intent.idempotencyKey,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    ...extra,
  };
}

export async function getPaymentIntentForActor(args: { user: AuthUser; id: string }) {
  const {access,intent}=await ownedPaymentIntent(args.user,args.id);
  const attempts=await prisma.paymentAttempt.findMany({where:{paymentIntentId:intent.id,paymentIntent:{is:access.where}},orderBy:{createdAt:"desc"},take:10,
    select:{id:true,provider:true,status:true,createdAt:true,updatedAt:true}});
  return publicPaymentIntentPayload(intent,{attempts});
}

export async function listOrderPaymentIntentsForActor(args: { user: AuthUser; orderId: string }) {
  if(typeof args.orderId!=="string" || !args.orderId.trim())throw authorityError("Order ID required",400);
  const access=await paymentAccess(args.user);
  const order=await prisma.order.findFirst({where:{AND:[access.parent,{id:args.orderId}]},select:{id:true}});
  if(!order)throw authorityError("Order not found",404);
  const intents=await prisma.paymentIntent.findMany({where:{AND:[access.where,{orderId:order.id}]},orderBy:{createdAt:"desc"},take:10,select:paymentIntentReadSelect});
  return {items:intents.map(intent=>publicPaymentIntentPayload(intent))};
}

export async function syncPaymentIntentForActor(args: { user: AuthUser; id: string }): Promise<never> {
  await ownedPaymentIntent(args.user,args.id);
  // A read grant cannot authorize a financial transition. Provider getStatus does
  // not currently establish exact amount/currency or durable reconciliation authority.
  throw Object.assign(authorityError("Payment status synchronization requires verified reconciliation authority",409),{code:"PAYMENT_STATUS_AUTHORITY_REQUIRED"});
}

export async function retryOrderPaymentForActor(args: {
  user: AuthUser;
  orderId: string;
} & Omit<CreatePaymentIntentInput, "orderId">) {
  // Retain the original key and request fields instead of generating a fresh operation.
  const { user, ...input } = args;
  return createPaymentIntentForActor({ user, input });
}

export async function createRefundForActor(args: {
  user: AuthUser; companyId: string; paymentIntentId: string; amountMinor?: bigint; reason?: string; idempotencyKey: string;
}): Promise<never> {
  if(args.companyId!==args.user?.companyId)throw authorityError("Refund company context rejected",403);
  await ownedPaymentIntent(args.user,args.paymentIntentId,"finance.refund");
  // No approved independent checker/immutable refund acceptance or safe uncertain
  // provider recovery contract exists. Never reserve or dispatch unaccepted refunds.
  throw Object.assign(authorityError("Refund execution requires independent durable approval",409),{code:"PAYMENT_REFUND_APPROVAL_REQUIRED"});
}

function publicPaymentRefundPayload(refund: {
  id: string;
  companyId: string;
  paymentIntentId: string;
  orderId: string;
  provider: PaymentProvider;
  environment: PaymentEnvironment;
  amountMinor: bigint;
  currency: string;
  status: PaymentRefundStatus;
  providerRefundId: string | null;
  reason: string | null;
  idempotencyKey: string;
  failureCode: string | null;
  failureMessage: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: refund.id,
    companyId: refund.companyId,
    paymentIntentId: refund.paymentIntentId,
    orderId: refund.orderId,
    provider: refund.provider,
    environment: refund.environment,
    amountMinor: refund.amountMinor.toString(),
    currency: refund.currency,
    status: refund.status,
    providerRefundId: refund.providerRefundId,
    reason: refund.reason,
    idempotencyKey: refund.idempotencyKey,
    failureCode: refund.failureCode,
    failureMessage: refund.failureMessage,
    requestedAt: refund.requestedAt,
    completedAt: refund.completedAt,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
  };
}

export async function listPaymentRefundsForActor(args: { user: AuthUser; paymentIntentId: string }) {
  const {access,intent}=await ownedPaymentIntent(args.user,args.paymentIntentId);
  const refunds=await prisma.paymentRefund.findMany({where:refundOwnership(intent,access.where),orderBy:[{createdAt:"desc"},{id:"desc"}],take:100,
    select:{id:true,companyId:true,paymentIntentId:true,orderId:true,provider:true,environment:true,amountMinor:true,currency:true,status:true,providerRefundId:true,reason:true,idempotencyKey:true,failureCode:true,requestedAt:true,completedAt:true,createdAt:true,updatedAt:true}});
  return {items:refunds.map(refund=>publicPaymentRefundPayload({...refund,failureMessage:refund.status==="failed"?"Refund failed":null}))};
}

export async function handleProviderWebhook(args: {
  provider: PaymentProvider; body: unknown; headers: Record<string, unknown>; rawBody?: string | Buffer;
}) {
  return acceptPaymentWebhook(args, { db: prisma, adapter: getPaymentProviderAdapter, resolve: toResolvedProviderConfig });
}