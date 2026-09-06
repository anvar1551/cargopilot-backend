import { PaymentEnvironment, PaymentProvider } from "@prisma/client";
import { z } from "zod";

const providerEnum = z.nativeEnum(PaymentProvider);
const environmentEnum = z.nativeEnum(PaymentEnvironment);
const supportedCurrencyEnum = z.enum(["UZS", "USD", "CNY"]);

export const listProviderConfigsQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  provider: providerEnum.optional(),
  environment: environmentEnum.optional(),
  enabledOnly: z.coerce.boolean().optional(),
});

export const listAvailableProvidersQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  environment: environmentEnum.optional(),
});

export const upsertCompanyPaymentSettingSchema = z.object({
  companyId: z.string().uuid(),
  onlinePaymentsEnabled: z.boolean(),
  defaultProvider: providerEnum.optional().nullable(),
  allowProviderOverride: z.boolean().optional(),
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

// Legacy amounts/company are optional assertions, never financial authority.
export const createPaymentIntentSchema = z.object({
  companyId: z.string().uuid().optional(),
  orderId: z.string().uuid(),
  amountMinor: z.union([z.bigint(), z.string().regex(/^[0-9]+$/).transform((value) => BigInt(value))]).refine((value) => value > 0n).optional(),
  currency: z.string().trim().transform((value) => value.toUpperCase()).pipe(supportedCurrencyEnum).optional(),
  provider: providerEnum.optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
  returnUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const paymentIntentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const paymentOrderIdParamsSchema = z.object({
  orderId: z.string().uuid(),
});

export const retryOrderPaymentSchema = createPaymentIntentSchema.omit({ orderId: true });

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
