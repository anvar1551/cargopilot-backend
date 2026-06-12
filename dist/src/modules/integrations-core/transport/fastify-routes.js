"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const webhook_gateway_service_1 = require("../application/webhook-gateway.service");
const provider_webhook_verifier_resolver_1 = require("../infrastructure/provider-webhook-verifier.resolver");
const webhook_events_repo_1 = require("../infrastructure/webhook-events.repo");
const canonical_event_repo_1 = require("../infrastructure/canonical-event.repo");
const integration_admin_service_1 = require("../application/integration-admin.service");
const carrier_routing_service_1 = require("../application/carrier-routing.service");
const route_template_service_1 = require("../application/route-template.service");
const fastify_auth_1 = require("../../identity-access/transport/fastify-auth");
const integrationDomainValues = ["carrier", "sms", "payment", "webhook_sink"];
const integrationProviderStatusValues = ["active", "paused", "disabled"];
const integrationEnvironmentValues = ["sandbox", "production"];
const integrationOutboxStatusValues = [
    "pending",
    "processing",
    "sent",
    "failed",
    "dead_letter",
];
const integrationEventProcessStatusValues = [
    "pending",
    "processing",
    "processed",
    "failed",
    "ignored",
];
const idParamsSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
});
const listProvidersQuerySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    domain: zod_1.z.enum(integrationDomainValues).optional(),
    status: zod_1.z.enum(integrationProviderStatusValues).optional(),
    environment: zod_1.z.enum(integrationEnvironmentValues).optional(),
    providerCode: zod_1.z.string().trim().min(1).optional(),
    q: zod_1.z.string().trim().optional(),
    cursor: zod_1.z.string().uuid().optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
const upsertProviderBodySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid(),
    domain: zod_1.z.enum(integrationDomainValues),
    providerCode: zod_1.z.string().trim().min(1),
    environment: zod_1.z.enum(integrationEnvironmentValues),
    status: zod_1.z.enum(integrationProviderStatusValues).optional(),
    capabilities: zod_1.z.array(zod_1.z.string().trim().min(1)).optional(),
    rateLimitRps: zod_1.z.coerce.number().int().min(1).nullable().optional(),
    timeoutMs: zod_1.z.coerce.number().int().min(100).max(120000).optional(),
    retryPolicyId: zod_1.z.string().trim().min(1).nullable().optional(),
});
const updateProviderStatusBodySchema = zod_1.z.object({
    status: zod_1.z.enum(integrationProviderStatusValues),
});
const rotateProviderSecretBodySchema = zod_1.z.object({
    secretPayload: zod_1.z.union([zod_1.z.string(), zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())]),
    keyVersion: zod_1.z.coerce.number().int().min(1).optional(),
});
const listOutboxQuerySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    status: zod_1.z.enum(integrationOutboxStatusValues).optional(),
    domain: zod_1.z.enum(integrationDomainValues).optional(),
    providerCode: zod_1.z.string().trim().min(1).optional(),
    page: zod_1.z.coerce.number().int().min(1).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
const listOutboxAttemptsQuerySchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(200).optional(),
});
const listWebhookEventsQuerySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    domain: zod_1.z.enum(integrationDomainValues).optional(),
    providerCode: zod_1.z.string().trim().min(1).optional(),
    q: zod_1.z.string().trim().optional(),
    page: zod_1.z.coerce.number().int().min(1).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
const listCanonicalEventsQuerySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    status: zod_1.z.enum(integrationEventProcessStatusValues).optional(),
    domain: zod_1.z.enum(integrationDomainValues).optional(),
    providerCode: zod_1.z.string().trim().min(1).optional(),
    q: zod_1.z.string().trim().optional(),
    page: zod_1.z.coerce.number().int().min(1).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
const booleanishSchema = zod_1.z.preprocess((value) => {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized))
            return true;
        if (["false", "0", "no", "off"].includes(normalized))
            return false;
    }
    return value;
}, zod_1.z.boolean());
const listCarrierRoutingRulesQuerySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    providerId: zod_1.z.string().uuid().optional(),
    routeTemplateId: zod_1.z.string().uuid().optional(),
    isActive: booleanishSchema.optional(),
    q: zod_1.z.string().trim().optional(),
    cursor: zod_1.z.string().uuid().optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
