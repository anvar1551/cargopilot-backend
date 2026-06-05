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

type AuthUser = Express.User;

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
}) {
  const where: Prisma.PaymentProviderConfigWhereInput = {
    companyId: args.companyId,
    isEnabled: true,
    ...(args.provider ? { provider: args.provider } : null),
    ...(args.environment ? { environment: args.environment } : null),
  };

  const explicit = await prisma.paymentProviderConfig.findFirst({
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
  await assertCompanyAccess({
    user: args.user,
    companyId: args.input.companyId,
    permission: "payments.intents.create",
  });

  const policy = await prisma.companyPaymentSetting.findUnique({
    where: { companyId: args.input.companyId },
    select: {
      onlinePaymentsEnabled: true,
      defaultProvider: true,
      allowProviderOverride: true,
    },
  });
  const effectiveEnabled =
    isGlobalPaymentsEnabled() && (policy?.onlinePaymentsEnabled ?? true);
  if (!effectiveEnabled) {
    const err = new Error("Online payments are disabled for this company") as Error & {
      statusCode: number;
    };
    err.statusCode = 409;
    throw err;
  }

  const requestedProvider = args.input.provider;
  const providerToUse =
    requestedProvider && (policy?.allowProviderOverride ?? true)
      ? requestedProvider
      : (policy?.defaultProvider ?? requestedProvider);

  const existing = await prisma.paymentIntent.findUnique({
    where: {
      companyId_idempotencyKey: {
        companyId: args.input.companyId,
        idempotencyKey: args.input.idempotencyKey,
      },
    },
    select: {
      id: true,
      orderId: true,
      status: true,
      providerCheckoutUrl: true,
      providerPaymentId: true,
    },
  });
  if (existing) {
    if (existing.orderId !== args.input.orderId) {
      const err = new Error(
        "Idempotency key is already used for a different order",
      ) as Error & { statusCode: number };
      err.statusCode = 409;
      throw err;
    }

    await prisma.order.update({
      where: { id: args.input.orderId },
      data: {
        paymentState: mapIntentStatusToOrderPaymentState(existing.status),
      },
    });

    return {
      paymentIntentId: existing.id,
      status: toCanonicalStatus(existing.status),
      checkoutUrl: existing.providerCheckoutUrl,
      providerPaymentId: existing.providerPaymentId,
      reused: true,
    };
  }

  const order = await prisma.order.findUnique({
    where: { id: args.input.orderId },
    select: { id: true },
  });
  if (!order) {
    const err = new Error("Order not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  const config = await resolveActiveConfig({
    companyId: args.input.companyId,
    provider: providerToUse,
  });
  const resolvedConfig = toResolvedProviderConfig(config);
  const adapter = getPaymentProviderAdapter(config.provider);

  const intent = await prisma.paymentIntent.create({
    data: {
      companyId: args.input.companyId,
      orderId: args.input.orderId,
      provider: config.provider,
      providerConfigId: config.id,
      environment: config.environment,
      amountMinor: args.input.amountMinor,
      currency: args.input.currency.toUpperCase(),
      status: PaymentIntentStatus.PENDING,
      idempotencyKey: args.input.idempotencyKey,
      metadataJson: (args.input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });

  let providerResult:
    | {
        providerPaymentId?: string;
        providerInvoiceId?: string;
        checkoutUrl?: string;
        rawResponse?: unknown;
      }
    | undefined;

  let attemptStatus: PaymentAttemptStatus = PaymentAttemptStatus.ERROR;
  let nextIntentStatus: PaymentIntentStatus = PaymentIntentStatus.FAILED;
  let errorMessage: string | undefined;

  try {
    providerResult = await adapter.createPayment({
      config: resolvedConfig,
      intent,
    });
    attemptStatus = PaymentAttemptStatus.ACCEPTED;
    if (providerResult.checkoutUrl) nextIntentStatus = PaymentIntentStatus.REQUIRES_ACTION;
    else nextIntentStatus = PaymentIntentStatus.PENDING;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Provider payment init failed";
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: config.provider,
        status: attemptStatus,
        requestJson: {
          returnUrl: args.input.returnUrl ?? null,
          idempotencyKey: args.input.idempotencyKey,
        } as Prisma.InputJsonValue,
        responseJson: (providerResult?.rawResponse ?? null) as Prisma.InputJsonValue,
        errorMessage,
      },
    });

    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: nextIntentStatus,
        providerPaymentId: providerResult?.providerPaymentId,
        providerInvoiceId: providerResult?.providerInvoiceId,
        providerCheckoutUrl: providerResult?.checkoutUrl,
      },
    });

    await tx.order.update({
      where: { id: args.input.orderId },
      data: {
        paymentState: mapIntentStatusToOrderPaymentState(nextIntentStatus),
      },
    });
  });

  const resolvedIntent = await prisma.paymentIntent.findUnique({
    where: { id: intent.id },
    select: {
      id: true,
      status: true,
      providerCheckoutUrl: true,
      providerPaymentId: true,
    },
  });

  if (!resolvedIntent) {
    const err = new Error("Payment intent was not persisted") as Error & { statusCode: number };
    err.statusCode = 500;
    throw err;
  }

  return {
    paymentIntentId: resolvedIntent.id,
    status: toCanonicalStatus(resolvedIntent.status),
    checkoutUrl: resolvedIntent.providerCheckoutUrl,
    providerPaymentId: resolvedIntent.providerPaymentId,
    reused: false,
  };
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
    statusCanonical: toCanonicalStatus(intent.status),
  };
}

export async function createRefundForActor(_args: {
  user: AuthUser;
  companyId: string;
  paymentIntentId: string;
  amountMinor?: bigint;
  reason?: string;
  idempotencyKey: string;
}) {
  const err = new Error("Refund adapter flow is not implemented yet") as Error & {
    statusCode: number;
  };
  err.statusCode = 501;
  throw err;
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

  const webhookEvent = await prisma.$transaction(async (tx) => {
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
      const updatedIntent = await tx.paymentIntent.update({
        where: { id: intentId },
        data: {
          status: mappedIntentStatus,
          providerPaymentId: verification.providerPaymentId,
        },
        select: {
          orderId: true,
          status: true,
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
        actorId: null,
      });

      await tx.paymentAttempt.create({
        data: {
          paymentIntentId: intentId,
          provider: args.provider,
          status: PaymentAttemptStatus.ACCEPTED,
          requestJson: bodyRecord as Prisma.InputJsonValue,
          responseJson: verification.responsePayload as Prisma.InputJsonValue,
        },
      });
    }

    return event;
  });

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
