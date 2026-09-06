import { createAuthorizedPayment } from "./payment-creation";
import {
  CashCollectionEventType,
  CashCollectionKind,
  CashCollectionStatus,
  CashHolderType,
  PaidBy,
  PaidStatus,
  OrderPaymentState,
  PaymentAttemptStatus,
  PaymentEnvironment,
  PaymentIntentStatus,
  PaymentType,
  PaymentProvider,
  PaymentRefundStatus,
  PaymentWebhookProcessStatus,
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
  parsePaymentEnvironment,
  ResolvedProviderConfig,
} from "../infrastructure/providers/providerAdapter";
import { decryptSecret, encryptSecret, maskSecret } from "./paymentCrypto";
import type { AppUser } from "../../../types/app-user";
import {
  createPaymentFailureSupportTicket,
  createPaymentWebhookSupportTicket,
} from "../../support-core/application/autoTriage";
import { enqueueCargoPilotDomainEventTx } from "../../analytics-core/infrastructure/analyticsOutbox";
import { minorToMajorString } from "../shared/money";
import {
  mapProviderRefundStatus,
  paymentStatusAfterSuccessfulRefund,
  resolveRefundAmount,
} from "../domain/refunds";

type AuthUser = AppUser;
type PaymentProviderTransition = {
  id: string;
  orderId: string;
  companyId: string;
  provider: PaymentProvider;
  environment: PaymentEnvironment;
  status: PaymentIntentStatus;
};

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

