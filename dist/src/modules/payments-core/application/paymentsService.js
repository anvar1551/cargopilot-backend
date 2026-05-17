"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listProviderConfigsForActor = listProviderConfigsForActor;
exports.upsertProviderConfigForActor = upsertProviderConfigForActor;
exports.patchProviderConfigForActor = patchProviderConfigForActor;
exports.testProviderConfigForActor = testProviderConfigForActor;
exports.createPaymentIntentForActor = createPaymentIntentForActor;
exports.getPaymentIntentForActor = getPaymentIntentForActor;
exports.createRefundForActor = createRefundForActor;
exports.handleProviderWebhook = handleProviderWebhook;
const client_1 = require("@prisma/client");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const identity_access_1 = require("../../identity-access");
const contracts_1 = require("../domain/contracts");
const providerAdapter_1 = require("../infrastructure/providers/providerAdapter");
const paymentCrypto_1 = require("./paymentCrypto");
function callbackPathForProvider(provider) {
    return `/api/payments/${provider.toLowerCase()}/callback`;
}
function parseObjectRecord(input) {
    if (!input)
        return {};
    if (typeof input === "string") {
        try {
            return JSON.parse(input);
        }
        catch {
            return {};
        }
    }
    if (typeof input === "object")
        return input;
    return {};
}
function objectStringField(input, key) {
    const value = input[key];
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "bigint")
        return String(value);
    return undefined;
}
function toResolvedProviderConfig(config) {
    return {
        id: config.id,
        companyId: config.companyId,
        provider: config.provider,
        environment: config.environment,
        merchantId: config.merchantId,
        serviceId: config.serviceId,
        accountId: config.accountId,
        isEnabled: config.isEnabled,
        secretPlain: (0, paymentCrypto_1.decryptSecret)(config.secretEncrypted),
    };
}
async function getBoundOrgIds(userId) {
    const bindings = await prismaClient_1.default.userRoleBinding.findMany({
        where: { userId },
        select: { orgId: true },
    });
    return new Set(bindings.map((item) => item.orgId));
}
async function assertCompanyAccess(args) {
    await (0, identity_access_1.authorize)(args.user, args.permission);
    const orgIds = await getBoundOrgIds(args.user.id);
    if (orgIds.has(args.companyId))
        return;
    const err = new Error("Forbidden for this company");
    err.statusCode = 403;
    throw err;
}
function canonicalToIntentStatus(status) {
    switch (status) {
        case "requires_action":
            return client_1.PaymentIntentStatus.REQUIRES_ACTION;
        case "processing":
            return client_1.PaymentIntentStatus.PROCESSING;
        case "succeeded":
            return client_1.PaymentIntentStatus.SUCCEEDED;
        case "failed":
            return client_1.PaymentIntentStatus.FAILED;
        case "canceled":
            return client_1.PaymentIntentStatus.CANCELED;
        case "refunded":
            return client_1.PaymentIntentStatus.REFUNDED;
        case "partially_refunded":
            return client_1.PaymentIntentStatus.PARTIALLY_REFUNDED;
        case "pending":
            return client_1.PaymentIntentStatus.PENDING;
        default:
            return undefined;
    }
}
async function listProviderConfigsForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "payments.providers.read");
    const boundOrgIds = await getBoundOrgIds(args.user.id);
    const allowedCompanyIds = args.companyId
        ? [args.companyId]
        : Array.from(boundOrgIds.values());
    if (allowedCompanyIds.length === 0)
        return [];
    return prismaClient_1.default.paymentProviderConfig.findMany({
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
async function upsertProviderConfigForActor(args) {
    await assertCompanyAccess({
        user: args.user,
        companyId: args.companyId,
        permission: "payments.providers.manage",
    });
    const secretEncrypted = (0, paymentCrypto_1.encryptSecret)(args.secret.trim());
    const secretMasked = (0, paymentCrypto_1.maskSecret)(args.secret.trim());
    return prismaClient_1.default.paymentProviderConfig.upsert({
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
async function patchProviderConfigForActor(args) {
    const existing = await prismaClient_1.default.paymentProviderConfig.findUnique({
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
        const err = new Error("Provider config not found");
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
        ? (0, paymentCrypto_1.encryptSecret)(nextSecretRaw)
        : existing.secretEncrypted;
    const secretMasked = nextSecretRaw ? (0, paymentCrypto_1.maskSecret)(nextSecretRaw) : existing.secretMasked;
    return prismaClient_1.default.paymentProviderConfig.update({
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
async function testProviderConfigForActor(args) {
    const config = await prismaClient_1.default.paymentProviderConfig.findUnique({
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
        const err = new Error("Provider config not found");
        err.statusCode = 404;
        throw err;
    }
    await assertCompanyAccess({
        user: args.user,
        companyId: config.companyId,
        permission: "payments.providers.manage",
    });
    const canDecrypt = Boolean((0, paymentCrypto_1.decryptSecret)(config.secretEncrypted));
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
async function resolveActiveConfig(args) {
    const where = {
        companyId: args.companyId,
        isEnabled: true,
        ...(args.provider ? { provider: args.provider } : null),
        ...(args.environment ? { environment: args.environment } : null),
    };
    const explicit = await prismaClient_1.default.paymentProviderConfig.findFirst({
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
        const err = new Error("No enabled payment provider config found for company");
        err.statusCode = 400;
        throw err;
    }
    return explicit;
}
async function createPaymentIntentForActor(args) {
    await assertCompanyAccess({
        user: args.user,
        companyId: args.input.companyId,
        permission: "payments.intents.create",
    });
    const existing = await prismaClient_1.default.paymentIntent.findUnique({
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
            status: (0, contracts_1.toCanonicalStatus)(existing.status),
            checkoutUrl: existing.providerCheckoutUrl,
            providerPaymentId: existing.providerPaymentId,
            reused: true,
        };
    }
    const order = await prismaClient_1.default.order.findUnique({
        where: { id: args.input.orderId },
        select: { id: true },
    });
    if (!order) {
        const err = new Error("Order not found");
        err.statusCode = 404;
        throw err;
    }
    const config = await resolveActiveConfig({
        companyId: args.input.companyId,
        provider: args.input.provider,
    });
    const resolvedConfig = toResolvedProviderConfig(config);
    const adapter = (0, providerAdapter_1.getPaymentProviderAdapter)(config.provider);
    const intent = await prismaClient_1.default.paymentIntent.create({
        data: {
            companyId: args.input.companyId,
            orderId: args.input.orderId,
            provider: config.provider,
            providerConfigId: config.id,
            environment: config.environment,
            amountMinor: args.input.amountMinor,
            currency: args.input.currency.toUpperCase(),
            status: client_1.PaymentIntentStatus.PENDING,
            idempotencyKey: args.input.idempotencyKey,
            metadataJson: (args.input.metadata ?? undefined),
        },
    });
    let providerResult;
    let attemptStatus = client_1.PaymentAttemptStatus.ERROR;
    let nextIntentStatus = client_1.PaymentIntentStatus.FAILED;
    let errorMessage;
    try {
        providerResult = await adapter.createPayment({
            config: resolvedConfig,
            intent,
        });
        attemptStatus = client_1.PaymentAttemptStatus.ACCEPTED;
        if (providerResult.checkoutUrl)
            nextIntentStatus = client_1.PaymentIntentStatus.REQUIRES_ACTION;
        else
            nextIntentStatus = client_1.PaymentIntentStatus.PENDING;
    }
    catch (error) {
        errorMessage = error instanceof Error ? error.message : "Provider payment init failed";
    }
    await prismaClient_1.default.$transaction(async (tx) => {
        await tx.paymentAttempt.create({
            data: {
                paymentIntentId: intent.id,
                provider: config.provider,
                status: attemptStatus,
                requestJson: {
                    returnUrl: args.input.returnUrl ?? null,
                    idempotencyKey: args.input.idempotencyKey,
                },
                responseJson: (providerResult?.rawResponse ?? null),
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
    const resolvedIntent = await prismaClient_1.default.paymentIntent.findUnique({
        where: { id: intent.id },
        select: {
            id: true,
            status: true,
            providerCheckoutUrl: true,
            providerPaymentId: true,
        },
    });
    if (!resolvedIntent) {
        const err = new Error("Payment intent was not persisted");
        err.statusCode = 500;
        throw err;
    }
    return {
        paymentIntentId: resolvedIntent.id,
        status: (0, contracts_1.toCanonicalStatus)(resolvedIntent.status),
        checkoutUrl: resolvedIntent.providerCheckoutUrl,
        providerPaymentId: resolvedIntent.providerPaymentId,
        reused: false,
    };
}
async function getPaymentIntentForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "payments.intents.read");
    const intent = await prismaClient_1.default.paymentIntent.findUnique({
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
        const err = new Error("Payment intent not found");
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
        statusCanonical: (0, contracts_1.toCanonicalStatus)(intent.status),
    };
}
async function createRefundForActor(_args) {
    const err = new Error("Refund adapter flow is not implemented yet");
    err.statusCode = 501;
    throw err;
}
async function resolveWebhookContext(args) {
    const paymentIntentId = objectStringField(args.bodyRecord, "paymentIntentId");
    const merchantTransId = objectStringField(args.bodyRecord, "merchant_trans_id");
    const uzumTransId = objectStringField(args.bodyRecord, "transId");
    const uzumParams = parseObjectRecord(args.bodyRecord.params);
    const uzumOrderId = objectStringField(uzumParams, "order_id") ||
        objectStringField(uzumParams, "paymentIntentId") ||
        objectStringField(uzumParams, "payment_intent_id");
    const paramsRecord = parseObjectRecord(args.bodyRecord.params);
    const accountRecord = parseObjectRecord(paramsRecord.account);
    const paymeOrderId = objectStringField(accountRecord, "order_id") ||
        objectStringField(accountRecord, "paymentIntentId") ||
        objectStringField(accountRecord, "payment_intent_id");
    let intent = null;
    if (paymentIntentId) {
        intent = await prismaClient_1.default.paymentIntent.findUnique({
            where: { id: paymentIntentId },
            include: { providerConfig: true },
        });
    }
    if (!intent && args.provider === client_1.PaymentProvider.CLICK && merchantTransId) {
        intent = await prismaClient_1.default.paymentIntent.findUnique({
            where: { id: merchantTransId },
            include: { providerConfig: true },
        });
    }
    if (!intent && args.provider === client_1.PaymentProvider.PAYME && paymeOrderId) {
        intent = await prismaClient_1.default.paymentIntent.findUnique({
            where: { id: paymeOrderId },
            include: { providerConfig: true },
        });
    }
    if (!intent && args.provider === client_1.PaymentProvider.UZUM && uzumOrderId) {
        intent = await prismaClient_1.default.paymentIntent.findUnique({
            where: { id: uzumOrderId },
            include: { providerConfig: true },
        });
    }
    if (!intent && args.provider === client_1.PaymentProvider.UZUM && uzumTransId) {
        intent = await prismaClient_1.default.paymentIntent.findFirst({
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
        const err = new Error("Webhook payload does not identify company/payment intent");
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
async function handleProviderWebhook(args) {
    const bodyRecord = parseObjectRecord(args.body);
    const environment = (0, providerAdapter_1.parsePaymentEnvironment)(objectStringField(bodyRecord, "environment"));
    const { intent, config } = await resolveWebhookContext({
        provider: args.provider,
        bodyRecord,
        environment,
    });
    const adapter = (0, providerAdapter_1.getPaymentProviderAdapter)(args.provider);
    const verification = await adapter.verifyWebhook({
        provider: args.provider,
        environment,
        body: bodyRecord,
        headers: args.headers,
        config,
        intent,
    });
    const mappedIntentStatus = canonicalToIntentStatus(verification.mappedStatus);
    const intentId = intent?.id ?? objectStringField(bodyRecord, "paymentIntentId") ?? null;
    const webhookEvent = await prismaClient_1.default.$transaction(async (tx) => {
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
                    ? client_1.PaymentWebhookProcessStatus.PROCESSED
                    : client_1.PaymentWebhookProcessStatus.FAILED,
                headersJson: args.headers,
                payloadJson: bodyRecord,
                paymentIntentId: intentId,
                processedAt: verification.isValid ? new Date() : null,
                errorMessage: verification.isValid ? null : "Webhook signature validation failed",
            },
            update: {
                signatureValid: verification.isValid,
                processStatus: verification.isValid
                    ? client_1.PaymentWebhookProcessStatus.PROCESSED
                    : client_1.PaymentWebhookProcessStatus.FAILED,
                headersJson: args.headers,
                payloadJson: bodyRecord,
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
                    status: client_1.PaymentAttemptStatus.ACCEPTED,
                    requestJson: bodyRecord,
                    responseJson: verification.responsePayload,
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
