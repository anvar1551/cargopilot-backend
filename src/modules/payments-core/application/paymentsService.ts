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
import { authorize } from "../../identity-access";
import {
  CreatePaymentIntentInput,
  ProviderCode,
  toCanonicalStatus,
} from "../domain/contracts";
import {
  getPaymentProviderAdapter,
  ResolvedProviderConfig,
} from "../infrastructure/providers/providerAdapter";
import { decryptSecret, encryptSecret, maskSecret } from "./paymentCrypto";
import type { AppUser } from "../../../types/app-user";


type AuthUser = AppUser;
function callbackPathForProvider(provider: PaymentProvider) {
  return `/api/payments/${provider.toLowerCase()}/callback`;
}

function isGlobalPaymentsEnabled() {
  return process.env.PAYMENTS_ENABLED === "true";
}

function normalizedOrNull(value: string | null | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

function normalizedOrUndefined(value: string | null | undefined): string | undefined {
  const next = normalizedOrNull(value);
  return next ?? undefined;
}

function collectProviderConfigIssues(args: {
  provider: PaymentProvider;
  merchantId?: string | null;
  serviceId?: string | null;
  accountId?: string | null;
  secret?: string | null;
}) {
  const merchantId = normalizedOrUndefined(args.merchantId);
  const serviceId = normalizedOrUndefined(args.serviceId);
  const accountId = normalizedOrUndefined(args.accountId);
  const secret = normalizedOrUndefined(args.secret);
  const issues: string[] = [];

  if (!secret || secret.length < 4) issues.push("secret is required and must be at least 4 chars");

  if (args.provider === PaymentProvider.CLICK) {
    if (!merchantId) issues.push("merchantId is required for CLICK");
    if (!serviceId) issues.push("serviceId is required for CLICK");
    if (!accountId) issues.push("accountId (merchant_user_id) is required for CLICK");
  }

  if (args.provider === PaymentProvider.PAYME) {
    if (!merchantId) issues.push("merchantId (cashbox ID) is required for PAYME");
  }

  if (args.provider === PaymentProvider.UZUM) {
    if (!serviceId) issues.push("serviceId is required for UZUM");
    if (!accountId) issues.push("accountId (BasicAuth username) is required for UZUM");
  }

  if (args.provider === PaymentProvider.STRIPE) {
    if (!secret?.startsWith("sk_")) {
      issues.push("secret must be a Stripe secret key (sk_...) for STRIPE");
    }
    if (!serviceId?.startsWith("whsec_")) {
      issues.push("serviceId must be Stripe webhook secret (whsec_...) for STRIPE");
    }
  }

  return issues;
}

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

function parseObjectRecord(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof input === "object") return input as Record<string, unknown>;
  return {};
}

function objectStringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
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

async function getBoundOrgIds(userId: string) {
  const memberships = await prisma.companyMembership.findMany({
    where: { userId, status: "active" },
    select: {
      companyId: true,
      scopes: { select: { scopeRefId: true } },
    },
  });
  const ids = new Set<string>();
  for (const membership of memberships) {
    ids.add(membership.companyId);
    for (const scope of membership.scopes) ids.add(scope.scopeRefId);
  }
  return ids;
}

async function assertCompanyAccess(args: {
  user: AuthUser;
  companyId: string;
  permission: string;
}) {
  await authorize(args.user, args.permission);
  const orgIds = await getBoundOrgIds(args.user.id);
  if (orgIds.has(args.companyId)) return;

  const err = new Error("Forbidden for this company") as Error & { statusCode: number };
  err.statusCode = 403;
  throw err;
}

