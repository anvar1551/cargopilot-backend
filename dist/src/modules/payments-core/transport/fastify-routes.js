"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const querystring_1 = require("querystring");
const fastify_auth_1 = require("../../../modules/identity-access/transport/fastify-auth");
const paymentsService_1 = require("../application/paymentsService");
const validation_1 = require("../shared/validation");
const client_1 = require("@prisma/client");
function sendError(reply, error, fallback) {
    if (error instanceof zod_1.ZodError) {
        return reply.code(400).send({ error: "Validation failed", issues: error.flatten() });
    }
    const candidate = error;
    return reply
        .code(candidate?.statusCode ?? candidate?.status ?? 500)
        .send({ error: candidate?.message ?? fallback });
}
const paymentsFastifyRoutes = async (fastify) => {
    fastify.get("/settings/payments/policy", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.providers.read" }) }, async (request, reply) => {
        try {
            const query = validation_1.listAvailableProvidersQuerySchema.parse(request.query ?? {});
            const result = await (0, paymentsService_1.getCompanyPaymentPolicyForActor)({
                user: request.user,
                companyId: query.companyId,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to load payment policy");
        }
    });
    fastify.put("/settings/payments/policy", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.providers.manage" }) }, async (request, reply) => {
        try {
            const body = validation_1.upsertCompanyPaymentSettingSchema.parse(request.body ?? {});
            const result = await (0, paymentsService_1.upsertCompanyPaymentPolicyForActor)({
                user: request.user,
                ...body,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update payment policy");
        }
    });
    fastify.get("/payments/providers/available", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.intents.create" }) }, async (request, reply) => {
        try {
            const query = validation_1.listAvailableProvidersQuerySchema.parse(request.query ?? {});
            const result = await (0, paymentsService_1.listAvailableProvidersForActor)({
                user: request.user,
                companyId: query.companyId,
                environment: query.environment,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to load available payment providers");
        }
    });
    fastify.get("/settings/payments/providers", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.providers.read" }) }, async (request, reply) => {
        try {
            const query = validation_1.listProviderConfigsQuerySchema.parse(request.query ?? {});
            const result = await (0, paymentsService_1.listProviderConfigsForActor)({
                user: request.user,
                companyId: query.companyId,
                provider: query.provider,
                environment: query.environment,
                enabledOnly: query.enabledOnly,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to load payment provider configs");
        }
    });
    fastify.post("/settings/payments/providers", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.providers.manage" }) }, async (request, reply) => {
        try {
            const body = validation_1.upsertProviderConfigSchema.parse(request.body);
            const result = await (0, paymentsService_1.upsertProviderConfigForActor)({
                user: request.user,
                ...body,
            });
            return reply.code(201).send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to save payment provider config");
        }
    });
    fastify.patch("/settings/payments/providers/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.providers.manage" }) }, async (request, reply) => {
        try {
            const params = validation_1.providerConfigIdParamsSchema.parse(request.params);
            const body = validation_1.patchProviderConfigSchema.parse(request.body ?? {});
            const result = await (0, paymentsService_1.patchProviderConfigForActor)({
                user: request.user,
                id: params.id,
                ...body,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to update payment provider config");
        }
    });
    fastify.post("/settings/payments/providers/:id/test", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.providers.manage" }) }, async (request, reply) => {
        try {
            const params = validation_1.providerConfigIdParamsSchema.parse(request.params);
            const result = await (0, paymentsService_1.testProviderConfigForActor)({ user: request.user, id: params.id });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to validate payment provider config");
        }
    });
    fastify.post("/payments/intents", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.intents.create" }) }, async (request, reply) => {
        try {
            const body = validation_1.createPaymentIntentSchema.parse(request.body);
            const result = await (0, paymentsService_1.createPaymentIntentForActor)({ user: request.user, input: body });
            return reply.code(201).send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to create payment intent");
        }
    });
    fastify.get("/payments/intents/:id", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.intents.read" }) }, async (request, reply) => {
        try {
            const params = validation_1.paymentIntentIdParamsSchema.parse(request.params);
            const result = await (0, paymentsService_1.getPaymentIntentForActor)({ user: request.user, id: params.id });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to load payment intent");
        }
    });
    fastify.get("/orders/:orderId/payment/intents", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.intents.read" }) }, async (request, reply) => {
        try {
            const params = validation_1.paymentOrderIdParamsSchema.parse(request.params);
            const result = await (0, paymentsService_1.listOrderPaymentIntentsForActor)({
                user: request.user,
                orderId: params.orderId,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to load order payment intents");
        }
    });
    fastify.post("/payments/intents/:id/sync", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.intents.read" }) }, async (request, reply) => {
        try {
            const params = validation_1.paymentIntentIdParamsSchema.parse(request.params);
            const result = await (0, paymentsService_1.syncPaymentIntentForActor)({
                user: request.user,
                id: params.id,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to sync payment intent");
        }
    });
    fastify.post("/orders/:orderId/payment/retry", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "payments.intents.create" }) }, async (request, reply) => {
        try {
            const params = validation_1.paymentOrderIdParamsSchema.parse(request.params);
            const body = validation_1.retryOrderPaymentSchema.parse(request.body ?? {});
            const result = await (0, paymentsService_1.retryOrderPaymentForActor)({
                user: request.user,
                orderId: params.orderId,
                provider: body.provider,
            });
            return reply.code(201).send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to retry order payment");
        }
    });
    fastify.post("/payments/intents/:id/refund", { preHandler: (0, fastify_auth_1.fastifyAuth)({ permission: "finance.refund" }) }, async (request, reply) => {
        try {
            const params = validation_1.paymentIntentIdParamsSchema.parse(request.params);
            const body = validation_1.refundPaymentSchema.parse(request.body);
            const result = await (0, paymentsService_1.createRefundForActor)({
                user: request.user,
                paymentIntentId: params.id,
                ...body,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to create refund");
        }
    });
    function parseWebhookBody(raw) {
        if (!raw)
            return {};
        if (typeof raw === "string") {
            if (raw.trim().startsWith("{")) {
                try {
                    return JSON.parse(raw);
                }
                catch {
                    return {};
                }
            }
            return (0, querystring_1.parse)(raw);
        }
        if (typeof raw === "object")
            return raw;
        return {};
    }
    async function handleWebhookByProvider(provider, request, reply) {
        try {
            const rawBody = typeof request.body === "string" || Buffer.isBuffer(request.body)
                ? request.body
                : undefined;
            const parsedBody = parseWebhookBody(Buffer.isBuffer(request.body) ? request.body.toString("utf8") : request.body ?? {});
            const body = provider === client_1.PaymentProvider.CLICK ||
                provider === client_1.PaymentProvider.PAYME ||
                provider === client_1.PaymentProvider.UZUM ||
                provider === client_1.PaymentProvider.STRIPE
                ? parsedBody
                : validation_1.paymentWebhookSchema.parse(parsedBody);
            const result = await (0, paymentsService_1.handleProviderWebhook)({
                provider,
                body,
                headers: request.headers ?? {},
                rawBody,
            });
            return reply.send(result);
        }
        catch (error) {
            return sendError(reply, error, "Failed to process webhook");
        }
    }
    fastify.post("/payments/click/callback", async (request, reply) => handleWebhookByProvider(client_1.PaymentProvider.CLICK, request, reply));
    fastify.post("/payments/payme/callback", async (request, reply) => handleWebhookByProvider(client_1.PaymentProvider.PAYME, request, reply));
    fastify.post("/payments/uzum/callback", async (request, reply) => handleWebhookByProvider(client_1.PaymentProvider.UZUM, request, reply));
    await fastify.register(async (stripeWebhookScope) => {
        stripeWebhookScope.removeAllContentTypeParsers();
        stripeWebhookScope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
        stripeWebhookScope.post("/payments/stripe/callback", async (request, reply) => handleWebhookByProvider(client_1.PaymentProvider.STRIPE, request, reply));
    });
};
exports.default = paymentsFastifyRoutes;
