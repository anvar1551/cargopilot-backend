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
  paymentWebhookSchema,
  providerConfigIdParamsSchema,
  refundPaymentSchema,
  upsertCompanyPaymentSettingSchema,
  upsertProviderConfigSchema,
} from "../shared/validation";
import { PaymentProvider } from "@prisma/client";

function sendError(reply: any, error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "Validation failed", issues: error.flatten() });
  }
  const candidate = error as { status?: number; statusCode?: number; message?: string };
  return reply
    .code(candidate?.statusCode ?? candidate?.status ?? 500)
    .send({ error: candidate?.message ?? fallback });
}

const paymentsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
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
        return sendError(reply, error, "Failed to load payment policy");
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
        return sendError(reply, error, "Failed to update payment policy");
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
        return sendError(reply, error, "Failed to load available payment providers");
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
        return sendError(reply, error, "Failed to load payment provider configs");
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
        return sendError(reply, error, "Failed to save payment provider config");
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
        return sendError(reply, error, "Failed to update payment provider config");
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
        return sendError(reply, error, "Failed to validate payment provider config");
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
      return sendError(reply, error, "Failed to process webhook");
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

    stripeWebhookScope.post("/payments/stripe/callback", async (request, reply) =>
      handleWebhookByProvider(PaymentProvider.STRIPE, request, reply),
    );
  });
};

export default paymentsFastifyRoutes;

