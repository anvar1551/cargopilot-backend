import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";
import { createWebhookGatewayService } from "../application/webhook-gateway.service";
import { providerWebhookVerifierResolver } from "../infrastructure/provider-webhook-verifier.resolver";
import { webhookEventRepository } from "../infrastructure/webhook-events.repo";
import { integrationCanonicalEventRepository } from "../infrastructure/canonical-event.repo";
import {
  listIntegrationOutboxAttemptsForActor,
  listIntegrationOutboxForActor,
  listIntegrationProvidersForActor,
  replayIntegrationOutboxForActor,
  retryIntegrationOutboxNowForActor,
  rotateIntegrationProviderSecretForActor,
  updateIntegrationProviderStatusForActor,
  upsertIntegrationProviderForActor,
} from "../application/integration-admin.service";
import { fastifyAuth } from "../../identity-access/transport/fastify-auth";

type WebhookRouteParams = {
  providerCode: string;
};

const integrationDomainValues = ["carrier", "sms", "payment", "webhook_sink"] as const;
const integrationProviderStatusValues = ["active", "paused", "disabled"] as const;
const integrationEnvironmentValues = ["sandbox", "production"] as const;
const integrationOutboxStatusValues = [
  "pending",
  "processing",
  "sent",
  "failed",
  "dead_letter",
] as const;

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const listProvidersQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  domain: z.enum(integrationDomainValues).optional(),
  status: z.enum(integrationProviderStatusValues).optional(),
  environment: z.enum(integrationEnvironmentValues).optional(),
  providerCode: z.string().trim().min(1).optional(),
});

const upsertProviderBodySchema = z.object({
  companyId: z.string().uuid(),
  domain: z.enum(integrationDomainValues),
  providerCode: z.string().trim().min(1),
  environment: z.enum(integrationEnvironmentValues),
  status: z.enum(integrationProviderStatusValues).optional(),
  capabilities: z.array(z.string().trim().min(1)).optional(),
  rateLimitRps: z.coerce.number().int().min(1).nullable().optional(),
  timeoutMs: z.coerce.number().int().min(100).max(120000).optional(),
  retryPolicyId: z.string().trim().min(1).nullable().optional(),
});

const updateProviderStatusBodySchema = z.object({
  status: z.enum(integrationProviderStatusValues),
});

const rotateProviderSecretBodySchema = z.object({
  secretPayload: z.union([z.string(), z.record(z.string(), z.unknown())]),
  keyVersion: z.coerce.number().int().min(1).optional(),
});

const listOutboxQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  status: z.enum(integrationOutboxStatusValues).optional(),
  domain: z.enum(integrationDomainValues).optional(),
  providerCode: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const listOutboxAttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function sendError(reply: any, error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Validation failed",
      issues: error.flatten(),
    });
  }
  const candidate = error as { statusCode?: number; status?: number; message?: string };
  return reply
    .code(candidate?.statusCode ?? candidate?.status ?? 500)
    .send({ error: candidate?.message ?? fallback });
}

function toOptionalHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    const first = value.find((item) => String(item || "").trim().length > 0);
    return first ? String(first).trim() : null;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