const routeTemplateLegBodySchema = zod_1.z.object({
    id: zod_1.z.string().uuid().optional(),
    sequence: zod_1.z.coerce.number().int().min(1),
    legCode: zod_1.z.string().trim().min(1).max(64),
    label: zod_1.z.string().trim().max(160).nullable().optional(),
    mode: zod_1.z.enum(Object.values(client_1.TransportMode)),
    originCountryCode: zod_1.z.string().trim().max(2).nullable().optional(),
    destinationCountryCode: zod_1.z.string().trim().max(2).nullable().optional(),
    metadata: zod_1.z.unknown().optional(),
});
const listRouteTemplatesQuerySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid().optional(),
    isActive: booleanishSchema.optional(),
    q: zod_1.z.string().trim().optional(),
    cursor: zod_1.z.string().uuid().optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
});
const routeTemplateBodySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid(),
    name: zod_1.z.string().trim().min(1).max(180),
    code: zod_1.z.string().trim().max(64).nullable().optional(),
    isActive: booleanishSchema.optional(),
    priority: zod_1.z.coerce.number().int().optional(),
    serviceType: zod_1.z.enum(Object.values(client_1.ServiceType)).nullable().optional(),
    transportMode: zod_1.z.enum(Object.values(client_1.TransportMode)).nullable().optional(),
    originCountryCode: zod_1.z.string().trim().max(2).nullable().optional(),
    destinationCountryCode: zod_1.z.string().trim().max(2).nullable().optional(),
    metadata: zod_1.z.unknown().optional(),
    legs: zod_1.z.array(routeTemplateLegBodySchema).min(1).max(50),
});
const updateRouteTemplateBodySchema = routeTemplateBodySchema.partial().omit({
    companyId: true,
});
const carrierRoutingRuleBodySchema = zod_1.z.object({
    companyId: zod_1.z.string().uuid(),
    name: zod_1.z.string().trim().min(1).max(180),
    code: zod_1.z.string().trim().max(64).nullable().optional(),
    providerId: zod_1.z.string().uuid(),
    fallbackProviderId: zod_1.z.string().uuid().nullable().optional(),
    routeTemplateId: zod_1.z.string().uuid().nullable().optional(),
    routeTemplateLegId: zod_1.z.string().uuid().nullable().optional(),
    isActive: booleanishSchema.optional(),
    priority: zod_1.z.coerce.number().int().optional(),
    autoBook: booleanishSchema.optional(),
    serviceType: zod_1.z.enum(Object.values(client_1.ServiceType)).nullable().optional(),
    transportMode: zod_1.z.enum(Object.values(client_1.TransportMode)).nullable().optional(),
    originCountryCode: zod_1.z.string().trim().max(2).nullable().optional(),
    destinationCountryCode: zod_1.z.string().trim().max(2).nullable().optional(),
    minWeightKg: zod_1.z.coerce.number().min(0).nullable().optional(),
    maxWeightKg: zod_1.z.coerce.number().gt(0).nullable().optional(),
    legSequence: zod_1.z.coerce.number().int().min(1).nullable().optional(),
    conditionsJson: zod_1.z.unknown().optional(),
});
const updateCarrierRoutingRuleBodySchema = carrierRoutingRuleBodySchema.partial().omit({
    companyId: true,
});
function sendError(reply, error, fallback) {
    if (error instanceof zod_1.ZodError) {
        return reply.code(400).send({
            error: "Validation failed",
            issues: error.flatten(),
        });
    }
    const candidate = error;
    return reply
        .code(candidate?.statusCode ?? candidate?.status ?? 500)
        .send({ error: candidate?.message ?? fallback });
}
function toOptionalHeaderValue(value) {
    if (Array.isArray(value)) {
        const first = value.find((item) => String(item || "").trim().length > 0);
        return first ? String(first).trim() : null;
    }
    if (typeof value === "string" && value.trim())
        return value.trim();
    return null;
}
const integrationsFastifyRoutes = async (fastify) => {
    const webhookGateway = (0, webhook_gateway_service_1.createWebhookGatewayService)({
        events: webhook_events_repo_1.webhookEventRepository,
        providerVerifiers: provider_webhook_verifier_resolver_1.providerWebhookVerifierResolver,
        canonicalEvents: canonical_event_repo_1.integrationCanonicalEventRepository,
    });
    fastify.get("/health", async (_request, reply) => reply.send({
        module: "integrations-core",
        status: "ok",
        gateway: "webhook",
    }));
    fastify.get("/providers", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.provider.read" }) }, async (request, reply) => {
        try {
            const query = listProvidersQuerySchema.parse(request.query ?? {});
            const result = await (0, integration_admin_service_1.listIntegrationProvidersForActor)({
                user: request.user,
                companyId: query.companyId,
                domain: query.domain,
                status: query.status,
                environment: query.environment,
                providerCode: query.providerCode,
                q: query.q,
                cursor: query.cursor,
                limit: query.limit,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to list integration providers");
        }
    });
    fastify.post("/providers", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.provider.manage" }) }, async (request, reply) => {
        try {
            const body = upsertProviderBodySchema.parse(request.body ?? {});
            const result = await (0, integration_admin_service_1.upsertIntegrationProviderForActor)({
                user: request.user,
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
        }
        catch (error) {
            return sendError(reply, error, "Failed to upsert integration provider");
        }
    });
    fastify.patch("/providers/:id/status", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.provider.manage" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const body = updateProviderStatusBodySchema.parse(request.body ?? {});
            const result = await (0, integration_admin_service_1.updateIntegrationProviderStatusForActor)({
                user: request.user,
                providerId: params.id,
                status: body.status,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update provider status");
        }
    });
    fastify.delete("/providers/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.provider.manage" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const result = await (0, integration_admin_service_1.deleteIntegrationProviderForActor)({
                user: request.user,
                providerId: params.id,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to delete integration provider");
        }
    });
    fastify.post("/providers/:id/rotate-secret", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.provider.rotateSecret" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const body = rotateProviderSecretBodySchema.parse(request.body ?? {});
            const result = await (0, integration_admin_service_1.rotateIntegrationProviderSecretForActor)({
                user: request.user,
                providerId: params.id,
                secretPayload: body.secretPayload,
                keyVersion: body.keyVersion,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to rotate provider secret");
        }
    });
    fastify.get("/route-templates", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.read" }) }, async (request, reply) => {
        try {
            const query = listRouteTemplatesQuerySchema.parse(request.query ?? {});
            const result = await (0, route_template_service_1.listRouteTemplatesForActor)({
                user: request.user,
                filters: query,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to list route templates");
        }
    });
    fastify.get("/route-templates/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.read" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const result = await (0, route_template_service_1.getRouteTemplateForActor)({
                user: request.user,
                routeTemplateId: params.id,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to fetch route template");
        }
    });
    fastify.post("/route-templates", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.manage" }) }, async (request, reply) => {
        try {
            const body = routeTemplateBodySchema.parse(request.body ?? {});
            const result = await (0, route_template_service_1.createRouteTemplateForActor)({
                user: request.user,
                input: body,
            });
            return reply.code(201).send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to create route template");
        }
    });
    fastify.patch("/route-templates/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.manage" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const body = updateRouteTemplateBodySchema.parse(request.body ?? {});
            const result = await (0, route_template_service_1.updateRouteTemplateForActor)({
                user: request.user,
                routeTemplateId: params.id,
                input: body,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update route template");
        }
    });
    fastify.delete("/route-templates/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.manage" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const result = await (0, route_template_service_1.deleteRouteTemplateForActor)({
                user: request.user,
                routeTemplateId: params.id,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to delete route template");
        }
    });
    fastify.get("/carrier-routing-rules", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.read" }) }, async (request, reply) => {
        try {
            const query = listCarrierRoutingRulesQuerySchema.parse(request.query ?? {});
            const result = await (0, carrier_routing_service_1.listCarrierRoutingRulesForActor)({
                user: request.user,
                filters: query,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to list carrier routing rules");
        }
    });
    fastify.post("/carrier-routing-rules", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.manage" }) }, async (request, reply) => {
        try {
            const body = carrierRoutingRuleBodySchema.parse(request.body ?? {});
            const result = await (0, carrier_routing_service_1.createCarrierRoutingRuleForActor)({
                user: request.user,
                input: body,
            });
            return reply.code(201).send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to create carrier routing rule");
        }
    });
    fastify.patch("/carrier-routing-rules/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.manage" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const body = updateCarrierRoutingRuleBodySchema.parse(request.body ?? {});
            const result = await (0, carrier_routing_service_1.updateCarrierRoutingRuleForActor)({
                user: request.user,
                ruleId: params.id,
                input: body,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update carrier routing rule");
        }
    });
    fastify.delete("/carrier-routing-rules/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.routing.manage" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const result = await (0, carrier_routing_service_1.deleteCarrierRoutingRuleForActor)({
                user: request.user,
                ruleId: params.id,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to delete carrier routing rule");
        }
    });
    fastify.get("/outbox", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.outbox.read" }) }, async (request, reply) => {
        try {
            const query = listOutboxQuerySchema.parse(request.query ?? {});
            const result = await (0, integration_admin_service_1.listIntegrationOutboxForActor)({
                user: request.user,
                companyId: query.companyId,
                status: query.status,
                domain: query.domain,
                providerCode: query.providerCode,
                page: query.page,
                limit: query.limit,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to list integration outbox");
        }
    });
    fastify.get("/outbox/:id/attempts", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.outbox.read" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const query = listOutboxAttemptsQuerySchema.parse(request.query ?? {});
            const result = await (0, integration_admin_service_1.listIntegrationOutboxAttemptsForActor)({
                user: request.user,
                outboxId: params.id,
                limit: query.limit,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to list outbox attempts");
        }
    });
    fastify.get("/webhook-events", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.outbox.read" }) }, async (request, reply) => {
        try {
            const query = listWebhookEventsQuerySchema.parse(request.query ?? {});
            const result = await (0, integration_admin_service_1.listIntegrationWebhookEventsForActor)({
                user: request.user,
                companyId: query.companyId,
                domain: query.domain,
                providerCode: query.providerCode,
                q: query.q,
                page: query.page,
                limit: query.limit,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to list webhook events");
        }
    });
    fastify.get("/canonical-events", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.outbox.read" }) }, async (request, reply) => {
        try {
            const query = listCanonicalEventsQuerySchema.parse(request.query ?? {});
            const result = await (0, integration_admin_service_1.listIntegrationCanonicalEventsForActor)({
                user: request.user,
                companyId: query.companyId,
                status: query.status,
                domain: query.domain,
                providerCode: query.providerCode,
                q: query.q,
                page: query.page,
                limit: query.limit,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to list canonical events");
        }
    });
    fastify.post("/outbox/:id/replay", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.outbox.replay" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const result = await (0, integration_admin_service_1.replayIntegrationOutboxForActor)({
                user: request.user,
                outboxId: params.id,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to replay outbox record");
        }
    });
    fastify.post("/outbox/:id/retry-now", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "integration.outbox.replay" }) }, async (request, reply) => {
        try {
            const params = idParamsSchema.parse(request.params ?? {});
            const result = await (0, integration_admin_service_1.retryIntegrationOutboxNowForActor)({
                user: request.user,
                outboxId: params.id,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to retry outbox record");
        }
    });
    await fastify.register(async (webhookScope) => {
        webhookScope.removeAllContentTypeParsers();
        webhookScope.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));
        webhookScope.post("/webhooks/:providerCode", async (request, reply) => {
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
                headers: request.headers,
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
        });
    });
};
exports.default = integrationsFastifyRoutes;
