import { PaymentEnvironment, PaymentProvider } from "@prisma/client";
import { z } from "zod";

const providerEnum = z.nativeEnum(PaymentProvider);
const environmentEnum = z.nativeEnum(PaymentEnvironment);

export const listProviderConfigsQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  provider: providerEnum.optional(),
  environment: environmentEnum.optional(),
  enabledOnly: z.coerce.boolean().optional(),
});

export const upsertProviderConfigSchema = z.object({
  companyId: z.string().uuid(),
  provider: providerEnum,
  environment: environmentEnum.default(PaymentEnvironment.TEST),
  isEnabled: z.boolean().optional(),
  merchantId: z.string().trim().min(1).optional(),
  serviceId: z.string().trim().min(1).optional(),
  accountId: z.string().trim().min(1).optional(),
  secret: z.string().trim().min(4),
});

export const patchProviderConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  merchantId: z.string().trim().min(1).optional(),
  serviceId: z.string().trim().min(1).optional(),
  accountId: z.string().trim().min(1).optional(),
  secret: z.string().trim().min(4).optional(),
  environment: environmentEnum.optional(),
});

export const providerConfigIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createPaymentIntentSchema = z.object({
  companyId: z.string().uuid(),
  orderId: z.string().uuid(),
  amountMinor: z.coerce.bigint().gt(0n),
  currency: z.string().trim().min(3).max(8),
  provider: providerEnum.optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
  returnUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const paymentIntentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const refundPaymentSchema = z.object({
  companyId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(128),
  amountMinor: z.coerce.bigint().optional(),
  reason: z.string().trim().max(240).optional(),
});

export const paymentWebhookSchema = z.object({
  companyId: z.string().uuid().optional(),
  environment: environmentEnum.optional(),
  idempotencyKey: z.string().trim().min(4).max(256).optional(),
  paymentIntentId: z.string().uuid().optional(),
  providerPaymentId: z.string().trim().min(1).optional(),
  status: z
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
  rawEventId: z.string().trim().max(255).optional(),
});
