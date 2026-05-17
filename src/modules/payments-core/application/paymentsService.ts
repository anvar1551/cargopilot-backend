import {
  PaymentAttemptStatus,
  PaymentEnvironment,
  PaymentIntentStatus,
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
  const bindings = await prisma.userRoleBinding.findMany({
    where: { userId },
    select: { orgId: true },
  });
  return new Set(bindings.map((item) => item.orgId));
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

  const secretEncrypted = encryptSecret(args.secret.trim());
  const secretMasked = maskSecret(args.secret.trim());

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
      merchantId: args.merchantId?.trim() || null,
      serviceId: args.serviceId?.trim() || null,
      accountId: args.accountId?.trim() || null,
      secretEncrypted,
      secretMasked,
      callbackPath: callbackPathForProvider(args.provider),
      createdByUserId: args.user.id,
      updatedByUserId: args.user.id,
    },
    update: {
      isEnabled: args.isEnabled ?? true,
      merchantId: args.merchantId?.trim() || null,
      serviceId: args.serviceId?.trim() || null,
      accountId: args.accountId?.trim() || null,
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

  return prisma.paymentProviderConfig.update({
    where: { id: existing.id },
    data: {
      isEnabled: args.isEnabled ?? existing.isEnabled,
      merchantId: args.merchantId?.trim() ?? existing.merchantId,
      serviceId: args.serviceId?.trim() ?? existing.serviceId,
      accountId: args.accountId?.trim() ?? existing.accountId,
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

  const canDecrypt = Boolean(decryptSecret(config.secretEncrypted));
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
    healthy: canDecrypt,
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

  const existing = await prisma.paymentIntent.findUnique({
    where: {
      companyId_idempotencyKey: {
        companyId: args.input.companyId,
        idempotencyKey: args.input.idempotencyKey,
      },
    },
    select: {
      id: true,
      status: true,
      providerCheckoutUrl: true,
      providerPaymentId: true,
    },
  });
  if (existing) {
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
    provider: args.input.provider,
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

  const companyId = objectStringField(args.bodyRecord, "companyId");
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
}) {
  const bodyRecord = parseObjectRecord(args.body);
  const environment = parsePaymentEnvironment(objectStringField(bodyRecord, "environment"));
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
      await tx.paymentIntent.update({
        where: { id: intentId },
        data: {
          status: mappedIntentStatus,
          providerPaymentId: verification.providerPaymentId,
        },
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