function nestedObjectField(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
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

function canonicalToIntentStatus(status?: string): PaymentIntentStatus | undefined {
  switch (status) {
    case "requires_action":
      return PaymentIntentStatus.REQUIRES_ACTION;
    case "processing":
      return PaymentIntentStatus.PROCESSING;
    case "succeeded":
      return PaymentIntentStatus.SUCCEEDED;
    case "failed":
      return PaymentIntentStatus.FAILED;
    case "canceled":
      return PaymentIntentStatus.CANCELED;
    case "refunded":
      return PaymentIntentStatus.REFUNDED;
    case "partially_refunded":
      return PaymentIntentStatus.PARTIALLY_REFUNDED;
    case "pending":
      return PaymentIntentStatus.PENDING;
    default:
      return undefined;
  }
}

function mapIntentStatusToOrderPaymentState(status: PaymentIntentStatus): OrderPaymentState {
  switch (status) {
    case PaymentIntentStatus.SUCCEEDED:
      return OrderPaymentState.PAID;
    case PaymentIntentStatus.REFUNDED:
    case PaymentIntentStatus.PARTIALLY_REFUNDED:
      return OrderPaymentState.REFUNDED;
    case PaymentIntentStatus.FAILED:
    case PaymentIntentStatus.CANCELED:
      return OrderPaymentState.FAILED;
    case PaymentIntentStatus.PENDING:
    case PaymentIntentStatus.REQUIRES_ACTION:
    case PaymentIntentStatus.PROCESSING:
    default:
      return OrderPaymentState.PENDING;
  }
}

async function reconcileOrderServiceChargeAfterOnlinePayment(
  tx: Prisma.TransactionClient,
  args: {
    orderId: string;
    intentStatus: PaymentIntentStatus;
    actorId?: string | null;
  },
) {
  if (args.intentStatus !== PaymentIntentStatus.SUCCEEDED) return;

  const order = await tx.order.findUnique({
    where: { id: args.orderId },
    select: {
      id: true,
      paymentType: true,
      serviceCharge: true,
      serviceChargePaidStatus: true,
      deliveryChargePaidBy: true,
      currency: true,
    },
  });
  if (!order) return;

  const isOnlinePayment =
    order.paymentType === PaymentType.CARD || order.paymentType === PaymentType.TRANSFER;
  if (!isOnlinePayment) return;

  const serviceChargeAmount = Number(order.serviceCharge ?? 0);
  if (!Number.isFinite(serviceChargeAmount) || serviceChargeAmount <= 0) return;

  const serviceChargeExpectedFromSender =
    order.deliveryChargePaidBy === PaidBy.SENDER ||
    order.deliveryChargePaidBy === PaidBy.RECIPIENT;
  if (!serviceChargeExpectedFromSender) return;

  const now = new Date();
  const existing = await tx.cashCollection.findUnique({
    where: {
      orderId_kind: {
        orderId: order.id,
        kind: CashCollectionKind.service_charge,
      },
    },
    select: {
      id: true,
      status: true,
      expectedAmount: true,
      collectedAmount: true,
      currency: true,
      currentHolderType: true,
      currentHolderUserId: true,
      currentHolderWarehouseId: true,
      currentHolderLabel: true,
      collectedAt: true,
    },
  });

  const settledAmount = Number(
    existing?.collectedAmount ?? existing?.expectedAmount ?? serviceChargeAmount,
  );
  const nextAmount =
    Number.isFinite(settledAmount) && settledAmount > 0 ? settledAmount : serviceChargeAmount;

  if (!existing) {
    await tx.cashCollection.create({
      data: {
        orderId: order.id,
        kind: CashCollectionKind.service_charge,
        status: CashCollectionStatus.settled,
        expectedAmount: serviceChargeAmount,
        collectedAmount: nextAmount,
        currency: order.currency ?? "UZS",
        currentHolderType: CashHolderType.finance,
        currentHolderLabel: "Online payment",
        collectedAt: now,
        settledAt: now,
        events: {
          create: {
            eventType: CashCollectionEventType.settled,
            amount: nextAmount,
            note: "Service charge settled via online payment provider",
            actorId: args.actorId ?? null,
            actorRole: null,
            toHolderType: CashHolderType.finance,
            toHolderName: "Online payment",
          },
        },
      },
    });
  } else if (existing.status !== CashCollectionStatus.settled) {
    await tx.cashCollection.update({
      where: { id: existing.id },
      data: {
        status: CashCollectionStatus.settled,
        expectedAmount:
          Number.isFinite(Number(existing.expectedAmount)) && Number(existing.expectedAmount) > 0
            ? Number(existing.expectedAmount)
            : serviceChargeAmount,
        collectedAmount: nextAmount,
        currency: existing.currency ?? order.currency ?? "UZS",
        currentHolderType: CashHolderType.finance,
        currentHolderUserId: null,
        currentHolderWarehouseId: null,
        currentHolderLabel: "Online payment",
        collectedAt: existing.collectedAt ?? now,
        settledAt: now,
        events: {
          create: {
            eventType: CashCollectionEventType.settled,
            amount: nextAmount,
            note: "Service charge settled via online payment provider",
            fromHolderType: existing.currentHolderType,
            fromHolderId: existing.currentHolderUserId ?? existing.currentHolderWarehouseId ?? null,
            fromHolderName: existing.currentHolderLabel ?? null,
            toHolderType: CashHolderType.finance,
            toHolderName: "Online payment",
            actorId: args.actorId ?? null,
            actorRole: null,
          },
        },
      },
    });
  }

  if (order.serviceChargePaidStatus !== PaidStatus.PAID) {
    await tx.order.update({
      where: { id: order.id },
      data: {
        serviceChargePaidStatus: PaidStatus.PAID,
      },
    });
  }
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

async function applyPaymentIntentProviderStatus(
  tx: Prisma.TransactionClient,
  args: {
    intentId: string;
    provider: PaymentProvider;
    status: PaymentIntentStatus;
    providerPaymentId?: string | null;
    providerInvoiceId?: string | null;
    checkoutUrl?: string | null;
    requestJson?: Prisma.InputJsonValue;
    responseJson?: Prisma.InputJsonValue;
    actorId?: string | null;
  },
) {
  const priorIntent = await tx.paymentIntent.findUniqueOrThrow({
    where: { id: args.intentId },
    select: {
      id: true,
      orderId: true,
      companyId: true,
      status: true,
      amountMinor: true,
      currency: true,
      metadataJson: true,
    },
  });
  const updatedIntent = await tx.paymentIntent.update({
    where: { id: args.intentId },
    data: {
      status: args.status,
      ...(args.providerPaymentId !== undefined
        ? { providerPaymentId: args.providerPaymentId }
        : null),
      ...(args.providerInvoiceId !== undefined
        ? { providerInvoiceId: args.providerInvoiceId }
        : null),
      ...(args.checkoutUrl !== undefined
        ? { providerCheckoutUrl: args.checkoutUrl }
        : null),
    },
    select: {
      orderId: true,
      companyId: true,
      id: true,
      provider: true,
      environment: true,
      status: true,
      amountMinor: true,
      currency: true,
      metadataJson: true,
    },
  });

  await tx.order.update({
    where: { id: updatedIntent.orderId },
    data: {
      paymentState: mapIntentStatusToOrderPaymentState(updatedIntent.status),
    },
  });

  await reconcileOrderServiceChargeAfterOnlinePayment(tx, {
    orderId: updatedIntent.orderId,
    intentStatus: updatedIntent.status,
    actorId: args.actorId ?? null,
  });

  await tx.paymentAttempt.create({
    data: {
      paymentIntentId: args.intentId,
      provider: args.provider,
      status:
        args.status === PaymentIntentStatus.FAILED ||
        args.status === PaymentIntentStatus.CANCELED
          ? PaymentAttemptStatus.REJECTED
          : PaymentAttemptStatus.ACCEPTED,
      requestJson: args.requestJson,
      responseJson: args.responseJson,
    },
  });

  if (
    priorIntent.status !== PaymentIntentStatus.SUCCEEDED &&
    updatedIntent.status === PaymentIntentStatus.SUCCEEDED
  ) {
    const metadata = updatedIntent.metadataJson && typeof updatedIntent.metadataJson === "object"
      ? updatedIntent.metadataJson as Record<string, unknown>
      : {};
    const fxRate = typeof metadata.fxRate === "string" || typeof metadata.fxRate === "number"
      ? String(metadata.fxRate)
      : "1";
    const occurredAt = new Date();
    const sourceEventId = `payment:${updatedIntent.id}:succeeded`;
    await enqueueCargoPilotDomainEventTx(tx, {
      id: `finance:${sourceEventId}`,
      type: "finance_source_event",
      tenantScope: `company:${updatedIntent.companyId}`,
      entityId: updatedIntent.orderId,
      occurredAt: occurredAt.toISOString(),
      payload: {
        schemaVersion: 1,
        sourceEventId,
        companyId: updatedIntent.companyId,
        sourceType: "payment",
        eventType: "payment.succeeded",
        sourceId: updatedIntent.id,
        actorUserId: args.actorId ?? null,
        occurredAt: occurredAt.toISOString(),
        documentDate: occurredAt.toISOString(),
        postingDate: occurredAt.toISOString(),
        currency: updatedIntent.currency,
        fxRate,
        fxRateAsOf:
          typeof metadata.fxRateAsOf === "string" ? metadata.fxRateAsOf : null,
        amounts: {
          gross_amount: minorToMajorString(updatedIntent.amountMinor, updatedIntent.currency),
        },
        dimensions: { orderId: updatedIntent.orderId },
        attributes: {
          provider: updatedIntent.provider,
          environment: updatedIntent.environment,
        },
        description: `Online payment confirmed for order ${updatedIntent.orderId}`,
        metadata: {
          paymentIntentId: updatedIntent.id,
          providerPaymentId: args.providerPaymentId ?? null,
          pricingSource: metadata.pricingSource ?? null,
          baseCurrency: metadata.baseCurrency ?? null,
        },
      },
    });
  }

  return updatedIntent;
}

export async function getPaymentIntentForActor(args: { user: AuthUser; id: string }) {
  await authorize(args.user, "payments.intents.read");

  const intent = await prisma.paymentIntent.findUnique({
    where: { id: args.id },
    include: {
      attempts: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      providerConfig: {
        select: {
          id: true,
          provider: true,
          environment: true,
          merchantId: true,
          serviceId: true,
          accountId: true,
          secretMasked: true,
          callbackPath: true,
        },
      },
    },
  });

  if (!intent) {
    const err = new Error("Payment intent not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  await assertCompanyAccess({
    user: args.user,
    companyId: intent.companyId,
    permission: "payments.intents.read",
  });

  return {
    ...intent,
    amountMinor: intent.amountMinor.toString(),
    statusCanonical: toCanonicalStatus(intent.status),
  };
}

export async function listOrderPaymentIntentsForActor(args: {
  user: AuthUser;
  orderId: string;
}) {
  await authorize(args.user, "payments.intents.read");

  const order = await prisma.order.findUnique({
    where: { id: args.orderId },
    select: {
      id: true,
      ownerOrgId: true,
    },
  });

  if (!order) {
    const err = new Error("Order not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  const companyId = order.ownerOrgId;
  if (!companyId) {
    const err = new Error("Order does not have a company scope") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  await assertCompanyAccess({
    user: args.user,
    companyId,
    permission: "payments.intents.read",
  });

  const intents = await prisma.paymentIntent.findMany({
    where: {
      orderId: order.id,
      companyId,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      orderId: true,
      companyId: true,
      provider: true,
      providerConfigId: true,
      environment: true,
      amountMinor: true,
      currency: true,
      status: true,
      providerPaymentId: true,
      providerInvoiceId: true,
      providerCheckoutUrl: true,
      idempotencyKey: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    items: intents.map((intent) => publicPaymentIntentPayload(intent)),
  };
}

export async function syncPaymentIntentForActor(args: { user: AuthUser; id: string }) {
  await authorize(args.user, "payments.intents.read");

  const intent = await prisma.paymentIntent.findUnique({
    where: { id: args.id },
    include: {
      providerConfig: true,
    },
  });

  if (!intent) {
    const err = new Error("Payment intent not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  await assertCompanyAccess({
    user: args.user,
    companyId: intent.companyId,
    permission: "payments.intents.read",
  });

  const resolvedConfig = toResolvedProviderConfig({
    id: intent.providerConfig.id,
    companyId: intent.providerConfig.companyId,
    provider: intent.providerConfig.provider,
    environment: intent.providerConfig.environment,
    merchantId: intent.providerConfig.merchantId,
    serviceId: intent.providerConfig.serviceId,
    accountId: intent.providerConfig.accountId,
    isEnabled: intent.providerConfig.isEnabled,
    secretEncrypted: intent.providerConfig.secretEncrypted,
  });

  if (!resolvedConfig.isEnabled) {
    const err = new Error("Payment provider config is disabled") as Error & {
      statusCode: number;
    };
    err.statusCode = 409;
    throw err;
  }

  const adapter = getPaymentProviderAdapter(intent.provider);
  const providerStatus = await adapter.getStatus({
    config: resolvedConfig,
    intent,
  });
  const nextStatus = canonicalToIntentStatus(providerStatus.status) ?? intent.status;

  const transition = await prisma.$transaction((tx) =>
    applyPaymentIntentProviderStatus(tx, {
      intentId: intent.id,
      provider: intent.provider,
      status: nextStatus,
      providerPaymentId: providerStatus.providerPaymentId,
      providerInvoiceId: providerStatus.providerInvoiceId,
      checkoutUrl: providerStatus.checkoutUrl,
      requestJson: {
        source: "manual_provider_status_sync",
        provider: intent.provider,
      } as Prisma.InputJsonValue,
      responseJson: (providerStatus.rawResponse ?? null) as Prisma.InputJsonValue,
      actorId: args.user.id,
    }),
  );

  if (
    transition.status === PaymentIntentStatus.FAILED ||
    transition.status === PaymentIntentStatus.CANCELED
  ) {
    void createPaymentFailureSupportTicket({
      orderId: transition.orderId,
      companyId: transition.companyId,
      paymentIntentId: transition.id,
      provider: transition.provider,
      environment: transition.environment,
      status: transition.status,
      reason: "Manual provider status sync returned a failed payment state",
    }).catch(() => undefined);
  }

  const refreshed = await prisma.paymentIntent.findUniqueOrThrow({
    where: { id: intent.id },
  });

  return {
    paymentIntent: publicPaymentIntentPayload(refreshed),
    providerStatus: providerStatus.status,
    providerResponse: providerStatus.rawResponse ?? null,
  };
}

export async function retryOrderPaymentForActor(args: {
  user: AuthUser;
  orderId: string;
} & Omit<CreatePaymentIntentInput, "orderId">) {
  // Retain the original key and request fields instead of generating a fresh operation.
  const { user, ...input } = args;
  return createPaymentIntentForActor({ user, input });
}

export async function createRefundForActor(_args: {
  user: AuthUser;
  companyId: string;
  paymentIntentId: string;
  amountMinor?: bigint;
  reason?: string;
  idempotencyKey: string;
}) {
  const args = _args;
  await assertCompanyAccess({
    user: args.user,
    companyId: args.companyId,
    permission: "finance.refund",
  });

  const intent = await prisma.paymentIntent.findUnique({
    where: { id: args.paymentIntentId },
    include: {
      providerConfig: true,
      order: { select: { customerEntityId: true } },
      refunds: {
        where: { status: PaymentRefundStatus.succeeded },
        select: { amountMinor: true },
      },
    },
  });
  if (!intent) {
    const err = new Error("Payment intent not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  if (intent.companyId !== args.companyId) {
    const err = new Error("Payment intent does not belong to this company") as Error & {
      statusCode: number;
    };
    err.statusCode = 403;
    throw err;
  }

  const existing = await prisma.paymentRefund.findUnique({
    where: {
      companyId_idempotencyKey: {
        companyId: args.companyId,
        idempotencyKey: args.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (existing.paymentIntentId !== intent.id ||
      (args.amountMinor !== undefined && existing.amountMinor !== args.amountMinor)) {
      const err = new Error("Refund idempotency key was already used for another request") as Error & {
        statusCode: number;
      };
      err.statusCode = 409;
      throw err;
    }
    return publicPaymentRefundPayload(existing);
  }

  if (
    intent.status !== PaymentIntentStatus.SUCCEEDED &&
    intent.status !== PaymentIntentStatus.PARTIALLY_REFUNDED
  ) {
    const err = new Error("Only a confirmed payment can be refunded") as Error & {
      statusCode: number;
    };
    err.statusCode = 409;
    throw err;
  }
  if (!intent.providerConfig.isEnabled) {
    const err = new Error("Payment provider config is disabled") as Error & {
      statusCode: number;
    };
    err.statusCode = 409;
    throw err;
  }

  let requestedAmountMinor: bigint;
  try {
    requestedAmountMinor = resolveRefundAmount({
      paidAmountMinor: intent.amountMinor,
      reservedRefundAmountsMinor: intent.refunds.map((refund) => refund.amountMinor),
      requestedAmountMinor: args.amountMinor,
    }).amountMinor;
  } catch {
    const err = new Error("Refund amount exceeds the remaining refundable amount") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  let refund;
  try {
    refund = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${intent.id}, 0))`,
      );

      const raced = await tx.paymentRefund.findUnique({
        where: {
          companyId_idempotencyKey: {
            companyId: args.companyId,
            idempotencyKey: args.idempotencyKey,
          },
        },
      });
      if (raced) {
        if (
          raced.paymentIntentId !== intent.id ||
          raced.amountMinor !== requestedAmountMinor
        ) {
          throw Object.assign(
            new Error("Refund idempotency key was already used for another request"),
            { statusCode: 409 },
          );
        }
        return raced;
      }

      const reserved = await tx.paymentRefund.findMany({
        where: {
          paymentIntentId: intent.id,
          status: {
            in: [
              PaymentRefundStatus.requested,
              PaymentRefundStatus.processing,
              PaymentRefundStatus.succeeded,
            ],
          },
        },
        select: { amountMinor: true },
      });
      const amountMinor = resolveRefundAmount({
        paidAmountMinor: intent.amountMinor,
        reservedRefundAmountsMinor: reserved.map((item) => item.amountMinor),
        requestedAmountMinor: args.amountMinor,
      }).amountMinor;

      return tx.paymentRefund.create({
        data: {
          companyId: args.companyId,
          paymentIntentId: intent.id,
          orderId: intent.orderId,
          provider: intent.provider,
          environment: intent.environment,
          amountMinor,
          currency: intent.currency,
          status: PaymentRefundStatus.requested,
          reason: normalizedOrNull(args.reason),
          idempotencyKey: args.idempotencyKey,
          requestedByUserId: args.user.id,
        },
      });
    });
  } catch (error) {
    if (error instanceof RangeError) {
      const err = new Error("Refund amount exceeds the remaining refundable amount") as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.paymentRefund.findUnique({
        where: {
          companyId_idempotencyKey: {
            companyId: args.companyId,
            idempotencyKey: args.idempotencyKey,
          },
        },
      });
      if (raced) {
        if (
          raced.paymentIntentId !== intent.id ||
          raced.amountMinor !== requestedAmountMinor
        ) {
          const err = new Error(
            "Refund idempotency key was already used for another request",
          ) as Error & { statusCode: number };
          err.statusCode = 409;
          throw err;
        }
        return publicPaymentRefundPayload(raced);
      }
    }
    throw error;
  }

  const adapter = getPaymentProviderAdapter(intent.provider);
  const amountMinor = refund.amountMinor;
  let providerResult;
  try {
    providerResult = await adapter.refund({
      config: toResolvedProviderConfig({
        id: intent.providerConfig.id,
        companyId: intent.providerConfig.companyId,
        provider: intent.providerConfig.provider,
        environment: intent.providerConfig.environment,
        merchantId: intent.providerConfig.merchantId,
        serviceId: intent.providerConfig.serviceId,
        accountId: intent.providerConfig.accountId,
        isEnabled: intent.providerConfig.isEnabled,
        secretEncrypted: intent.providerConfig.secretEncrypted,
      }),
      intent,
      amountMinor,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
    });
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : "Payment provider refund failed";
    const failed = await prisma.paymentRefund.update({
      where: { id: refund.id },
      data: {
        status: PaymentRefundStatus.failed,
        failureCode: "PROVIDER_REQUEST_FAILED",
        failureMessage,
        completedAt: new Date(),
      },
    });
    return publicPaymentRefundPayload(failed);
  }

  const nextRefundStatus = mapProviderRefundStatus(providerResult.status);
  const providerResponse = providerResult.rawResponse == null
    ? Prisma.JsonNull
    : providerResult.rawResponse as Prisma.InputJsonValue;

  const finalized = await prisma.$transaction(async (tx) => {
    const updatedRefund = await tx.paymentRefund.update({
      where: { id: refund.id },
      data: {
        status: nextRefundStatus,
        providerRefundId: providerResult.providerRefundId ?? null,
        providerResponseJson: providerResponse,
        failureCode:
          nextRefundStatus === PaymentRefundStatus.failed ? "PROVIDER_REFUND_REJECTED" : null,
        failureMessage:
          nextRefundStatus === PaymentRefundStatus.failed
            ? "Provider did not confirm the refund"
            : null,
        completedAt:
          nextRefundStatus === PaymentRefundStatus.succeeded ||
          nextRefundStatus === PaymentRefundStatus.failed ||
          nextRefundStatus === PaymentRefundStatus.cancelled
            ? new Date()
            : null,
      },
    });

    if (nextRefundStatus !== PaymentRefundStatus.succeeded) return updatedRefund;

    const successfulRefunds = await tx.paymentRefund.aggregate({
      where: {
        paymentIntentId: intent.id,
        status: PaymentRefundStatus.succeeded,
      },
      _sum: { amountMinor: true },
    });
    const refundedTotal = successfulRefunds._sum.amountMinor ?? 0n;
    const nextIntentStatus = paymentStatusAfterSuccessfulRefund(
      intent.amountMinor,
      refundedTotal,
    );
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: { status: nextIntentStatus },
    });
    await tx.order.update({
      where: { id: intent.orderId },
      data: { paymentState: mapIntentStatusToOrderPaymentState(nextIntentStatus) },
    });
    await tx.paymentLedgerEntry.create({
      data: {
        companyId: intent.companyId,
        paymentIntentId: intent.id,
        orderId: intent.orderId,
        entryType: "refund",
        amountMinor,
        currency: intent.currency,
        provider: intent.provider,
        reference: providerResult.providerRefundId ?? updatedRefund.id,
        occurredAt: updatedRefund.completedAt ?? new Date(),
      },
    });

    const metadata = intent.metadataJson && typeof intent.metadataJson === "object"
      ? intent.metadataJson as Record<string, unknown>
      : {};
    const occurredAt = updatedRefund.completedAt ?? new Date();
    const sourceEventId = `refund:${updatedRefund.id}:succeeded`;
    await enqueueCargoPilotDomainEventTx(tx, {
      id: `finance:${sourceEventId}`,
      type: "finance_source_event",
      tenantScope: `company:${intent.companyId}`,
      entityId: intent.orderId,
      occurredAt: occurredAt.toISOString(),
      payload: {
        schemaVersion: 1,
        sourceEventId,
        companyId: intent.companyId,
        sourceType: "refund",
        eventType: "payment.refunded",
        sourceId: updatedRefund.id,
        actorUserId: args.user.id,
        occurredAt: occurredAt.toISOString(),
        documentDate: occurredAt.toISOString(),
        postingDate: occurredAt.toISOString(),
        currency: intent.currency,
        fxRate:
          typeof metadata.fxRate === "string" || typeof metadata.fxRate === "number"
            ? String(metadata.fxRate)
            : "1",
        fxRateAsOf: typeof metadata.fxRateAsOf === "string" ? metadata.fxRateAsOf : null,
        amounts: {
          refund_amount: minorToMajorString(amountMinor, intent.currency),
        },
        dimensions: {
          orderId: intent.orderId,
          customerEntityId: intent.order.customerEntityId ?? undefined,
        },
        attributes: {
          provider: intent.provider,
          environment: intent.environment,
          refundType: nextIntentStatus === PaymentIntentStatus.REFUNDED ? "full" : "partial",
        },
        description: `Payment refund confirmed for order ${intent.orderId}`,
        metadata: {
          paymentIntentId: intent.id,
          paymentRefundId: updatedRefund.id,
          providerRefundId: providerResult.providerRefundId ?? null,
          reason: updatedRefund.reason,
          baseCurrency: metadata.baseCurrency ?? null,
        },
      },
    });

    return updatedRefund;
  });

  return publicPaymentRefundPayload(finalized);
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

export async function listPaymentRefundsForActor(args: {
  user: AuthUser;
  paymentIntentId: string;
}) {
  await authorize(args.user, "payments.intents.read");
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: args.paymentIntentId },
    select: { id: true, companyId: true },
  });
  if (!intent) {
    const err = new Error("Payment intent not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  await assertCompanyAccess({
    user: args.user,
    companyId: intent.companyId,
    permission: "payments.intents.read",
  });
  const refunds = await prisma.paymentRefund.findMany({
    where: { paymentIntentId: intent.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return { items: refunds.map(publicPaymentRefundPayload) };
}

async function resolveWebhookContext(args: {
  provider: PaymentProvider;
  bodyRecord: Record<string, unknown>;
  environment: PaymentEnvironment;
}) {
  const paymentIntentId = objectStringField(args.bodyRecord, "paymentIntentId");
  const merchantTransId = objectStringField(args.bodyRecord, "merchant_trans_id");
  const uzumTransId = objectStringField(args.bodyRecord, "transId");
  const uzumParams = parseObjectRecord(args.bodyRecord.params);
  const uzumOrderId =
    objectStringField(uzumParams, "order_id") ||
    objectStringField(uzumParams, "paymentIntentId") ||
    objectStringField(uzumParams, "payment_intent_id");
  const paramsRecord = parseObjectRecord(args.bodyRecord.params);
  const accountRecord = parseObjectRecord(paramsRecord.account);
  const paymeOrderId =
    objectStringField(accountRecord, "order_id") ||
    objectStringField(accountRecord, "paymentIntentId") ||
    objectStringField(accountRecord, "payment_intent_id");
  const stripeEventData = nestedObjectField(args.bodyRecord, "data");
  const stripeEventObject = nestedObjectField(stripeEventData, "object");
  const stripeEventMetadata = nestedObjectField(stripeEventObject, "metadata");
  const stripeEventType = objectStringField(args.bodyRecord, "type") ?? "";
  const stripePaymentIntentRef = objectStringField(stripeEventObject, "payment_intent");
  const stripeIntentIdFromMetadata = objectStringField(
    stripeEventMetadata,
    "paymentIntentId",
  );
  const stripeIntentIdFromClientRef = objectStringField(
    stripeEventObject,
    "client_reference_id",
  );
  const stripeOrderIdFromMetadata = objectStringField(stripeEventMetadata, "orderId");
  const stripeCompanyIdFromMetadata = objectStringField(
    stripeEventMetadata,
    "companyId",
  );
  let intent = null as null | Prisma.PaymentIntentGetPayload<{
    include: { providerConfig: true };
  }>;

  if (paymentIntentId) {
    intent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { providerConfig: true },
    });
  }
  if (!intent && args.provider === PaymentProvider.CLICK && merchantTransId) {
    intent = await prisma.paymentIntent.findUnique({
      where: { id: merchantTransId },
      include: { providerConfig: true },
    });
  }
  if (!intent && args.provider === PaymentProvider.PAYME && paymeOrderId) {
    intent = await prisma.paymentIntent.findUnique({
      where: { id: paymeOrderId },
      include: { providerConfig: true },
    });
  }
  if (!intent && args.provider === PaymentProvider.UZUM && uzumOrderId) {
    intent = await prisma.paymentIntent.findUnique({
      where: { id: uzumOrderId },
      include: { providerConfig: true },
    });
  }
  if (!intent && args.provider === PaymentProvider.UZUM && uzumTransId) {
    intent = await prisma.paymentIntent.findFirst({
      where: {
        OR: [{ providerPaymentId: uzumTransId }, { providerInvoiceId: uzumTransId }],
      },
      include: { providerConfig: true },
    });
  }
  if (
    !intent &&
    args.provider === PaymentProvider.STRIPE &&
    stripeIntentIdFromMetadata
  ) {
    intent = await prisma.paymentIntent.findUnique({
      where: { id: stripeIntentIdFromMetadata },
      include: { providerConfig: true },
    });
  }
  if (
    !intent &&
    args.provider === PaymentProvider.STRIPE &&
    stripeIntentIdFromClientRef
  ) {
    intent = await prisma.paymentIntent.findUnique({
      where: { id: stripeIntentIdFromClientRef },
      include: { providerConfig: true },
    });
  }
  if (
    !intent &&
    args.provider === PaymentProvider.STRIPE &&
    stripePaymentIntentRef &&
    stripeEventType.startsWith("payment_intent.")
  ) {
    intent = await prisma.paymentIntent.findFirst({
      where: { providerPaymentId: stripePaymentIntentRef },
      include: { providerConfig: true },
    });
  }
  if (
    !intent &&
    args.provider === PaymentProvider.STRIPE &&
    stripeOrderIdFromMetadata
  ) {
    intent = await prisma.paymentIntent.findFirst({
      where: { orderId: stripeOrderIdFromMetadata },
      orderBy: { createdAt: "desc" },
      include: { providerConfig: true },
    });
  }

  if (intent?.providerConfig) {
    return {
      intent,
      config: toResolvedProviderConfig({
        id: intent.providerConfig.id,
        companyId: intent.providerConfig.companyId,
        provider: intent.providerConfig.provider,
        environment: intent.providerConfig.environment,
        merchantId: intent.providerConfig.merchantId,
        serviceId: intent.providerConfig.serviceId,
        accountId: intent.providerConfig.accountId,
        isEnabled: intent.providerConfig.isEnabled,
        secretEncrypted: intent.providerConfig.secretEncrypted,
      }),
    };
  }

  const companyId =
    objectStringField(args.bodyRecord, "companyId") || stripeCompanyIdFromMetadata;
  if (!companyId) {
    const err = new Error("Webhook payload does not identify company/payment intent") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }

  const config = await resolveActiveConfig({
    companyId,
    provider: args.provider,
    environment: args.environment,
  });
  return { intent: null, config: toResolvedProviderConfig(config) };
}

export async function handleProviderWebhook(args: {
  provider: PaymentProvider;
  body: unknown;
  headers: Record<string, unknown>;
  rawBody?: string | Buffer;
}) {
  const bodyRecord = parseObjectRecord(args.body);
  const stripeLiveMode = bodyRecord["livemode"];
  const environment =
    args.provider === PaymentProvider.STRIPE && typeof stripeLiveMode === "boolean"
      ? stripeLiveMode
        ? PaymentEnvironment.PRODUCTION
        : PaymentEnvironment.TEST
      : parsePaymentEnvironment(objectStringField(bodyRecord, "environment"));
  const { intent, config } = await resolveWebhookContext({
    provider: args.provider,
    bodyRecord,
    environment,
  });

  const adapter = getPaymentProviderAdapter(args.provider);
  const verification = await adapter.verifyWebhook({
    provider: args.provider,
    environment,
    body: bodyRecord,
    headers: args.headers as Record<string, string | string[] | undefined>,
    config,
    intent,
    rawBody: args.rawBody,
  });

  const mappedIntentStatus = canonicalToIntentStatus(verification.mappedStatus);
  const intentId = intent?.id ?? objectStringField(bodyRecord, "paymentIntentId") ?? null;

  const { webhookEvent, providerTransition } = await prisma.$transaction(async (tx) => {
    let transition: PaymentProviderTransition | null = null;
    const event = await tx.paymentWebhookEvent.upsert({
      where: {
        provider_environment_idempotencyKey: {
          provider: args.provider,
          environment,
          idempotencyKey: verification.idempotencyKey,
        },
      },
      create: {
        companyId: intent?.companyId ?? config.companyId,
        provider: args.provider,
        environment,
        externalEventId: verification.externalEventId,
        idempotencyKey: verification.idempotencyKey,
        signatureValid: verification.isValid,
        processStatus: verification.isValid
          ? PaymentWebhookProcessStatus.PROCESSED
          : PaymentWebhookProcessStatus.FAILED,
        headersJson: args.headers as Prisma.InputJsonValue,
        payloadJson: bodyRecord as Prisma.InputJsonValue,
        paymentIntentId: intentId,
        processedAt: verification.isValid ? new Date() : null,
        errorMessage: verification.isValid ? null : "Webhook signature validation failed",
      },
      update: {
        signatureValid: verification.isValid,
        processStatus: verification.isValid
          ? PaymentWebhookProcessStatus.PROCESSED
          : PaymentWebhookProcessStatus.FAILED,
        headersJson: args.headers as Prisma.InputJsonValue,
        payloadJson: bodyRecord as Prisma.InputJsonValue,
        externalEventId: verification.externalEventId,
        processedAt: verification.isValid ? new Date() : null,
        errorMessage: verification.isValid ? null : "Webhook signature validation failed",
      },
    });

    if (verification.isValid && intentId && mappedIntentStatus) {
      transition = await applyPaymentIntentProviderStatus(tx, {
        intentId,
        provider: args.provider,
        status: mappedIntentStatus,
        providerPaymentId: verification.providerPaymentId,
        requestJson: bodyRecord as Prisma.InputJsonValue,
        responseJson: verification.responsePayload as Prisma.InputJsonValue,
      });
    }

    return { webhookEvent: event, providerTransition: transition };
  });

  if (!verification.isValid) {
    void createPaymentWebhookSupportTicket({
      companyId: intent?.companyId ?? config.companyId,
      provider: args.provider,
      environment,
      idempotencyKey: verification.idempotencyKey,
      reason: "Webhook signature validation failed",
      paymentIntentId: intentId,
    }).catch(() => undefined);
  } else if (
    providerTransition &&
    (providerTransition.status === PaymentIntentStatus.FAILED ||
      providerTransition.status === PaymentIntentStatus.CANCELED)
  ) {
    void createPaymentFailureSupportTicket({
      orderId: providerTransition.orderId,
      companyId: providerTransition.companyId,
      paymentIntentId: providerTransition.id,
      provider: providerTransition.provider,
      environment: providerTransition.environment,
      status: providerTransition.status,
      reason: "Provider webhook reported failed/canceled payment state",
    }).catch(() => undefined);
  }

  if (verification.responsePayload) {
    return verification.responsePayload;
  }

  return {
    ok: verification.isValid,
    webhookEventId: webhookEvent.id,
    provider: args.provider,
    idempotencyKey: verification.idempotencyKey,
  };
}