const integrationsFastifyRoutes: FastifyPluginAsync = async (fastify) => {
  const webhookGateway = createWebhookGatewayService({
    events: webhookEventRepository,
    providerVerifiers: providerWebhookVerifierResolver,
    canonicalEvents: integrationCanonicalEventRepository,
  });

  fastify.get("/health", async (_request, reply) =>
    reply.send({
      module: "integrations-core",
      status: "ok",
      gateway: "webhook",
    }),
  );

  fastify.get(
    "/providers",
    { preHandler: fastifyAuth({ permission: "integration.provider.read" }) },
    async (request, reply) => {
      try {
        const query = listProvidersQuerySchema.parse(request.query ?? {});
        const result = await listIntegrationProvidersForActor({
          user: request.user!,
          companyId: query.companyId,
          domain: query.domain,
          status: query.status,
          environment: query.environment,
          providerCode: query.providerCode,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to list integration providers");
      }
    },
  );

  fastify.post(
    "/providers",
    { preHandler: fastifyAuth({ permission: "integration.provider.manage" }) },
    async (request, reply) => {
      try {
        const body = upsertProviderBodySchema.parse(request.body ?? {});
        const result = await upsertIntegrationProviderForActor({
          user: request.user!,
          companyId: body.companyId,
          domain: body.domain,
          providerCode: body.providerCode,
          environment: body.environment,
          status: body.status,
          capabilities: body.capabilities,
          rateLimitRps: body.rateLimitRps,
          timeoutMs: body.timeoutMs,
          retryPolicyId: body.retryPolicyId ?? null,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to upsert integration provider");
      }
    },
  );

  fastify.patch(
    "/providers/:id/status",
    { preHandler: fastifyAuth({ permission: "integration.provider.manage" }) },
    async (request, reply) => {
      try {
        const params = idParamsSchema.parse(request.params ?? {});
        const body = updateProviderStatusBodySchema.parse(request.body ?? {});
        const result = await updateIntegrationProviderStatusForActor({
          user: request.user!,
          providerId: params.id,
          status: body.status,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to update provider status");
      }
    },
  );

  fastify.post(
    "/providers/:id/rotate-secret",
    { preHandler: fastifyAuth({ permission: "integration.provider.rotateSecret" }) },
    async (request, reply) => {
      try {
        const params = idParamsSchema.parse(request.params ?? {});
        const body = rotateProviderSecretBodySchema.parse(request.body ?? {});
        const result = await rotateIntegrationProviderSecretForActor({
          user: request.user!,
          providerId: params.id,
          secretPayload: body.secretPayload,
          keyVersion: body.keyVersion,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to rotate provider secret");
      }
    },
  );

  fastify.get(
    "/outbox",
    { preHandler: fastifyAuth({ permission: "integration.outbox.read" }) },
    async (request, reply) => {
      try {
        const query = listOutboxQuerySchema.parse(request.query ?? {});
        const result = await listIntegrationOutboxForActor({
          user: request.user!,
          companyId: query.companyId,
          status: query.status,
          domain: query.domain,
          providerCode: query.providerCode,
          page: query.page,
          limit: query.limit,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to list integration outbox");
      }
    },
  );

  fastify.get(
    "/outbox/:id/attempts",
    { preHandler: fastifyAuth({ permission: "integration.outbox.read" }) },
    async (request, reply) => {
      try {
        const params = idParamsSchema.parse(request.params ?? {});
        const query = listOutboxAttemptsQuerySchema.parse(request.query ?? {});
        const result = await listIntegrationOutboxAttemptsForActor({
          user: request.user!,
          outboxId: params.id,
          limit: query.limit,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to list outbox attempts");
      }
    },
  );

  fastify.post(
    "/outbox/:id/replay",
    { preHandler: fastifyAuth({ permission: "integration.outbox.replay" }) },
    async (request, reply) => {
      try {
        const params = idParamsSchema.parse(request.params ?? {});
        const result = await replayIntegrationOutboxForActor({
          user: request.user!,
          outboxId: params.id,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to replay outbox record");
      }
    },
  );

  fastify.post(
    "/outbox/:id/retry-now",
    { preHandler: fastifyAuth({ permission: "integration.outbox.replay" }) },
    async (request, reply) => {
      try {
        const params = idParamsSchema.parse(request.params ?? {});
        const result = await retryIntegrationOutboxNowForActor({
          user: request.user!,
          outboxId: params.id,
        });
        return reply.send(result);
      } catch (error) {
        return sendError(reply, error, "Failed to retry outbox record");
      }
    },
  );

  await fastify.register(async (webhookScope) => {
    webhookScope.removeAllContentTypeParsers();
    webhookScope.addContentTypeParser(
      "*",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );

    webhookScope.post<{ Params: WebhookRouteParams }>(
      "/webhooks/:providerCode",
      async (request, reply) => {
        const providerCode = String(request.params?.providerCode || "").trim();
        if (!providerCode) {
          return reply.code(400).send({
            status: "rejected",
            message: "providerCode is required",
          });
        }

        const rawBody = typeof request.body === "string" ? request.body : "";
        const result = await webhookGateway.ingest({
          providerCode,
          rawBody,
          headers: request.headers as Record<string, string | string[] | undefined>,
          ipAddress: request.ip,
          userAgent: toOptionalHeaderValue(request.headers["user-agent"]),
          companyHintId: toOptionalHeaderValue(request.headers["x-company-id"]),
        });

        if (result.status === "accepted") {
          return reply.code(202).send({
            status: "accepted",
            eventId: result.eventId,
          });
        }

        if (result.status === "duplicate") {
          return reply.code(200).send({
            status: "duplicate",
            eventId: result.eventId,
          });
        }

        return reply.code(400).send({
          status: "rejected",
          message: result.message ?? "Webhook rejected",
        });
      },
    );
  });
};

export default integrationsFastifyRoutes;
