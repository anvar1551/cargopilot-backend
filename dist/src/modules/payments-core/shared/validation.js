"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentWebhookSchema = exports.refundPaymentSchema = exports.paymentIntentIdParamsSchema = exports.createPaymentIntentSchema = exports.providerConfigIdParamsSchema = exports.patchProviderConfigSchema = exports.upsertProviderConfigSchema = exports.listProviderConfigsQuerySchema = void 0;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const providerEnum = zod_1.z.nativeEnum(client_1.PaymentProvider);
const environmentEnum = zod_1.z.nativeEnum(client_1.PaymentEnvironment);
exports.listProviderConfigsQuerySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    provider: providerEnum.optional(),
    environment: environmentEnum.optional(),
    enabledOnly: zod_1.z.coerce.boolean().optional(),
});
exports.upsertProviderConfigSchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid(),
    provider: providerEnum,
    environment: environmentEnum.default(client_1.PaymentEnvironment.TEST),
    isEnabled: zod_1.z.boolean().optional(),
    merchantId: zod_1.z.string().trim().min(1).optional(),
    serviceId: zod_1.z.string().trim().min(1).optional(),
    accountId: zod_1.z.string().trim().min(1).optional(),
    secret: zod_1.z.string().trim().min(4),
});
exports.patchProviderConfigSchema = zod_1.z.object({
    isEnabled: zod_1.z.boolean().optional(),
    merchantId: zod_1.z.string().trim().min(1).optional(),
    serviceId: zod_1.z.string().trim().min(1).optional(),
    accountId: zod_1.z.string().trim().min(1).optional(),
    secret: zod_1.z.string().trim().min(4).optional(),
    environment: environmentEnum.optional(),
});
exports.providerConfigIdParamsSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
});
exports.createPaymentIntentSchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid(),
    orderId: zod_1.z.string().uuid(),
    amountMinor: zod_1.z.coerce.bigint().gt(0n),
    currency: zod_1.z.string().trim().min(3).max(8),
    provider: providerEnum.optional(),
    idempotencyKey: zod_1.z.string().trim().min(8).max(128),
    returnUrl: zod_1.z.string().url().optional(),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
});
exports.paymentIntentIdParamsSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
});
exports.refundPaymentSchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid(),
    idempotencyKey: zod_1.z.string().trim().min(8).max(128),
    amountMinor: zod_1.z.coerce.bigint().optional(),
    reason: zod_1.z.string().trim().max(240).optional(),
});
exports.paymentWebhookSchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    environment: environmentEnum.optional(),
    idempotencyKey: zod_1.z.string().trim().min(4).max(256).optional(),
    paymentIntentId: zod_1.z.string().uuid().optional(),
    providerPaymentId: zod_1.z.string().trim().min(1).optional(),
    status: zod_1.z
        .enum([
        "pending",
        "requires_action",
        "processing",
        "succeeded",
        "failed",
        "canceled",
        "refunded",
        "partially_refunded",
    ])
        .optional(),
    rawEventId: zod_1.z.string().trim().max(255).optional(),
});
