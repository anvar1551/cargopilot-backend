import { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import { parse as parseQueryString } from "querystring";

import { fastifyAuth } from "../../../modules/identity-access/transport/fastify-auth";
import {
  createPaymentIntentForActor,
  createRefundForActor,
  getCompanyPaymentPolicyForActor,
  getPaymentIntentForActor,
  handleProviderWebhook,
  listOrderPaymentIntentsForActor,
  listPaymentRefundsForActor,
  retryOrderPaymentForActor,
  syncPaymentIntentForActor,
  upsertCompanyPaymentPolicyForActor,
  listAvailableProvidersForActor,
  listProviderConfigsForActor,
  patchProviderConfigForActor,
  testProviderConfigForActor,
  upsertProviderConfigForActor,
} from "../application/paymentsService";
import {
  createPaymentIntentSchema,
  listProviderConfigsQuerySchema,
  listAvailableProvidersQuerySchema,
  patchProviderConfigSchema,
  paymentIntentIdParamsSchema,
  paymentOrderIdParamsSchema,
  paymentWebhookSchema,
  providerConfigIdParamsSchema,
  refundPaymentSchema,
  retryOrderPaymentSchema,
  upsertCompanyPaymentSettingSchema,
  upsertProviderConfigSchema,
} from "../shared/validation";
import { PaymentProvider } from "@prisma/client";
import { closePaymentCallbackDatabase } from "../application/callback-database";

function sendError(reply: any, error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: error.flatten() });
  }
  const candidate = error as { status?: number; statusCode?: number; message?: string };
  return reply
    .code(candidate?.statusCode ?? candidate?.status ?? 500)
    .send({ error: candidate?.message ?? fallback });
}

// Configuration errors can originate from encrypted credentials or database drivers.
// Return only fixed public messages; never serialize those exception messages.
function sendSettingsError(reply: any, error: unknown) {
  if (error instanceof ZodError) return reply.code(400).send({ error: "Validation failed", issues: error.flatten() });
  const candidate = error as { status?: number; statusCode?: number; code?: string };
  const status = candidate?.statusCode ?? candidate?.status;
  if (status === 409 && candidate.code === "PAYMENT_CONFIGURATION_APPROVAL_REQUIRED")
    return reply.code(409).send({ error: "Payment configuration requires independent durable approval", code: candidate.code });
  const safeStatus = status === 400 || status === 403 || status === 404 ? status : 500;
  return reply.code(safeStatus).send({ error: safeStatus === 403 ? "Payment configuration access denied"
    : safeStatus === 404 ? "Provider config not found" : safeStatus === 400 ? "Invalid payment configuration request"
    : "Payment configuration request failed" });
}

const paymentsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onClose", async () => { await closePaymentCallbackDatabase(); });
  fastify.get(
    "/settings/payments/policy",
    { preHandler: fastifyAuth({ permission: "payments.providers.read" }) },
    async (request, reply) => {
      try {
        const query = listAvailableProvidersQuerySchema.parse(request.query ?? {});
        const result = await getCompanyPaymentPolicyForActor({
          user: request.user!,
          companyId: query.companyId,
        });
        return reply.send(result);
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  fastify.put(
    "/settings/payments/policy",
    { preHandler: fastifyAuth({ permission: "payments.providers.manage" }) },
    async (request, reply) => {
      try {
        const body = upsertCompanyPaymentSettingSchema.parse(request.body ?? {});
        const result = await upsertCompanyPaymentPolicyForActor({
          user: request.user!,
          ...body,
        });
        return reply.send(result);
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  fastify.get(
    "/payments/providers/available",
    { preHandler: fastifyAuth({ permission: "payments.intents.create" }) },
    async (request, reply) => {
      try {
        const query = listAvailableProvidersQuerySchema.parse(request.query ?? {});
        const result = await listAvailableProvidersForActor({
          user: request.user!,
          companyId: query.companyId,
          environment: query.environment,
        });
        return reply.send(result);
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  fastify.get(
    "/settings/payments/providers",
    { preHandler: fastifyAuth({ permission: "payments.providers.read" }) },
    async (request, reply) => {
      try {
        const query = listProviderConfigsQuerySchema.parse(request.query ?? {});
        const result = await listProviderConfigsForActor({
          user: request.user!,
          companyId: query.companyId,
          provider: query.provider,
          environment: query.environment,
          enabledOnly: query.enabledOnly,
        });
        return reply.send(result);
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  fastify.post(
    "/settings/payments/providers",
    { preHandler: fastifyAuth({ permission: "payments.providers.manage" }) },
    async (request, reply) => {
      try {
        const body = upsertProviderConfigSchema.parse(request.body);
        const result = await upsertProviderConfigForActor({
          user: request.user!,
          ...body,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  fastify.get(
    "/payments/intents/:id/refunds",
    { preHandler: fastifyAuth({ permission: "payments.intents.read" }) },
    async (request, reply) => {
      try {
        const params = paymentIntentIdParamsSchema.parse(request.params);
        const result = await listPaymentRefundsForActor({
          user: request.user!,
          paymentIntentId: params.id,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to load payment refunds");
      }
    },
  );

  fastify.patch(
    "/settings/payments/providers/:id",
    { preHandler: fastifyAuth({ permission: "payments.providers.manage" }) },
    async (request, reply) => {
      try {
        const params = providerConfigIdParamsSchema.parse(request.params);
        const body = patchProviderConfigSchema.parse(request.body ?? {});
        const result = await patchProviderConfigForActor({
          user: request.user!,
          id: params.id,
          ...body,
        });
        return reply.send(result);
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  fastify.post(
    "/settings/payments/providers/:id/test",
    { preHandler: fastifyAuth({ permission: "payments.providers.manage" }) },
    async (request, reply) => {
      try {
        const params = providerConfigIdParamsSchema.parse(request.params);
        const result = await testProviderConfigForActor({ user: request.user!, id: params.id });
        return reply.send(result);
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  fastify.post(
    "/payments/intents",
    { preHandler: fastifyAuth({ permission: "payments.intents.create" }) },
    async (request, reply) => {
      try {
        const body = createPaymentIntentSchema.parse(request.body);
        const result = await createPaymentIntentForActor({ user: request.user!, input: body });
        return reply.code(201).send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to create payment intent");
      }
    },
  );

  fastify.get(
    "/payments/intents/:id",
    { preHandler: fastifyAuth({ permission: "payments.intents.read" }) },
    async (request, reply) => {
      try {
        const params = paymentIntentIdParamsSchema.parse(request.params);
        const result = await getPaymentIntentForActor({ user: request.user!, id: params.id });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to load payment intent");
      }
    },
  );

  fastify.get(
    "/orders/:orderId/payment/intents",
    { preHandler: fastifyAuth({ permission: "payments.intents.read" }) },
    async (request, reply) => {
      try {
        const params = paymentOrderIdParamsSchema.parse(request.params);
        const result = await listOrderPaymentIntentsForActor({
          user: request.user!,
          orderId: params.orderId,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to load order payment intents");
      }
    },
  );

  fastify.post(
    "/payments/intents/:id/sync",
    { preHandler: fastifyAuth({ permission: "payments.intents.read" }) },
    async (request, reply) => {
      try {
        const params = paymentIntentIdParamsSchema.parse(request.params);
        const result = await syncPaymentIntentForActor({
          user: request.user!,
          id: params.id,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to sync payment intent");
      }
    },
  );

  fastify.post(
    "/orders/:orderId/payment/retry",
    { preHandler: fastifyAuth({ permission: "payments.intents.create" }) },
    async (request, reply) => {
      try {
        const params = paymentOrderIdParamsSchema.parse(request.params);
        const body = retryOrderPaymentSchema.parse(request.body ?? {});
        const result = await retryOrderPaymentForActor({
          user: request.user!,
          orderId: params.orderId,
          ...body,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to retry order payment");
      }
    },
  );

  fastify.post(
    "/payments/intents/:id/refund",
    { preHandler: fastifyAuth({ permission: "finance.refund" }) },
    async (request, reply) => {
      try {
        const params = paymentIntentIdParamsSchema.parse(request.params);
        const body = refundPaymentSchema.parse(request.body);
        const result = await createRefundForActor({
          user: request.user!,
          paymentIntentId: params.id,
          ...body,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to create refund");
      }
    },
  );

  function parseWebhookBody(raw: unknown): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === "string") {
      if (raw.trim().startsWith("{")) {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {};
        }
      }
      return parseQueryString(raw) as Record<string, unknown>;
    }
    if (typeof raw === "object") return raw as Record<string, unknown>;
    return {};
  }

  async function handleWebhookByProvider(provider: PaymentProvider, request: any, reply: any) {
    try {
      const rawBody =
        typeof request.body === "string" || Buffer.isBuffer(request.body)
          ? request.body
          : undefined;
      const parsedBody = parseWebhookBody(
        Buffer.isBuffer(request.body) ? request.body.toString("utf8") : request.body ?? {},
      );
      const body =
        provider === PaymentProvider.CLICK ||
        provider === PaymentProvider.PAYME ||
        provider === PaymentProvider.UZUM ||
        provider === PaymentProvider.STRIPE
          ? parsedBody
          : paymentWebhookSchema.parse(parsedBody);
      const result = await handleProviderWebhook({
        provider,
        body,
        headers: request.headers ?? {},
        rawBody,
      });
      return reply.send(result);
    } catch (error) {
      const failure = error as { statusCode?: number; code?: string };
      const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 600 ? failure.statusCode : 500;
      const code = typeof failure.code === "string" && /^PAYMENT_[A-Z_]{1,80}$/.test(failure.code) ? failure.code : "PAYMENT_CALLBACK_FAILED";
      // Never return provider/decryption/database exception details to ingress callers.
      return reply.code(status).send({ error: status >= 500 ? "Payment callback unavailable" : "Payment callback rejected", code });
    }
  }

  fastify.post("/payments/click/callback", async (request, reply) =>
    handleWebhookByProvider(PaymentProvider.CLICK, request, reply),
  );
  fastify.post("/payments/payme/callback", async (request, reply) =>
    handleWebhookByProvider(PaymentProvider.PAYME, request, reply),
  );
  fastify.post("/payments/uzum/callback", async (request, reply) =>
    handleWebhookByProvider(PaymentProvider.UZUM, request, reply),
  );

  await fastify.register(async (stripeWebhookScope) => {
    stripeWebhookScope.removeAllContentTypeParsers();
    stripeWebhookScope.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    stripeWebhookScope.post("/payments/stripe/callback", { bodyLimit: 65536 }, async (request, reply) =>
      handleWebhookByProvider(PaymentProvider.STRIPE, request, reply),
    );
  });
};

export default paymentsFastifyRoutes;