export async function getCompanyPaymentPolicyForActor(args: {
  user: AuthUser;
  companyId?: string;
}) {
  await authorize(args.user, "payments.providers.read");
  const companyId = (args.companyId ?? args.user.companyId ?? "").trim();
  if (!companyId) {
    const err = new Error("companyId is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  await assertCompanyAccess({
    user: args.user,
    companyId,
    permission: "payments.providers.read",
  });

  const setting = await prisma.companyPaymentSetting.findUnique({
    where: { companyId },
    select: {
      id: true,
      companyId: true,
      onlinePaymentsEnabled: true,
      defaultProvider: true,
      allowProviderOverride: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    companyId,
    globalPaymentsEnabled: isGlobalPaymentsEnabled(),
    onlinePaymentsEnabled: setting?.onlinePaymentsEnabled ?? true,
    effectiveOnlinePaymentsEnabled:
      isGlobalPaymentsEnabled() && (setting?.onlinePaymentsEnabled ?? true),
    defaultProvider: setting?.defaultProvider ?? null,
    allowProviderOverride: setting?.allowProviderOverride ?? true,
    createdAt: setting?.createdAt ?? null,
    updatedAt: setting?.updatedAt ?? null,
  };
}

export async function upsertCompanyPaymentPolicyForActor(args: {
  user: AuthUser;
  companyId: string;
  onlinePaymentsEnabled: boolean;
  defaultProvider?: PaymentProvider | null;
  allowProviderOverride?: boolean;
}) {
  await assertCompanyAccess({
    user: args.user,
    companyId: args.companyId,
    permission: "payments.providers.manage",
  });

  const setting = await prisma.companyPaymentSetting.upsert({
    where: { companyId: args.companyId },
    create: {
      companyId: args.companyId,
      onlinePaymentsEnabled: args.onlinePaymentsEnabled,
      defaultProvider: args.defaultProvider ?? null,
      allowProviderOverride: args.allowProviderOverride ?? true,
      createdByUserId: args.user.id,
      updatedByUserId: args.user.id,
    },
    update: {
      onlinePaymentsEnabled: args.onlinePaymentsEnabled,
      defaultProvider: args.defaultProvider ?? null,
      allowProviderOverride: args.allowProviderOverride ?? true,
      updatedByUserId: args.user.id,
    },
    select: {
      id: true,
      companyId: true,
      onlinePaymentsEnabled: true,
      defaultProvider: true,
      allowProviderOverride: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    ...setting,
    globalPaymentsEnabled: isGlobalPaymentsEnabled(),
    effectiveOnlinePaymentsEnabled:
      isGlobalPaymentsEnabled() && setting.onlinePaymentsEnabled,
  };
}

export async function isCompanyOnlinePaymentsAllowed(companyId: string) {
  const setting = await prisma.companyPaymentSetting.findUnique({
    where: { companyId },
    select: {
      onlinePaymentsEnabled: true,
    },
  });
  return isGlobalPaymentsEnabled() && (setting?.onlinePaymentsEnabled ?? true);
}

export async function listProviderConfigsForActor(args: {
  user: AuthUser;
  companyId?: string;
  provider?: PaymentProvider;
  environment?: PaymentEnvironment;
  enabledOnly?: boolean;
}) {
  await authorize(args.user, "payments.providers.read");

  const boundOrgIds = await getBoundOrgIds(args.user.id);
  const allowedCompanyIds = args.companyId
    ? [args.companyId]
    : Array.from(boundOrgIds.values());

  if (allowedCompanyIds.length === 0) return [];

  return prisma.paymentProviderConfig.findMany({
    where: {
      companyId: { in: allowedCompanyIds },
      ...(args.provider ? { provider: args.provider } : null),
      ...(args.environment ? { environment: args.environment } : null),
      ...(args.enabledOnly ? { isEnabled: true } : null),
    },
    orderBy: [{ companyId: "asc" }, { provider: "asc" }, { environment: "asc" }],
    select: {
      id: true,
      companyId: true,
      provider: true,
      environment: true,
      isEnabled: true,
      merchantId: true,
      serviceId: true,
      accountId: true,
      secretMasked: true,
      callbackPath: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function listAvailableProvidersForActor(args: {
  user: AuthUser;
  companyId?: string;
  environment?: PaymentEnvironment;
}) {
  await authorize(args.user, "payments.intents.create");

  const targetCompanyId = (args.companyId ?? args.user.companyId ?? "").trim();
  if (!targetCompanyId) {
    const err = new Error("companyId is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  await assertCompanyAccess({
    user: args.user,
    companyId: targetCompanyId,
    permission: "payments.intents.create",
  });

  const policy = await prisma.companyPaymentSetting.findUnique({
    where: { companyId: targetCompanyId },
    select: {
      onlinePaymentsEnabled: true,
      defaultProvider: true,
      allowProviderOverride: true,
    },
  });
  const effectiveEnabled =
    isGlobalPaymentsEnabled() && (policy?.onlinePaymentsEnabled ?? true);
  if (!effectiveEnabled) return [];

  const rows = await prisma.paymentProviderConfig.findMany({
    where: {
      companyId: targetCompanyId,
      isEnabled: true,
      ...(args.environment ? { environment: args.environment } : null),
    },
    orderBy: [{ provider: "asc" }, { environment: "asc" }],
    select: {
      id: true,
      provider: true,
      environment: true,
      callbackPath: true,
      merchantId: true,
      serviceId: true,
      accountId: true,
      updatedAt: true,
    },
  });

  const mapped = rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    callbackPath: row.callbackPath,
    integrationMode:
      row.provider === PaymentProvider.UZUM ? "webhook" : ("redirect" as "webhook" | "redirect"),
    supportsCheckoutRedirect: row.provider !== PaymentProvider.UZUM,
    configuredFields: {
      merchantId: Boolean(row.merchantId),
      serviceId: Boolean(row.serviceId),
      accountId: Boolean(row.accountId),
    },
    updatedAt: row.updatedAt,
  }));

  if (!policy?.defaultProvider) return mapped;

  const preferred = mapped.filter((item) => item.provider === policy.defaultProvider);
  const others = mapped.filter((item) => item.provider !== policy.defaultProvider);
  return [...preferred, ...others];
}

export async function upsertProviderConfigForActor(args: {
  user: AuthUser;
  companyId: string;
  provider: PaymentProvider;
  environment: PaymentEnvironment;
  isEnabled?: boolean;
  merchantId?: string;
  serviceId?: string;
  accountId?: string;
  secret: string;
}) {
  await assertCompanyAccess({
    user: args.user,
    companyId: args.companyId,
    permission: "payments.providers.manage",
  });

  const merchantId = normalizedOrNull(args.merchantId);
  const serviceId = normalizedOrNull(args.serviceId);
  const accountId = normalizedOrNull(args.accountId);
  const secretRaw = args.secret.trim();

  assertProviderConfigValid({
    provider: args.provider,
    merchantId,
    serviceId,
    accountId,
    secret: secretRaw,
  });

  const secretEncrypted = encryptSecret(secretRaw);
  const secretMasked = maskSecret(secretRaw);

  return prisma.paymentProviderConfig.upsert({
    where: {
      companyId_provider_environment: {
        companyId: args.companyId,
        provider: args.provider,
        environment: args.environment,
      },
    },
    create: {
      companyId: args.companyId,
      provider: args.provider,
      environment: args.environment,
      isEnabled: args.isEnabled ?? true,
      merchantId,
      serviceId,
      accountId,
      secretEncrypted,
      secretMasked,
      callbackPath: callbackPathForProvider(args.provider),
      createdByUserId: args.user.id,
      updatedByUserId: args.user.id,
    },
    update: {
      isEnabled: args.isEnabled ?? true,
      merchantId,
      serviceId,
      accountId,
      secretEncrypted,
      secretMasked,
      callbackPath: callbackPathForProvider(args.provider),
      updatedByUserId: args.user.id,
    },
    select: {
      id: true,
      companyId: true,
      provider: true,
      environment: true,
      isEnabled: true,
      merchantId: true,
      serviceId: true,
      accountId: true,
      secretMasked: true,
      callbackPath: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function patchProviderConfigForActor(args: {
  user: AuthUser;
  id: string;
  isEnabled?: boolean;
  merchantId?: string;
  serviceId?: string;
  accountId?: string;
  secret?: string;
  environment?: PaymentEnvironment;
}) {
  const existing = await prisma.paymentProviderConfig.findUnique({
    where: { id: args.id },
    select: {
      id: true,
      companyId: true,
      provider: true,
      environment: true,
      isEnabled: true,
      merchantId: true,
      serviceId: true,
      accountId: true,
      secretEncrypted: true,
      secretMasked: true,
    },
  });

  if (!existing) {
    const err = new Error("Provider config not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  await assertCompanyAccess({
    user: args.user,
    companyId: existing.companyId,
    permission: "payments.providers.manage",
  });

  const nextSecretRaw = args.secret?.trim();
  const secretEncrypted = nextSecretRaw
    ? encryptSecret(nextSecretRaw)
    : existing.secretEncrypted;
  const secretMasked = nextSecretRaw ? maskSecret(nextSecretRaw) : existing.secretMasked;

  const nextMerchantId =
    args.merchantId === undefined ? existing.merchantId : normalizedOrNull(args.merchantId);
  const nextServiceId =
    args.serviceId === undefined ? existing.serviceId : normalizedOrNull(args.serviceId);
  const nextAccountId =
    args.accountId === undefined ? existing.accountId : normalizedOrNull(args.accountId);
  const nextSecret = nextSecretRaw ?? decryptSecret(secretEncrypted);

  assertProviderConfigValid({
    provider: existing.provider,
    merchantId: nextMerchantId,
    serviceId: nextServiceId,
    accountId: nextAccountId,
    secret: nextSecret,
  });

  return prisma.paymentProviderConfig.update({
    where: { id: existing.id },
    data: {
      isEnabled: args.isEnabled ?? existing.isEnabled,
      merchantId: nextMerchantId,
      serviceId: nextServiceId,
      accountId: nextAccountId,
      environment: args.environment ?? existing.environment,
      secretEncrypted,
      secretMasked,
      updatedByUserId: args.user.id,
    },
    select: {
      id: true,
      companyId: true,
      provider: true,
      environment: true,
      isEnabled: true,
      merchantId: true,
      serviceId: true,
      accountId: true,
      secretMasked: true,
      callbackPath: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function testProviderConfigForActor(args: { user: AuthUser; id: string }) {
  const config = await prisma.paymentProviderConfig.findUnique({
    where: { id: args.id },
    select: {
      id: true,
      companyId: true,
      provider: true,
      environment: true,
      isEnabled: true,
      merchantId: true,
      serviceId: true,
      accountId: true,
      callbackPath: true,
      secretEncrypted: true,
      secretMasked: true,
    },
  });

  if (!config) {
    const err = new Error("Provider config not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  await assertCompanyAccess({
    user: args.user,
    companyId: config.companyId,
    permission: "payments.providers.manage",
  });

  const decryptedSecret = decryptSecret(config.secretEncrypted);
  const issues = collectProviderConfigIssues({
    provider: config.provider,
    merchantId: config.merchantId,
    serviceId: config.serviceId,
    accountId: config.accountId,
    secret: decryptedSecret,
  });
  const healthy = issues.length === 0;

  return {
    id: config.id,
    provider: config.provider,
    environment: config.environment,
    isEnabled: config.isEnabled,
    callbackPath: config.callbackPath,
    merchantId: config.merchantId,
    serviceId: config.serviceId,
    accountId: config.accountId,
    secretMasked: config.secretMasked,
    healthy,
    issues,
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