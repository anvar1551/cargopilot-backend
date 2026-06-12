"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCompanyPaymentPolicyForActor = getCompanyPaymentPolicyForActor;
exports.upsertCompanyPaymentPolicyForActor = upsertCompanyPaymentPolicyForActor;
exports.isCompanyOnlinePaymentsAllowed = isCompanyOnlinePaymentsAllowed;
exports.listProviderConfigsForActor = listProviderConfigsForActor;
exports.listAvailableProvidersForActor = listAvailableProvidersForActor;
exports.upsertProviderConfigForActor = upsertProviderConfigForActor;
exports.patchProviderConfigForActor = patchProviderConfigForActor;
exports.testProviderConfigForActor = testProviderConfigForActor;
exports.createPaymentIntentForActor = createPaymentIntentForActor;
exports.getPaymentIntentForActor = getPaymentIntentForActor;
exports.listOrderPaymentIntentsForActor = listOrderPaymentIntentsForActor;
exports.syncPaymentIntentForActor = syncPaymentIntentForActor;
exports.retryOrderPaymentForActor = retryOrderPaymentForActor;
exports.createRefundForActor = createRefundForActor;
exports.handleProviderWebhook = handleProviderWebhook;
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prismaClient_1 = __importDefault(require("../../../config/prismaClient"));
const identity_access_1 = require("../../identity-access");
const contracts_1 = require("../domain/contracts");
const providerAdapter_1 = require("../infrastructure/providers/providerAdapter");
const paymentCrypto_1 = require("./paymentCrypto");
function callbackPathForProvider(provider) {
    return `/api/payments/${provider.toLowerCase()}/callback`;
}
function isGlobalPaymentsEnabled() {
    return process.env.PAYMENTS_ENABLED === "true";
}
function normalizedOrNull(value) {
    const next = value?.trim();
    return next ? next : null;
}
function normalizedOrUndefined(value) {
    const next = normalizedOrNull(value);
    return next ?? undefined;
}
function collectProviderConfigIssues(args) {
    const merchantId = normalizedOrUndefined(args.merchantId);
    const serviceId = normalizedOrUndefined(args.serviceId);
    const accountId = normalizedOrUndefined(args.accountId);
    const secret = normalizedOrUndefined(args.secret);
    const issues = [];
    if (!secret || secret.length < 4)
        issues.push("secret is required and must be at least 4 chars");
    if (args.provider === client_1.PaymentProvider.CLICK) {
        if (!merchantId)
            issues.push("merchantId is required for CLICK");
        if (!serviceId)
            issues.push("serviceId is required for CLICK");
        if (!accountId)
            issues.push("accountId (merchant_user_id) is required for CLICK");
    }
    if (args.provider === client_1.PaymentProvider.PAYME) {
        if (!merchantId)
            issues.push("merchantId (cashbox ID) is required for PAYME");
    }
    if (args.provider === client_1.PaymentProvider.UZUM) {
        if (!serviceId)
            issues.push("serviceId is required for UZUM");
        if (!accountId)
            issues.push("accountId (BasicAuth username) is required for UZUM");
    }
    if (args.provider === client_1.PaymentProvider.STRIPE) {
        if (!secret?.startsWith("sk_")) {
            issues.push("secret must be a Stripe secret key (sk_...) for STRIPE");
        }
        if (!serviceId?.startsWith("whsec_")) {
            issues.push("serviceId must be Stripe webhook secret (whsec_...) for STRIPE");
        }
    }
    return issues;
}
function assertProviderConfigValid(args) {
    const issues = collectProviderConfigIssues(args);
    if (issues.length === 0)
        return;
    const err = new Error(issues.join("; "));
    err.statusCode = 400;
    err.issues = issues;
    throw err;
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
function nestedObjectField(input, key) {
    const value = input[key];
    if (value && typeof value === "object")
        return value;
    return {};
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
    const memberships = await prismaClient_1.default.companyMembership.findMany({
        where: { userId, status: "active" },
        select: {
            companyId: true,
            scopes: { select: { scopeRefId: true } },
        },
    });
    const ids = new Set();
    for (const membership of memberships) {
        ids.add(membership.companyId);
        for (const scope of membership.scopes)
            ids.add(scope.scopeRefId);
    }
    return ids;
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
async function getCompanyPaymentPolicyForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "payments.providers.read");
    const companyId = (args.companyId ?? args.user.companyId ?? "").trim();
    if (!companyId) {
        const err = new Error("companyId is required");
        err.statusCode = 400;
        throw err;
    }
    await assertCompanyAccess({
        user: args.user,
        companyId,
        permission: "payments.providers.read",
    });
    const setting = await prismaClient_1.default.companyPaymentSetting.findUnique({
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
        effectiveOnlinePaymentsEnabled: isGlobalPaymentsEnabled() && (setting?.onlinePaymentsEnabled ?? true),
        defaultProvider: setting?.defaultProvider ?? null,
        allowProviderOverride: setting?.allowProviderOverride ?? true,
        createdAt: setting?.createdAt ?? null,
        updatedAt: setting?.updatedAt ?? null,
    };
}
async function upsertCompanyPaymentPolicyForActor(args) {
    await assertCompanyAccess({
        user: args.user,
        companyId: args.companyId,
        permission: "payments.providers.manage",
    });
    const setting = await prismaClient_1.default.companyPaymentSetting.upsert({
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
        effectiveOnlinePaymentsEnabled: isGlobalPaymentsEnabled() && setting.onlinePaymentsEnabled,
    };
}
async function isCompanyOnlinePaymentsAllowed(companyId) {
    const setting = await prismaClient_1.default.companyPaymentSetting.findUnique({
        where: { companyId },
        select: {
            onlinePaymentsEnabled: true,
        },
    });
    return isGlobalPaymentsEnabled() && (setting?.onlinePaymentsEnabled ?? true);
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
function mapIntentStatusToOrderPaymentState(status) {
    switch (status) {
        case client_1.PaymentIntentStatus.SUCCEEDED:
            return client_1.OrderPaymentState.PAID;
        case client_1.PaymentIntentStatus.REFUNDED:
        case client_1.PaymentIntentStatus.PARTIALLY_REFUNDED:
            return client_1.OrderPaymentState.REFUNDED;
        case client_1.PaymentIntentStatus.FAILED:
        case client_1.PaymentIntentStatus.CANCELED:
            return client_1.OrderPaymentState.FAILED;
        case client_1.PaymentIntentStatus.PENDING:
        case client_1.PaymentIntentStatus.REQUIRES_ACTION:
        case client_1.PaymentIntentStatus.PROCESSING:
        default:
            return client_1.OrderPaymentState.PENDING;
    }
}
async function reconcileOrderServiceChargeAfterOnlinePayment(tx, args) {
    if (args.intentStatus !== client_1.PaymentIntentStatus.SUCCEEDED)
        return;
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
    if (!order)
        return;
    const isOnlinePayment = order.paymentType === client_1.PaymentType.CARD || order.paymentType === client_1.PaymentType.TRANSFER;
    if (!isOnlinePayment)
        return;
    const serviceChargeAmount = Number(order.serviceCharge ?? 0);
    if (!Number.isFinite(serviceChargeAmount) || serviceChargeAmount <= 0)
        return;
    const serviceChargeExpectedFromSender = order.deliveryChargePaidBy === client_1.PaidBy.SENDER ||
        order.deliveryChargePaidBy === client_1.PaidBy.RECIPIENT;
    if (!serviceChargeExpectedFromSender)
        return;
    const now = new Date();
    const existing = await tx.cashCollection.findUnique({
        where: {
            orderId_kind: {
                orderId: order.id,
                kind: client_1.CashCollectionKind.service_charge,
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
    const settledAmount = Number(existing?.collectedAmount ?? existing?.expectedAmount ?? serviceChargeAmount);
    const nextAmount = Number.isFinite(settledAmount) && settledAmount > 0 ? settledAmount : serviceChargeAmount;
    if (!existing) {
        await tx.cashCollection.create({
            data: {
                orderId: order.id,
                kind: client_1.CashCollectionKind.service_charge,
                status: client_1.CashCollectionStatus.settled,
                expectedAmount: serviceChargeAmount,
                collectedAmount: nextAmount,
                currency: order.currency ?? "UZS",
                currentHolderType: client_1.CashHolderType.finance,
                currentHolderLabel: "Online payment",
                collectedAt: now,
                settledAt: now,
                events: {
                    create: {
                        eventType: client_1.CashCollectionEventType.settled,
                        amount: nextAmount,
                        note: "Service charge settled via online payment provider",
                        actorId: args.actorId ?? null,
                        actorRole: null,
                        toHolderType: client_1.CashHolderType.finance,
                        toHolderName: "Online payment",
                    },
                },
            },
        });
    }
    else if (existing.status !== client_1.CashCollectionStatus.settled) {
        await tx.cashCollection.update({
            where: { id: existing.id },
            data: {
                status: client_1.CashCollectionStatus.settled,
                expectedAmount: Number.isFinite(Number(existing.expectedAmount)) && Number(existing.expectedAmount) > 0
                    ? Number(existing.expectedAmount)
                    : serviceChargeAmount,
                collectedAmount: nextAmount,
                currency: existing.currency ?? order.currency ?? "UZS",
                currentHolderType: client_1.CashHolderType.finance,
                currentHolderUserId: null,
                currentHolderWarehouseId: null,
                currentHolderLabel: "Online payment",
                collectedAt: existing.collectedAt ?? now,
                settledAt: now,
                events: {
                    create: {
                        eventType: client_1.CashCollectionEventType.settled,
                        amount: nextAmount,
                        note: "Service charge settled via online payment provider",
                        fromHolderType: existing.currentHolderType,
                        fromHolderId: existing.currentHolderUserId ?? existing.currentHolderWarehouseId ?? null,
                        fromHolderName: existing.currentHolderLabel ?? null,
                        toHolderType: client_1.CashHolderType.finance,
                        toHolderName: "Online payment",
                        actorId: args.actorId ?? null,
                        actorRole: null,
                    },
                },
            },
        });
    }
    if (order.serviceChargePaidStatus !== client_1.PaidStatus.PAID) {
        await tx.order.update({
            where: { id: order.id },
            data: {
                serviceChargePaidStatus: client_1.PaidStatus.PAID,
            },
        });
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
async function listAvailableProvidersForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "payments.intents.create");
    const targetCompanyId = (args.companyId ?? args.user.companyId ?? "").trim();
    if (!targetCompanyId) {
        const err = new Error("companyId is required");
        err.statusCode = 400;
        throw err;
    }
    await assertCompanyAccess({
        user: args.user,
        companyId: targetCompanyId,
        permission: "payments.intents.create",
    });
    const policy = await prismaClient_1.default.companyPaymentSetting.findUnique({
        where: { companyId: targetCompanyId },
        select: {
            onlinePaymentsEnabled: true,
            defaultProvider: true,
            allowProviderOverride: true,
        },
    });
    const effectiveEnabled = isGlobalPaymentsEnabled() && (policy?.onlinePaymentsEnabled ?? true);
    if (!effectiveEnabled)
        return [];
    const rows = await prismaClient_1.default.paymentProviderConfig.findMany({
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
        integrationMode: row.provider === client_1.PaymentProvider.UZUM ? "webhook" : "redirect",
        supportsCheckoutRedirect: row.provider !== client_1.PaymentProvider.UZUM,
        configuredFields: {
            merchantId: Boolean(row.merchantId),
            serviceId: Boolean(row.serviceId),
            accountId: Boolean(row.accountId),
        },
        updatedAt: row.updatedAt,
    }));
    if (!policy?.defaultProvider)
        return mapped;
    const preferred = mapped.filter((item) => item.provider === policy.defaultProvider);
    const others = mapped.filter((item) => item.provider !== policy.defaultProvider);
    return [...preferred, ...others];
}
async function upsertProviderConfigForActor(args) {
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
    const secretEncrypted = (0, paymentCrypto_1.encryptSecret)(secretRaw);
    const secretMasked = (0, paymentCrypto_1.maskSecret)(secretRaw);
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
    const nextMerchantId = args.merchantId === undefined ? existing.merchantId : normalizedOrNull(args.merchantId);
    const nextServiceId = args.serviceId === undefined ? existing.serviceId : normalizedOrNull(args.serviceId);
    const nextAccountId = args.accountId === undefined ? existing.accountId : normalizedOrNull(args.accountId);
    const nextSecret = nextSecretRaw ?? (0, paymentCrypto_1.decryptSecret)(secretEncrypted);
    assertProviderConfigValid({
        provider: existing.provider,
        merchantId: nextMerchantId,
        serviceId: nextServiceId,
        accountId: nextAccountId,
        secret: nextSecret,
    });
    return prismaClient_1.default.paymentProviderConfig.update({
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
    const decryptedSecret = (0, paymentCrypto_1.decryptSecret)(config.secretEncrypted);
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
    assertProviderConfigValid({
        provider: explicit.provider,
        merchantId: explicit.merchantId,
        serviceId: explicit.serviceId,
        accountId: explicit.accountId,
        secret: (0, paymentCrypto_1.decryptSecret)(explicit.secretEncrypted),
    });
    return explicit;
}
async function createPaymentIntentForActor(args) {
    await assertCompanyAccess({
        user: args.user,
        companyId: args.input.companyId,
        permission: "payments.intents.create",
    });
    const policy = await prismaClient_1.default.companyPaymentSetting.findUnique({
        where: { companyId: args.input.companyId },
        select: {
            onlinePaymentsEnabled: true,
            defaultProvider: true,
            allowProviderOverride: true,
        },
    });
    const effectiveEnabled = isGlobalPaymentsEnabled() && (policy?.onlinePaymentsEnabled ?? true);
    if (!effectiveEnabled) {
        const err = new Error("Online payments are disabled for this company");
        err.statusCode = 409;
        throw err;
    }
    const requestedProvider = args.input.provider;
    const providerToUse = requestedProvider && (policy?.allowProviderOverride ?? true)
        ? requestedProvider
        : (policy?.defaultProvider ?? requestedProvider);
    const existing = await prismaClient_1.default.paymentIntent.findUnique({
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
            const err = new Error("Idempotency key is already used for a different order");
            err.statusCode = 409;
            throw err;
        }
        await prismaClient_1.default.order.update({
            where: { id: args.input.orderId },
            data: {
                paymentState: mapIntentStatusToOrderPaymentState(existing.status),
            },
        });
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
        provider: providerToUse,
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
        await tx.order.update({
            where: { id: args.input.orderId },
            data: {
                paymentState: mapIntentStatusToOrderPaymentState(nextIntentStatus),
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
function publicPaymentIntentPayload(intent, extra) {
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
        statusCanonical: (0, contracts_1.toCanonicalStatus)(intent.status),
        providerPaymentId: intent.providerPaymentId,
        providerInvoiceId: intent.providerInvoiceId,
        providerCheckoutUrl: intent.providerCheckoutUrl,
        idempotencyKey: intent.idempotencyKey,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        ...extra,
    };
}
async function applyPaymentIntentProviderStatus(tx, args) {
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
        actorId: args.actorId ?? null,
    });
    await tx.paymentAttempt.create({
        data: {
            paymentIntentId: args.intentId,
            provider: args.provider,
            status: args.status === client_1.PaymentIntentStatus.FAILED ||
                args.status === client_1.PaymentIntentStatus.CANCELED
                ? client_1.PaymentAttemptStatus.REJECTED
                : client_1.PaymentAttemptStatus.ACCEPTED,
            requestJson: args.requestJson,
            responseJson: args.responseJson,
        },
    });
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
        amountMinor: intent.amountMinor.toString(),
        statusCanonical: (0, contracts_1.toCanonicalStatus)(intent.status),
    };
}
async function listOrderPaymentIntentsForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "payments.intents.read");
    const order = await prismaClient_1.default.order.findUnique({
        where: { id: args.orderId },
        select: {
            id: true,
            ownerOrgId: true,
        },
    });
    if (!order) {
        const err = new Error("Order not found");
        err.statusCode = 404;
        throw err;
    }
    const companyId = order.ownerOrgId;
    if (!companyId) {
        const err = new Error("Order does not have a company scope");
        err.statusCode = 400;
        throw err;
    }
    await assertCompanyAccess({
        user: args.user,
        companyId,
        permission: "payments.intents.read",
    });
    const intents = await prismaClient_1.default.paymentIntent.findMany({
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
async function syncPaymentIntentForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "payments.intents.read");
    const intent = await prismaClient_1.default.paymentIntent.findUnique({
        where: { id: args.id },
        include: {
            providerConfig: true,
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
        const err = new Error("Payment provider config is disabled");
        err.statusCode = 409;
        throw err;
    }
    const adapter = (0, providerAdapter_1.getPaymentProviderAdapter)(intent.provider);
    const providerStatus = await adapter.getStatus({
        config: resolvedConfig,
        intent,
    });
    const nextStatus = canonicalToIntentStatus(providerStatus.status) ?? intent.status;
    await prismaClient_1.default.$transaction((tx) => applyPaymentIntentProviderStatus(tx, {
        intentId: intent.id,
        provider: intent.provider,
        status: nextStatus,
        providerPaymentId: providerStatus.providerPaymentId,
        providerInvoiceId: providerStatus.providerInvoiceId,
        checkoutUrl: providerStatus.checkoutUrl,
        requestJson: {
            source: "manual_provider_status_sync",
            provider: intent.provider,
        },
        responseJson: (providerStatus.rawResponse ?? null),
        actorId: args.user.id,
    }));
    const refreshed = await prismaClient_1.default.paymentIntent.findUniqueOrThrow({
        where: { id: intent.id },
    });
    return {
        paymentIntent: publicPaymentIntentPayload(refreshed),
        providerStatus: providerStatus.status,
        providerResponse: providerStatus.rawResponse ?? null,
    };
}
async function retryOrderPaymentForActor(args) {
    await (0, identity_access_1.authorize)(args.user, "payments.intents.create");
    const order = await prismaClient_1.default.order.findUnique({
        where: { id: args.orderId },
        select: {
            id: true,
            ownerOrgId: true,
            paymentType: true,
        },
    });
    if (!order) {
        const err = new Error("Order not found");
        err.statusCode = 404;
        throw err;
    }
    const companyId = order.ownerOrgId;
    if (!companyId) {
        const err = new Error("Order does not have a company scope");
        err.statusCode = 400;
        throw err;
    }
    await assertCompanyAccess({
        user: args.user,
        companyId,
        permission: "payments.intents.create",
    });
    if (order.paymentType !== client_1.PaymentType.CARD && order.paymentType !== client_1.PaymentType.TRANSFER) {
        const err = new Error("Payment retry is only available for online payment orders");
        err.statusCode = 409;
        throw err;
    }
    const latestIntent = await prismaClient_1.default.paymentIntent.findFirst({
        where: {
            orderId: order.id,
            companyId,
        },
        orderBy: { createdAt: "desc" },
        select: {
            amountMinor: true,
            currency: true,
            provider: true,
            status: true,
        },
    });
    if (!latestIntent) {
        const err = new Error("No previous online payment intent found for this order");
        err.statusCode = 404;
        throw err;
    }
    if (latestIntent.status === client_1.PaymentIntentStatus.SUCCEEDED ||
        latestIntent.status === client_1.PaymentIntentStatus.REFUNDED ||
        latestIntent.status === client_1.PaymentIntentStatus.PARTIALLY_REFUNDED) {
        const err = new Error("Payment is already settled and cannot be retried");
        err.statusCode = 409;
        throw err;
    }
    const retryIntent = await createPaymentIntentForActor({
        user: args.user,
        input: {
            companyId,
            orderId: order.id,
            provider: args.provider ?? latestIntent.provider,
            amountMinor: latestIntent.amountMinor,
            currency: latestIntent.currency,
            idempotencyKey: `payment-retry:${order.id}:${(0, crypto_1.randomUUID)()}`,
            metadata: {
                source: "payment_retry",
                previousStatus: latestIntent.status,
            },
        },
    });
    return retryIntent;
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
    const stripeEventData = nestedObjectField(args.bodyRecord, "data");
    const stripeEventObject = nestedObjectField(stripeEventData, "object");
    const stripeEventMetadata = nestedObjectField(stripeEventObject, "metadata");
    const stripeEventType = objectStringField(args.bodyRecord, "type") ?? "";
    const stripePaymentIntentRef = objectStringField(stripeEventObject, "payment_intent");
    const stripeIntentIdFromMetadata = objectStringField(stripeEventMetadata, "paymentIntentId");
    const stripeIntentIdFromClientRef = objectStringField(stripeEventObject, "client_reference_id");
    const stripeOrderIdFromMetadata = objectStringField(stripeEventMetadata, "orderId");
    const stripeCompanyIdFromMetadata = objectStringField(stripeEventMetadata, "companyId");
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
    if (!intent &&
        args.provider === client_1.PaymentProvider.STRIPE &&
        stripeIntentIdFromMetadata) {
        intent = await prismaClient_1.default.paymentIntent.findUnique({
            where: { id: stripeIntentIdFromMetadata },
            include: { providerConfig: true },
        });
    }
    if (!intent &&
        args.provider === client_1.PaymentProvider.STRIPE &&
        stripeIntentIdFromClientRef) {
        intent = await prismaClient_1.default.paymentIntent.findUnique({
            where: { id: stripeIntentIdFromClientRef },
            include: { providerConfig: true },
        });
    }
    if (!intent &&
        args.provider === client_1.PaymentProvider.STRIPE &&
        stripePaymentIntentRef &&
        stripeEventType.startsWith("payment_intent.")) {
        intent = await prismaClient_1.default.paymentIntent.findFirst({
            where: { providerPaymentId: stripePaymentIntentRef },
            include: { providerConfig: true },
        });
    }
    if (!intent &&
        args.provider === client_1.PaymentProvider.STRIPE &&
        stripeOrderIdFromMetadata) {
        intent = await prismaClient_1.default.paymentIntent.findFirst({
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
    const companyId = objectStringField(args.bodyRecord, "companyId") || stripeCompanyIdFromMetadata;
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
    const stripeLiveMode = bodyRecord["livemode"];
    const environment = args.provider === client_1.PaymentProvider.STRIPE && typeof stripeLiveMode === "boolean"
        ? stripeLiveMode
            ? client_1.PaymentEnvironment.PRODUCTION
            : client_1.PaymentEnvironment.TEST
        : (0, providerAdapter_1.parsePaymentEnvironment)(objectStringField(bodyRecord, "environment"));
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
        rawBody: args.rawBody,
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
            await applyPaymentIntentProviderStatus(tx, {
                intentId,
                provider: args.provider,
                status: mappedIntentStatus,
                providerPaymentId: verification.providerPaymentId,
                requestJson: bodyRecord,
                responseJson: verification.responsePayload,
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
